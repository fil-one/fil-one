import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { OrgDeletionMember } from './dynamo-records.js';

const dynamo = getDynamoClient();

/**
 * The security-critical deletion fences (FIL-112): guard Stripe billing
 * writes and the grace-period enforcer off the billing record, block tenant
 * setup on the profile, and tombstone every member identity so all sessions
 * die on their very next request.
 *
 * Applied synchronously by the delete-account confirm handler before its 200,
 * and RE-applied idempotently by the teardown worker at the start of every
 * pass: the confirm handler consumes the challenge before writing the fences,
 * so a crash in between leaves a DELETION record with no fences and a burned
 * code — the worker closes that gap.
 */
export async function applyDeletionGuards(
  orgId: string,
  members: OrgDeletionMember[],
): Promise<void> {
  const now = new Date().toISOString();

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE' }),
        UpdateExpression: 'SET deleting = :true',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: marshall({ ':true': true }),
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Profile already purged by a running teardown — nothing to guard.
  }

  // Per-member guards are independent — apply them all in parallel.
  await Promise.all(members.map((member) => guardMember(member, now)));
}

/** Billing-webhook deletion guard + SUB# session kill for one member, in parallel. */
async function guardMember(member: OrgDeletionMember, now: string): Promise<void> {
  const billingGuard = (async () => {
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.BillingTable.name,
          Key: marshall({ pk: `CUSTOMER#${member.userId}`, sk: 'SUBSCRIPTION' }),
          UpdateExpression: 'SET deletionRequestedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: marshall({ ':now': now }),
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // No billing record (e.g. trial never started) — nothing to guard.
    }
  })();

  // if_not_exists keeps the original deletion timestamp stable across
  // idempotent re-confirms (and matches the worker's purge step).
  const sessionKill = member.sub
    ? dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.UserInfoTable.name,
          Key: marshall({ pk: `SUB#${member.sub}`, sk: 'IDENTITY' }),
          UpdateExpression: 'SET deleted = :true, deletedAt = if_not_exists(deletedAt, :now)',
          ExpressionAttributeValues: marshall({ ':true': true, ':now': now }),
        }),
      )
    : Promise.resolve();

  await Promise.all([billingGuard, sessionKill]);
}
