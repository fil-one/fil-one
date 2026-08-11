import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchWriteItemCommand,
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    RagIndexerTable: { name: 'RagIndexerTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.FILONE_STAGE = 'test';

import {
  assertPurgeablePk,
  batchDelete,
  queryOrgRows,
  scanRagKeys,
  PURGEABLE_BILLING_PK_PREFIXES,
  PURGEABLE_USER_INFO_PK_PREFIXES,
} from './deletion-purge.js';

describe('assertPurgeablePk (purge blast-radius guard)', () => {
  it('refuses to delete the EMAIL_NORM# trial-claim record, which must survive account deletion (FIL-422)', () => {
    expect(() =>
      assertPurgeablePk('EMAIL_NORM#user@gmail.com', PURGEABLE_USER_INFO_PK_PREFIXES),
    ).toThrow(/outside the purgeable prefixes/);
  });

  it('permits deletion of keys under an allowlisted prefix', () => {
    for (const pk of ['ORG#abc', 'USER#u-1', 'SUB#auth0|x', 'RAGKEYHASH#deadbeef']) {
      expect(() => assertPurgeablePk(pk, PURGEABLE_USER_INFO_PK_PREFIXES)).not.toThrow();
    }
  });

  it('is not fooled by prefix collisions: ORGANIZATION# is not ORG#', () => {
    // The prefixes end in '#' precisely so a longer key family sharing the
    // leading letters can never slip through the guard.
    expect(() => assertPurgeablePk('ORGANIZATION#abc', PURGEABLE_USER_INFO_PK_PREFIXES)).toThrow(
      /outside the purgeable prefixes/,
    );
  });

  it('billing allowlist: permits CUSTOMER#, DELETION_CHALLENGE# and ORG# rows only', () => {
    expect(() => assertPurgeablePk('CUSTOMER#u-1', PURGEABLE_BILLING_PK_PREFIXES)).not.toThrow();
    expect(() =>
      assertPurgeablePk('DELETION_CHALLENGE#org-1', PURGEABLE_BILLING_PK_PREFIXES),
    ).not.toThrow();
    // The usage-reporting worker's audit rows; previously unpurgeable, so they
    // outlived the deletion until their 365-day TTL.
    expect(() => assertPurgeablePk('ORG#org-1', PURGEABLE_BILLING_PK_PREFIXES)).not.toThrow();
  });

  it('billing allowlist: refuses EMAIL_NORM# (trial claims) and the ORG_TOMBSTONE#, which must outlive the account', () => {
    expect(() =>
      assertPurgeablePk('EMAIL_NORM#user@gmail.com', PURGEABLE_BILLING_PK_PREFIXES),
    ).toThrow(/outside the purgeable prefixes/);
    // The trailing '#' on 'ORG#' is what keeps the tombstone out of reach.
    expect(() => assertPurgeablePk('ORG_TOMBSTONE#org-1', PURGEABLE_BILLING_PK_PREFIXES)).toThrow(
      /outside the purgeable prefixes/,
    );
  });
});

describe('batchDelete', () => {
  const KEY = { pk: 'ORG#org-1', sk: 'MEMBER#user-1' };
  const unprocessed = {
    UnprocessedItems: { TestTable: [{ DeleteRequest: { Key: marshall(KEY) } }] },
  };

  beforeEach(() => {
    ddbMock.reset();
  });

  it('retries UnprocessedItems with backoff instead of looping tight: two sends, second retries only the leftovers', async () => {
    ddbMock.on(BatchWriteItemCommand).resolvesOnce(unprocessed).resolves({});

    await batchDelete(
      'TestTable',
      [{ pk: 'ORG#org-1', sk: 'PROFILE' }, KEY],
      PURGEABLE_USER_INFO_PK_PREFIXES,
      { retries: 4, minTimeout: 0 },
    );

    const sends = ddbMock.commandCalls(BatchWriteItemCommand);
    expect(sends).toHaveLength(2);
    expect(sends[0].args[0].input.RequestItems!.TestTable).toHaveLength(2);
    // Only the unprocessed key is retried, not the whole chunk.
    expect(sends[1].args[0].input.RequestItems!.TestTable).toHaveLength(1);
    expect(sends[1].args[0].input.RequestItems!.TestTable[0].DeleteRequest!.Key!.sk.S).toBe(KEY.sk);
  });

  it('caps the retries and throws on exhaustion so the orchestrator re-drives', async () => {
    ddbMock.on(BatchWriteItemCommand).resolves(unprocessed);

    await expect(
      batchDelete('TestTable', [KEY], PURGEABLE_USER_INFO_PK_PREFIXES, {
        retries: 2,
        minTimeout: 0,
      }),
    ).rejects.toThrow(/unprocessed delete/);

    // 1 initial attempt + 2 retries.
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(3);
  });
});

describe('purge reads are strongly consistent', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('queries an org partition with ConsistentRead', async () => {
    // A fenced write that committed just before teardown started has to be
    // visible to the purge that deletes it. The resurrection sweep would catch a
    // survivor later, but the primary path must not depend on the backstop.
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await queryOrgRows('org-1');

    const queries = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries).not.toHaveLength(0);
    for (const query of queries) expect(query.ConsistentRead).toBe(true);
  });

  it('scans the RAG tables with ConsistentRead', async () => {
    // Same reason. This one is a Scan, so the flag doubles its RCU cost — a
    // deliberate trade, and the assertion is what stops it being dropped as an
    // optimisation.
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await scanRagKeys('org-1');

    const scans = ddbMock.commandCalls(ScanCommand).map((c) => c.args[0].input);
    expect(scans).not.toHaveLength(0);
    for (const scan of scans) expect(scan.ConsistentRead).toBe(true);
  });
});

describe('batchDelete enforces the blast radius', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(BatchWriteItemCommand).resolves({});
  });

  it('refuses a key outside the prefixes and sends nothing at all', async () => {
    // The guard is inside batchDelete rather than at its call sites, so a caller
    // cannot forget it. Before that, `assertPurgeablePk` was a separate export and
    // this call compiled and deleted.
    await expect(
      batchDelete(
        'UserInfoTable',
        [{ pk: 'EMAIL_NORM#user@gmail.com', sk: 'CLAIM' }],
        PURGEABLE_USER_INFO_PK_PREFIXES,
      ),
    ).rejects.toThrow(/outside the purgeable prefixes/);

    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(0);
  });

  it('checks every key before the first chunk is sent', async () => {
    // 25 keys per chunk: a bad key in the second chunk must stop the first one
    // too, or the purge half-completes past its own guard.
    const keys = Array.from({ length: 26 }, (_, i) => ({ pk: `ORG#org-${i}`, sk: 'ROW' }));
    keys[25] = { pk: 'ORG_TOMBSTONE#org-1', sk: 'TOMBSTONE' };

    await expect(batchDelete('BillingTable', keys, PURGEABLE_BILLING_PK_PREFIXES)).rejects.toThrow(
      /outside the purgeable prefixes/,
    );

    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(0);
  });
});
