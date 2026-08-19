import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
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

import { scrubOrgRecords } from './deletion-scrub.js';
import type { DeletionMember } from './deletion-record.js';

const ORG = 'org-1';
const MEMBERS: DeletionMember[] = [{ userId: 'user-1', sub: 'auth0|one' }];

/** Every key passed to DeleteItem, in call order, as `table:pk/sk`. */
function deletedKeys(): string[] {
  return ddbMock.commandCalls(DeleteItemCommand).map((call) => {
    const { TableName, Key } = call.args[0].input;
    return `${TableName}:${Key!.pk!.S}/${Key!.sk!.S}`;
  });
}

function updateKey(input: { TableName?: string; Key?: Record<string, { S?: string }> }): string {
  return `${input.TableName}:${input.Key!.pk!.S}/${input.Key!.sk!.S}`;
}

/** Every key passed to UpdateItem, in call order, as `table:pk/sk`. */
function scrubbedKeys(): string[] {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => updateKey(call.args[0].input));
}

/** The scrub of one row, addressed the same way scrubbedKeys reports it. */
function scrubOf(key: string) {
  return ddbMock.commandCalls(UpdateItemCommand).find((c) => updateKey(c.args[0].input) === key)!
    .args[0].input;
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

describe('scrubOrgRecords', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockLoadManifest.mockResolvedValue(new Map());
    stubEmpty();
  });

  it('destroys credentials and keeps every row that describes the org', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        orgRow('DELETION'),
        orgRow('PROFILE'),
        orgRow('MEMBER#user-1'),
        orgRow('ACCESSKEY#ak-1'),
        orgRow('RAGKEY#key-1', { tokenHash: 'hash-1' }),
      ],
    });

    await scrubOrgRecords(ORG, MEMBERS);

    expect(deletedKeys()).toEqual([
      'UserInfoTable:RAGKEYHASH#hash-1/LOOKUP',
      `UserInfoTable:ORG#${ORG}/ACCESSKEY#ak-1`,
      `UserInfoTable:ORG#${ORG}/RAGKEY#key-1`,
    ]);
    const kept = scrubbedKeys();
    expect(kept).toContain(`UserInfoTable:ORG#${ORG}/MEMBER#user-1`);
    // Last: it holds the tenant ids a resumed pass reads.
    expect(kept.at(-1)).toBe(`UserInfoTable:ORG#${ORG}/PROFILE`);
  });

  it('strips the name off the org profile and leaves the fence up', async () => {
    await scrubOrgRecords(ORG, MEMBERS);

    const update = scrubOf(`UserInfoTable:ORG#${ORG}/PROFILE`);
    expect(update.UpdateExpression).toBe(
      'SET deletedAt = if_not_exists(deletedAt, :now) REMOVE #name',
    );
    expect(update.ExpressionAttributeNames).toEqual({ '#name': 'name' });
    expect(update.ConditionExpression).toBe('attribute_exists(pk)');
  });

  // A lookup pk derives from the tokenHash on the RAGKEY# row, so deleting the
  // partition first would leave rows nothing can ever find again.
  it('deletes RAG key lookup rows before the partition that names them', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [orgRow('RAGKEY#key-1', { tokenHash: 'hash-1' }), orgRow('MEMBER#user-1')],
    });

    await scrubOrgRecords(ORG, MEMBERS);

    const keys = deletedKeys();
    const lookup = keys.indexOf('UserInfoTable:RAGKEYHASH#hash-1/LOOKUP');
    const ragKey = keys.indexOf(`UserInfoTable:ORG#${ORG}/RAGKEY#key-1`);
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeLessThan(ragKey);
  });

  // Emptying the row would break auth: it branches on the row holding both ids,
  // and without them a live JWT takes the new-user path and mints a fresh org.
  it('stamps the identity row without touching userId or orgId', async () => {
    await scrubOrgRecords(ORG, MEMBERS);

    expect(scrubOf('UserInfoTable:SUB#auth0|one/IDENTITY').UpdateExpression).toBe(
      'SET deletedAt = if_not_exists(deletedAt, :now)',
    );
  });

  it('stamps every row that survives, and deletes none of them', async () => {
    await scrubOrgRecords(ORG, [
      { userId: 'user-1', sub: 'auth0|one' },
      { userId: 'user-2', sub: 'auth0|two' },
    ]);

    expect(scrubbedKeys()).toEqual([
      'BillingTable:CUSTOMER#user-1/SUBSCRIPTION',
      'BillingTable:CUSTOMER#user-2/SUBSCRIPTION',
      'UserInfoTable:SUB#auth0|one/IDENTITY',
      'UserInfoTable:USER#user-1/PROFILE',
      `UserInfoTable:ORG#${ORG}/MEMBER#user-1`,
      'UserInfoTable:SUB#auth0|two/IDENTITY',
      'UserInfoTable:USER#user-2/PROFILE',
      `UserInfoTable:ORG#${ORG}/MEMBER#user-2`,
      `UserInfoTable:ORG#${ORG}/PROFILE`,
    ]);
    expect(deletedKeys()).toEqual([]);
  });

  // The worker writes `canceled` itself, after the Stripe cancel has succeeded, so
  // the row and Stripe cannot disagree whatever order the webhooks arrive in.
  it('strips the card fields off the billing row and cancels it', async () => {
    await scrubOrgRecords(ORG, MEMBERS);

    const update = scrubOf('BillingTable:CUSTOMER#user-1/SUBSCRIPTION');
    expect(update.TableName).toBe('BillingTable');
    expect(update.UpdateExpression).toBe(
      'SET deletedAt = if_not_exists(deletedAt, :now), ' +
        'subscriptionStatus = :canceled, updatedAt = :now ' +
        'REMOVE paymentMethodId, paymentMethodLast4, paymentMethodBrand, ' +
        'paymentMethodExpMonth, paymentMethodExpYear, gracePeriodEndsAt',
    );
    expect(update.ExpressionAttributeValues![':canceled']).toEqual({ S: 'canceled' });
  });

  // A financial record with no personal data, on its own TTL.
  it('leaves the usage audit rows alone', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'BillingTable' })
      .resolves({ Items: [marshall({ pk: `ORG#${ORG}`, sk: 'USAGE_REPORT#2026-08-01' })] });

    await scrubOrgRecords(ORG, MEMBERS);

    expect(deletedKeys()).not.toContain(`BillingTable:ORG#${ORG}/USAGE_REPORT#2026-08-01`);
    expect(scrubbedKeys()).not.toContain(`BillingTable:ORG#${ORG}/USAGE_REPORT#2026-08-01`);
  });

  // A member who never onboarded has no billing row, and a bare UpdateItem would
  // upsert one holding nothing but a stamp.
  it('does not recreate a row that is not there', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ $metadata: {}, message: 'nope' }));

    await expect(scrubOrgRecords(ORG, MEMBERS)).resolves.toBeUndefined();
  });

  describe('RAG state', () => {
    const BUCKET_PK = `BUCKET#${ORG}#${S3Region.EuWest1}#docs`;

    it('purges manifests, the enablement row, the checkpoint and the vector index', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [marshall({ pk: BUCKET_PK })] });
      mockLoadManifest.mockResolvedValue(new Map([['reports/q1.pdf', {}]]));

      await scrubOrgRecords(ORG, MEMBERS);

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

      await scrubOrgRecords(ORG, MEMBERS);

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

      await scrubOrgRecords(ORG, MEMBERS);

      expect(mockDropIndex).toHaveBeenCalledTimes(1);
      expect(mockClearCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('scans only this org, for both pk shapes', async () => {
      await scrubOrgRecords(ORG, MEMBERS);

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

    await scrubOrgRecords(ORG, MEMBERS);

    const queries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.TableName === 'UserInfoTable');
    expect(queries).toHaveLength(2);
    expect(queries[1]!.args[0].input.ExclusiveStartKey).toEqual(cursor);
    expect(deletedKeys()).toContain(`UserInfoTable:ORG#${ORG}/ACCESSKEY#ak-2`);
  });

  // A re-drive after a completed pass: the credentials are already gone, and the
  // stamps land again on rows that keep the first pass's time.
  it('is a clean no-op on a second pass', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'UserInfoTable' })
      .resolves({ Items: [orgRow('DELETION'), orgRow('PROFILE'), orgRow('MEMBER#user-1')] });

    await expect(scrubOrgRecords(ORG, MEMBERS)).resolves.toBeUndefined();

    expect(deletedKeys()).toEqual([]);
    for (const call of ddbMock.commandCalls(UpdateItemCommand)) {
      expect(call.args[0].input.UpdateExpression).toContain('if_not_exists(deletedAt, :now)');
    }
  });
});
