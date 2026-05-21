import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';

import { cleanupLegacySetupFields } from './cleanup-legacy-setup-fields.js';

const ddbMock = mockClient(DynamoDBClient);
const TABLE = 'UserInfoTable';

const row = (pk: string, attrs: Record<string, AttributeValue> = {}) => ({
  pk: { S: pk },
  sk: { S: 'PROFILE' },
  ...attrs,
});

describe('cleanupLegacySetupFields', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('removes setupStatus and setupFailureCount from a matching row', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        row('ORG#a', { setupStatus: { S: 'FILONE_ORG_CREATED' }, setupFailureCount: { N: '2' } }),
      ],
    });
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await cleanupLegacySetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: ddbMock as unknown as DynamoDBClient,
    });

    expect(result).toStrictEqual({ scanned: 1, cleaned: 1, skipped: 0 });
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: TABLE,
      Key: { pk: { S: 'ORG#a' }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'REMOVE setupStatus, setupFailureCount',
    });
  });

  it('removes attrs even when only setupFailureCount is present', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [row('ORG#b', { setupFailureCount: { N: '1' } })],
    });
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await cleanupLegacySetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: ddbMock as unknown as DynamoDBClient,
    });

    expect(result).toStrictEqual({ scanned: 1, cleaned: 1, skipped: 0 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  it('does not call UpdateItem in dry-run mode', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        row('ORG#a', { setupStatus: { S: 'FILONE_ORG_CREATED' } }),
        row('ORG#b', { setupFailureCount: { N: '3' } }),
      ],
    });

    const result = await cleanupLegacySetupFields({
      tableName: TABLE,
      dryRun: true,
      ddb: ddbMock as unknown as DynamoDBClient,
    });

    expect(result).toStrictEqual({ scanned: 2, cleaned: 2, skipped: 0 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('paginates via ExclusiveStartKey until the scan exhausts', async () => {
    const page1Key = { pk: { S: 'ORG#a' }, sk: { S: 'PROFILE' } };
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [row('ORG#a', { setupStatus: { S: 'X' } })],
        LastEvaluatedKey: page1Key,
      })
      .resolvesOnce({
        Items: [row('ORG#b', { setupStatus: { S: 'Y' } })],
      });
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await cleanupLegacySetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: ddbMock as unknown as DynamoDBClient,
    });

    expect(result).toStrictEqual({ scanned: 2, cleaned: 2, skipped: 0 });
    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls).toHaveLength(2);
    expect(scanCalls[0].args[0].input.ExclusiveStartKey).toBeUndefined();
    expect(scanCalls[1].args[0].input.ExclusiveStartKey).toStrictEqual(page1Key);
  });

  it('is a no-op when the scan filter matches nothing', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await cleanupLegacySetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: ddbMock as unknown as DynamoDBClient,
    });

    expect(result).toStrictEqual({ scanned: 0, cleaned: 0, skipped: 0 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('skips rows missing pk/sk without calling UpdateItem', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ setupStatus: { S: 'X' } } as Record<string, AttributeValue>],
    });

    const result = await cleanupLegacySetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: ddbMock as unknown as DynamoDBClient,
    });

    expect(result).toStrictEqual({ scanned: 1, cleaned: 0, skipped: 1 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });
});
