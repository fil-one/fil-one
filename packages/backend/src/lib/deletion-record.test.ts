import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { claimDeletionRerun, DELETION_REDRIVE_COOLDOWN_MS } from './deletion-record.js';

const ORG_ID = 'org-123';
const NOW = new Date('2026-08-10T12:00:00.000Z');

describe('claimDeletionRerun', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims with a conditional write that a FIRST re-drive can satisfy', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await expect(claimDeletionRerun(ORG_ID)).resolves.toBe(true);

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.TableName).toBe('UserInfoTable');
    expect(input.Key).toEqual({ pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'DELETION' } });
    // The claim IS the conditional write — two concurrent requests cannot both
    // win — and it must never touch `updatedAt`, the orchestrator's liveness
    // signal.
    expect(input.UpdateExpression).toBe('SET lastAttemptAt = :now');
    // `attribute_not_exists(lastAttemptAt)` is load-bearing: without that
    // disjunct a record that has never been re-driven has nothing to compare
    // against `:cutoff`, the condition fails, and the FIRST re-drive of every
    // org silently stops firing — the dead end this primitive exists to fix.
    expect(input.ConditionExpression).toBe(
      'attribute_exists(pk) AND (attribute_not_exists(lastAttemptAt) OR lastAttemptAt < :cutoff)',
    );
    expect(input.ExpressionAttributeValues?.[':now']?.S).toBe(NOW.toISOString());
    expect(input.ExpressionAttributeValues?.[':cutoff']?.S).toBe(
      new Date(NOW.getTime() - DELETION_REDRIVE_COOLDOWN_MS).toISOString(),
    );
  });

  it('reports the cooldown as live when the condition fails', async () => {
    const conditionFailed = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    ddbMock.on(UpdateItemCommand).rejects(conditionFailed);

    await expect(claimDeletionRerun(ORG_ID)).resolves.toBe(false);
  });

  it('rethrows any other DynamoDB failure rather than reporting a live cooldown', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('ProvisionedThroughputExceeded'));

    await expect(claimDeletionRerun(ORG_ID)).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});
