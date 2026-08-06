import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BatchGetItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const ddbMock = mockClient(DynamoDBClient);

process.env.FILONE_STAGE = 'test';

import { batchGet } from './dynamo-batch-get.js';

const TABLE = 'TestTable';

function key(n: number) {
  return { pk: `USER#u-${n}`, sk: 'PROFILE' };
}

describe('batchGet', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('is a no-op on an empty key list (an empty RequestItems map is invalid)', async () => {
    expect(await batchGet(TABLE, [])).toEqual([]);
    expect(ddbMock.commandCalls(BatchGetItemCommand)).toHaveLength(0);
  });

  it('chunks at 100 keys per request and concatenates the responses', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => key(i));
    ddbMock.on(BatchGetItemCommand).callsFake((input) => ({
      Responses: { [TABLE]: input.RequestItems[TABLE].Keys.map((k: unknown) => k) },
    }));

    const items = await batchGet(TABLE, keys);

    const sends = ddbMock.commandCalls(BatchGetItemCommand);
    expect(sends).toHaveLength(2);
    expect(sends[0].args[0].input.RequestItems![TABLE].Keys).toHaveLength(100);
    expect(sends[1].args[0].input.RequestItems![TABLE].Keys).toHaveLength(50);
    expect(items).toHaveLength(150);
  });

  it('omits missing rows rather than yielding holes, so callers must index by pk', async () => {
    ddbMock
      .on(BatchGetItemCommand)
      .resolves({ Responses: { [TABLE]: [marshall({ ...key(1), sub: 'auth0|sub-1' })] } });

    const items = await batchGet(TABLE, [key(0), key(1)]);

    expect(items).toEqual([{ pk: 'USER#u-1', sk: 'PROFILE', sub: 'auth0|sub-1' }]);
  });

  it('retries UnprocessedKeys with backoff, requesting only the leftovers', async () => {
    ddbMock
      .on(BatchGetItemCommand)
      .resolvesOnce({
        Responses: { [TABLE]: [marshall(key(0))] },
        UnprocessedKeys: { [TABLE]: { Keys: [marshall(key(1))] } },
      })
      .resolves({ Responses: { [TABLE]: [marshall(key(1))] } });

    const items = await batchGet(TABLE, [key(0), key(1)], { retries: 4, minTimeout: 0 });

    const sends = ddbMock.commandCalls(BatchGetItemCommand);
    expect(sends).toHaveLength(2);
    expect(sends[1].args[0].input.RequestItems![TABLE].Keys).toEqual([marshall(key(1))]);
    // Each attempt's rows are kept, so the retry does not duplicate or drop.
    expect(items).toEqual([key(0), key(1)]);
  });

  it('caps the retries and throws on exhaustion so the caller re-drives', async () => {
    ddbMock.on(BatchGetItemCommand).resolves({
      Responses: { [TABLE]: [] },
      UnprocessedKeys: { [TABLE]: { Keys: [marshall(key(0))] } },
    });

    await expect(batchGet(TABLE, [key(0)], { retries: 2, minTimeout: 0 })).rejects.toThrow(
      /unprocessed key/,
    );

    // 1 initial attempt + 2 retries.
    expect(ddbMock.commandCalls(BatchGetItemCommand)).toHaveLength(3);
  });
});
