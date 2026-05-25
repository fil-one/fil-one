import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

import { backfillAuroraSetupFields } from './backfill-aurora-setup-fields.js';

const ddbMock = mockClient(DynamoDBClient);
const TABLE = 'UserInfoTable';

describe('backfillAuroraSetupFields', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
  });

  it('writes the new attributes and copies setupFailureCount on legacy rows', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          pk: { S: 'ORG#org-mid' },
          sk: { S: 'PROFILE' },
          setupStatus: { S: 'AURORA_TENANT_CREATED' },
          setupFailureCount: { N: '2' },
        },
        {
          pk: { S: 'ORG#org-final' },
          sk: { S: 'PROFILE' },
          setupStatus: { S: 'AURORA_S3_ACCESS_KEY_CREATED' },
        },
      ],
    });
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await backfillAuroraSetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: new DynamoDBClient({}),
    });

    expect(result).toEqual({ scanned: 2, migrated: 2, skipped: 0 });
    const updates = ddbMock.commandCalls(UpdateItemCommand);
    expect(updates).toHaveLength(2);

    const midUpdate = updates.find((c) => c.args[0].input.Key?.pk?.S === 'ORG#org-mid')!.args[0]
      .input;
    expect(midUpdate.UpdateExpression).toContain('auroraSetupStatus = :status');
    expect(midUpdate.UpdateExpression).toContain(
      'auroraSetupFailureCount = if_not_exists(auroraSetupFailureCount, :count)',
    );
    expect(midUpdate.ConditionExpression).toBe('attribute_not_exists(auroraSetupStatus)');
    expect(midUpdate.ExpressionAttributeValues).toEqual({
      ':status': { S: 'AURORA_TENANT_CREATED' },
      ':count': { N: '2' },
    });

    const finalUpdate = updates.find((c) => c.args[0].input.Key?.pk?.S === 'ORG#org-final')!.args[0]
      .input;
    expect(finalUpdate.ExpressionAttributeValues).toEqual({
      ':status': { S: 'AURORA_S3_ACCESS_KEY_CREATED' },
      ':count': { N: '0' },
    });
  });

  it('does not write in dry-run mode but still counts rows', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          pk: { S: 'ORG#org-a' },
          sk: { S: 'PROFILE' },
          setupStatus: { S: 'AURORA_TENANT_CREATED' },
          setupFailureCount: { N: '1' },
        },
      ],
    });

    const result = await backfillAuroraSetupFields({
      tableName: TABLE,
      dryRun: true,
      ddb: new DynamoDBClient({}),
    });

    expect(result).toEqual({ scanned: 1, migrated: 1, skipped: 0 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('counts already-migrated rows (concurrent write) as skipped, not failed', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          pk: { S: 'ORG#org-raced' },
          sk: { S: 'PROFILE' },
          setupStatus: { S: 'AURORA_TENANT_CREATED' },
        },
      ],
    });
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        $metadata: {},
        message: 'condition failed',
      }),
    );

    const result = await backfillAuroraSetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: new DynamoDBClient({}),
    });

    expect(result).toEqual({ scanned: 1, migrated: 0, skipped: 1 });
  });

  it('paginates through multiple scan pages', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          {
            pk: { S: 'ORG#org-page1' },
            sk: { S: 'PROFILE' },
            setupStatus: { S: 'FILONE_ORG_CREATED' },
          },
        ],
        LastEvaluatedKey: { pk: { S: 'ORG#org-page1' }, sk: { S: 'PROFILE' } },
      })
      .resolvesOnce({
        Items: [
          {
            pk: { S: 'ORG#org-page2' },
            sk: { S: 'PROFILE' },
            setupStatus: { S: 'AURORA_TENANT_CREATED' },
          },
        ],
      });
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await backfillAuroraSetupFields({
      tableName: TABLE,
      dryRun: false,
      ddb: new DynamoDBClient({}),
    });

    expect(result.scanned).toBe(2);
    expect(result.migrated).toBe(2);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });
});
