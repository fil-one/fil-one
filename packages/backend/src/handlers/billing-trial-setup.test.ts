import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './billing-trial-setup.js';
import { buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSQSEvent(body: object): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        receiptHandle: 'handle-1',
        body: JSON.stringify(body),
        attributes: {} as SQSEvent['Records'][0]['attributes'],
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('billing-trial-setup handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.restoreAllMocks();
  });

  it('creates trial record for new user', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    const message = { userId: 'user-1', orgId: 'org-1', email: 'test@example.com' };
    await handler(buildSQSEvent(message), buildContext());

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);

    const input = putCalls[0].args[0].input;
    expect(input.TableName).toBe('BillingTable');
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');

    // Verify item fields via the marshalled Item
    const item = input.Item!;
    expect(item.pk).toEqual({ S: 'CUSTOMER#user-1' });
    expect(item.sk).toEqual({ S: 'SUBSCRIPTION' });
    expect(item.orgId).toEqual({ S: 'org-1' });
    expect(item.subscriptionStatus).toEqual({ S: SubscriptionStatus.Trialing });
    expect(item.trialStartedAt).toBeDefined();
    expect(item.trialEndsAt).toBeDefined();
    expect(item.updatedAt).toBeDefined();
  });

  it('no-ops when record already exists (ConditionalCheckFailedException)', async () => {
    ddbMock.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    const message = { userId: 'user-1', orgId: 'org-1' };
    // Should not throw
    await handler(buildSQSEvent(message), buildContext());
  });

  it('throws when batch contains more than one record', async () => {
    const event = buildSQSEvent({ userId: 'user-1', orgId: 'org-1' });
    event.Records.push({ ...event.Records[0], messageId: 'msg-2' });

    await expect(handler(event, buildContext())).rejects.toThrow(
      'Expected exactly 1 SQS record, got 2',
    );
  });

  it('propagates unexpected DynamoDB errors', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('Service unavailable'));

    const message = { userId: 'user-1', orgId: 'org-1' };
    await expect(handler(buildSQSEvent(message), buildContext())).rejects.toThrow(
      'Service unavailable',
    );
  });
});
