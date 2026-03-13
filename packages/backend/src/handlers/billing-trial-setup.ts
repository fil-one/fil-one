import assert from 'node:assert';
import type { SQSEvent, Context } from 'aws-lambda';
import { ConditionalCheckFailedException, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';

export interface BillingTrialSetupMessage {
  userId: string;
  orgId: string;
  email?: string;
}

const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export async function handler(event: SQSEvent, _context: Context): Promise<void> {
  assert.equal(event.Records.length, 1, `Expected exactly 1 SQS record, got ${event.Records.length}`);

  const { userId, orgId } = JSON.parse(event.Records[0].body) as BillingTrialSetupMessage;
  const now = new Date().toISOString();

  try {
    await getDynamoClient().send(
      new PutItemCommand({
        TableName: Resource.BillingTable.name,
        Item: marshall({
          pk: `CUSTOMER#${userId}`,
          sk: 'SUBSCRIPTION',
          orgId,
          subscriptionStatus: SubscriptionStatus.Trialing,
          trialStartedAt: now,
          trialEndsAt: new Date(Date.now() + TRIAL_DURATION_MS).toISOString(),
          updatedAt: now,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return; // Already exists — no-op
    throw err;
  }
}
