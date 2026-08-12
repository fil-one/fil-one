import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteItemCommand,
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Region } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    RagIndexerTable: { name: 'RagIndexerTable' },
    RagVectorBucket: { name: 'rag-vectors' },
  },
}));

const mockDropIndex = vi.fn(async () => undefined);
vi.mock('@filone/rag-shared', () => ({
  S3VectorsStore: class {
    dropIndex = (...args: unknown[]) => mockDropIndex(...(args as []));
  },
}));

const mockLoadManifest = vi.fn(async () => new Map<string, unknown>());
const mockDeleteManifestEntry = vi.fn(async () => undefined);
const mockClearCheckpoint = vi.fn(async () => undefined);
vi.mock('../jobs/rag-indexer-manifest.js', () => ({
  loadManifest: () => mockLoadManifest(),
  deleteManifestEntry: (...args: unknown[]) => mockDeleteManifestEntry(...(args as [])),
  clearCheckpoint: (...args: unknown[]) => mockClearCheckpoint(...(args as [])),
}));

const ddbMock = mockClient(DynamoDBClient);

import { purgeOrgRecords } from './deletion-purge.js';
import { DELETION_STATUS, type DeletionRecord } from './deletion-record.js';

const ORG = 'org-1';

const RECORD: DeletionRecord = {
  status: DELETION_STATUS.pending,
  requestedAt: '2026-08-12T10:00:00.000Z',
  requestedByUserId: 'user-1',
  members: [{ userId: 'user-1', sub: 'auth0|one' }],
  tenantIds: { aurora: 'aurora-t-1' },
  attempts: 1,
  updatedAt: '2026-08-12T10:00:00.000Z',
};

/** Every key passed to DeleteItem, in call order, as `table:pk/sk`. */
function deletedKeys(): string[] {
  return ddbMock.commandCalls(DeleteItemCommand).map((call) => {
    const { TableName, Key } = call.args[0].input;
    return `${TableName}:${Key!.pk!.S}/${Key!.sk!.S}`;
  });
}

function orgRow(sk: string, extra: Record<string, unknown> = {}) {
  return marshall({ pk: `ORG#${ORG}`, sk, ...extra });
}

/** No rows anywhere unless a test says otherwise. */
function stubEmpty() {
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  ddbMock.on(DeleteItemCommand).resolves({});
  ddbMock.on(UpdateItemCommand).resolves({});
}

describe('purgeOrgRecords', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockLoadManifest.mockResolvedValue(new Map());
    stubEmpty();
  });

  it('keeps the erasure receipt and deletes the org profile last', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        orgRow('DELETION'),
        orgRow('PROFILE'),
        orgRow('MEMBER#user-1'),
        orgRow('ACCESSKEY#ak-1'),
      ],
    });

    await purgeOrgRecords(ORG, RECORD);

    const keys = deletedKeys();
    expect(keys).not.toContain(`UserInfoTable:ORG#${ORG}/DELETION`);
    expect(keys).toContain(`UserInfoTable:ORG#${ORG}/MEMBER#user-1`);
    expect(keys).toContain(`UserInfoTable:ORG#${ORG}/ACCESSKEY#ak-1`);
    // The profile holds the tenant ids and the `deleting` fence a resumed pass
    // would need, so it can only go once everything else is gone.
    expect(keys.at(-1)).toBe(`UserInfoTable:ORG#${ORG}/PROFILE`);
  });

  // A lookup pk derives from the tokenHash on the RAGKEY# row, so deleting the
  // partition first would leave rows nothing can ever find again.
  it('deletes RAG key lookup rows before the partition that names them', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [orgRow('RAGKEY#key-1', { tokenHash: 'hash-1' }), orgRow('MEMBER#user-1')],
    });

    await purgeOrgRecords(ORG, RECORD);

    const keys = deletedKeys();
    const lookup = keys.indexOf('UserInfoTable:RAGKEYHASH#hash-1/LOOKUP');
    const ragKey = keys.indexOf(`UserInfoTable:ORG#${ORG}/RAGKEY#key-1`);
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeLessThan(ragKey);
  });

  it('tombstones the identity row instead of deleting it', async () => {
    await purgeOrgRecords(ORG, RECORD);

    expect(deletedKeys()).not.toContain('UserInfoTable:SUB#auth0|one/IDENTITY');

    const update = ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input;
    expect(update.Key).toEqual(marshall({ pk: 'SUB#auth0|one', sk: 'IDENTITY' }));
    expect(update.UpdateExpression).toBe(
      'SET deleted = :true, deletedAt = if_not_exists(deletedAt, :now) ' +
        'REMOVE userId, orgId, emailEntitlementClaimed, createdAt',
    );
  });

  it('deletes each member profile and billing row', async () => {
    const record = {
      ...RECORD,
      members: [
        { userId: 'user-1', sub: 'auth0|one' },
        { userId: 'user-2', sub: 'auth0|two' },
      ],
    };

    await purgeOrgRecords(ORG, record);

    const keys = deletedKeys();
    expect(keys).toContain('UserInfoTable:USER#user-1/PROFILE');
    expect(keys).toContain('UserInfoTable:USER#user-2/PROFILE');
    expect(keys).toContain('BillingTable:CUSTOMER#user-1/SUBSCRIPTION');
    expect(keys).toContain('BillingTable:CUSTOMER#user-2/SUBSCRIPTION');
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(2);
  });

  it('deletes the daily usage audit rows', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'BillingTable' })
      .resolves({ Items: [marshall({ pk: `ORG#${ORG}`, sk: 'USAGE_REPORT#2026-08-01' })] });

    await purgeOrgRecords(ORG, RECORD);

    expect(deletedKeys()).toContain(`BillingTable:ORG#${ORG}/USAGE_REPORT#2026-08-01`);
  });

  describe('RAG state', () => {
    const BUCKET_PK = `BUCKET#${ORG}#${S3Region.EuWest1}#docs`;

    it('purges manifests, the enablement row, the checkpoint and the vector index', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [marshall({ pk: BUCKET_PK })] });
      mockLoadManifest.mockResolvedValue(new Map([['reports/q1.pdf', {}]]));

      await purgeOrgRecords(ORG, RECORD);

      expect(mockDeleteManifestEntry).toHaveBeenCalledWith(
        ORG,
        S3Region.EuWest1,
        'docs',
        'reports/q1.pdf',
      );
      expect(deletedKeys()).toContain(`RagIndexerTable:${BUCKET_PK}/RAG`);
      expect(mockClearCheckpoint).toHaveBeenCalledWith(ORG, S3Region.EuWest1, 'docs');
      expect(mockDropIndex).toHaveBeenCalledWith(ORG, S3Region.EuWest1, 'docs');
    });

    // The sk is rebuilt by the same builder that wrote it, so a '#' in the key
    // cannot be mangled by a split.
    it('handles an objectKey containing the key delimiter', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [marshall({ pk: BUCKET_PK })] });
      mockLoadManifest.mockResolvedValue(new Map([['odd#name#2.pdf', {}]]));

      await purgeOrgRecords(ORG, RECORD);

      expect(mockDeleteManifestEntry).toHaveBeenCalledWith(
        ORG,
        S3Region.EuWest1,
        'docs',
        'odd#name#2.pdf',
      );
    });

    it('purges a bucket known only from its checkpoint row, exactly once', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          marshall({ pk: BUCKET_PK }),
          marshall({ pk: `INDEXER_CHECKPOINT#${ORG}#${S3Region.EuWest1}#docs` }),
        ],
      });

      await purgeOrgRecords(ORG, RECORD);

      expect(mockDropIndex).toHaveBeenCalledTimes(1);
      expect(mockClearCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('scans only this org, for both pk shapes', async () => {
      await purgeOrgRecords(ORG, RECORD);

      const scan = ddbMock.commandCalls(ScanCommand)[0]!.args[0].input;
      expect(scan.FilterExpression).toBe(
        'begins_with(pk, :bucket) OR begins_with(pk, :checkpoint)',
      );
      expect(scan.ExpressionAttributeValues).toEqual(
        marshall({ ':bucket': `BUCKET#${ORG}#`, ':checkpoint': `INDEXER_CHECKPOINT#${ORG}#` }),
      );
    });
  });

  it('pages the org partition, threading the cursor back through', async () => {
    const cursor = marshall({ pk: `ORG#${ORG}`, sk: 'ACCESSKEY#ak-1' });
    ddbMock
      .on(QueryCommand, { TableName: 'UserInfoTable' })
      .resolvesOnce({ Items: [orgRow('ACCESSKEY#ak-1')], LastEvaluatedKey: cursor })
      .resolves({ Items: [orgRow('ACCESSKEY#ak-2')] });

    await purgeOrgRecords(ORG, RECORD);

    const queries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.TableName === 'UserInfoTable');
    expect(queries).toHaveLength(2);
    expect(queries[1]!.args[0].input.ExclusiveStartKey).toEqual(cursor);
    expect(deletedKeys()).toContain(`UserInfoTable:ORG#${ORG}/ACCESSKEY#ak-2`);
  });

  // What a re-drive after a completed purge looks like: the partition is empty
  // apart from the receipt, and nothing throws.
  it('is a clean no-op on a second pass', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'UserInfoTable' })
      .resolves({ Items: [orgRow('DELETION')] });

    await expect(purgeOrgRecords(ORG, RECORD)).resolves.toBeUndefined();

    expect(deletedKeys()).toEqual([
      'BillingTable:CUSTOMER#user-1/SUBSCRIPTION',
      'UserInfoTable:USER#user-1/PROFILE',
      `UserInfoTable:ORG#${ORG}/PROFILE`,
    ]);
  });
});
