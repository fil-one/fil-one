import { randomUUID } from 'node:crypto';
import {
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';
import { buildFirstPresignLifecycleOutbox } from './lifecycle-outbox.ts';

const PROVIDERS = new Set(['aurora', 'fth', 'forge', 'forgeDev']);
const MARKER = 'lifecycleFirstPresignEventId';

/**
 * Commit a milestone only for signups instrumented from their creation. Existing
 * Organizations are not silently relabeled as having their first issuance now.
 * The caller invokes this after every URL in the batch has been generated.
 */
export async function recordFirstPresignLifecycle({
  orgId,
  provider,
  tenantId,
  profile,
}: {
  orgId: string;
  provider: string;
  tenantId: string;
  profile?: Record<string, AttributeValue>;
}): Promise<void> {
  const epoch = process.env.FILONE_LIFECYCLE_FIRST_MILESTONE_EPOCH;
  if (
    !process.env.FILONE_LIFECYCLE_OUTBOX_TABLE ||
    !epoch ||
    !profile?.lifecycleCaptureStartedAt?.S ||
    profile.lifecycleCaptureEpoch?.S !== epoch
  )
    return;
  if (profile[MARKER]?.S) return; // Reuses the profile already read by presign.
  if (!PROVIDERS.has(provider) || profile[`${provider}TenantId`]?.S !== tenantId) {
    throw new Error('Lifecycle tenant mapping is unavailable');
  }
  const outbox = buildFirstPresignLifecycleOutbox({
    orgId,
    provider,
    tenantId,
    occurredAt: new Date().toISOString(),
  });
  const eventId = outbox[0].Put!.Item!.event_id.S!;
  const capturedAt = profile.lifecycleCaptureStartedAt.S;
  try {
    await getDynamoClient().send(
      new TransactWriteItemsCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          {
            Update: {
              TableName: Resource.UserInfoTable.name,
              Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
              UpdateExpression: 'SET #first = :event',
              ConditionExpression:
                'attribute_exists(pk) AND attribute_not_exists(deleting) ' +
                'AND lifecycleCaptureStartedAt = :captured AND lifecycleCaptureEpoch = :epoch AND #tenant = :tenant ' +
                'AND attribute_not_exists(#first)',
              ExpressionAttributeNames: { '#first': MARKER, '#tenant': `${provider}TenantId` },
              ExpressionAttributeValues: {
                ':event': { S: eventId },
                ':captured': { S: capturedAt },
                ':epoch': { S: epoch },
                ':tenant': { S: tenantId },
              },
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
          ...outbox,
        ],
      }),
    );
  } catch (error) {
    // A concurrent first issuance is the only acceptable conditional no-op.
    // Refused deletion/mapping/capture fences and unavailable storage fail the
    // canary request. Never log a cancellation's potentially private old item.
    if (
      isConcurrentFirstCommit(error, {
        [MARKER]: eventId,
        lifecycleCaptureStartedAt: capturedAt,
        lifecycleCaptureEpoch: epoch,
        [`${provider}TenantId`]: tenantId,
      })
    )
      return;
    throw new Error('Lifecycle first-issuance commit unavailable');
  }
}

function isConcurrentFirstCommit(error: unknown, expected: Record<string, string>): boolean {
  if (!(error instanceof TransactionCanceledException)) return false;
  const [first, ...others] = error.CancellationReasons ?? [];
  if (first?.Code !== 'ConditionalCheckFailed' || !first.Item) return false;
  if (
    others.some((reason) => ![undefined, 'None', 'ConditionalCheckFailed'].includes(reason.Code))
  ) {
    return false;
  }
  const prior = first.Item;
  return (
    Object.entries(expected).every(([name, value]) => prior[name]?.S === value) &&
    prior.deleting === undefined
  );
}
