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

import { batchDelete, queryOrgRows, listRagKeys } from './deletion-purge.js';

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

    await batchDelete('TestTable', [{ pk: 'ORG#org-1', sk: 'PROFILE' }, KEY], {
      retries: 4,
      minTimeout: 0,
    });

    const sends = ddbMock.commandCalls(BatchWriteItemCommand);
    expect(sends).toHaveLength(2);
    expect(sends[0].args[0].input.RequestItems!.TestTable).toHaveLength(2);
    // Only the unprocessed key is retried, not the whole chunk.
    expect(sends[1].args[0].input.RequestItems!.TestTable).toHaveLength(1);
    expect(sends[1].args[0].input.RequestItems!.TestTable[0].DeleteRequest!.Key!.sk.S).toBe(KEY.sk);
  });

  it('caps the retries and throws on exhaustion so the orchestrator re-drives', async () => {
    ddbMock.on(BatchWriteItemCommand).resolves(unprocessed);

    await expect(batchDelete('TestTable', [KEY], { retries: 2, minTimeout: 0 })).rejects.toThrow(
      /unprocessed delete/,
    );

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

    await listRagKeys('org-1');

    const scans = ddbMock.commandCalls(ScanCommand).map((c) => c.args[0].input);
    expect(scans).not.toHaveLength(0);
    for (const scan of scans) expect(scan.ConsistentRead).toBe(true);
  });
});
