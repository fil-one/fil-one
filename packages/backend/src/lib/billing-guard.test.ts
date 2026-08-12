import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

const ddbMock = mockClient(DynamoDBClient);

import { sendGuardedBillingUpdate } from './billing-guard.js';

const INPUT = {
  TableName: 'BillingTable',
  Key: { pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } },
  UpdateExpression: 'SET subscriptionStatus = :s',
  ExpressionAttributeValues: { ':s': { S: 'active' } },
};
const CONTEXT = { userId: 'user-1', caller: 'test' };

describe('sendGuardedBillingUpdate', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('conditions every write on the row still existing', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await sendGuardedBillingUpdate(INPUT, CONTEXT);

    expect(ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input).toMatchObject({
      ...INPUT,
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('returns the output so callers can read ReturnValues', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .resolves({ Attributes: { subscriptionStatus: { S: 'past_due' } } });

    const result = await sendGuardedBillingUpdate(INPUT, CONTEXT);

    expect(result?.Attributes?.subscriptionStatus?.S).toBe('past_due');
  });

  // A webhook that threw here would be retried by Stripe for days over a row
  // that is never coming back.
  it('treats a purged row as a no-op rather than an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'failed', $metadata: {} }));

    try {
      await expect(sendGuardedBillingUpdate(INPUT, CONTEXT)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('purged billing row'), CONTEXT);
    } finally {
      warn.mockRestore();
    }
  });

  it('rethrows anything else', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(sendGuardedBillingUpdate(INPUT, CONTEXT)).rejects.toThrow('throttled');
  });
});
