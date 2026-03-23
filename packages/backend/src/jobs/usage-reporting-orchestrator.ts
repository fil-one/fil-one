import { ScanCommand, GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from '../lib/ddb-client.js';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import type { UsageReportingWorkerPayload } from './usage-reporting-worker.js';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

interface SubscriptionRecord {
  orgId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  subscriptionStatus: string;
}

export async function handler(): Promise<void> {
  const billingTableName = Resource.BillingTable.name;
  const workerFunctionName = process.env.USAGE_WORKER_FUNCTION_NAME!;
  const reportDate = new Date().toISOString().split('T')[0];

  console.log('[usage-orchestrator] Starting usage reporting', { reportDate });

  // Step 1: Scan for non-canceled subscriptions
  const records: SubscriptionRecord[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: billingTableName,
        FilterExpression:
          'sk = :sk AND subscriptionStatus <> :canceled AND attribute_exists(subscriptionId)',
        ExpressionAttributeValues: {
          ':sk': { S: 'SUBSCRIPTION' },
          ':canceled': { S: 'canceled' },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);

      if (!record.orgId) {
        console.warn('[usage-orchestrator] Missing orgId, skipping', { pk: record.pk });
        continue;
      }

      if (!record.currentPeriodStart) {
        console.warn('[usage-orchestrator] Missing currentPeriodStart, skipping', {
          orgId: record.orgId,
        });
        continue;
      }

      if (!record.subscriptionStatus) {
        console.warn('[usage-orchestrator] Missing subscriptionStatus, skipping', {
          orgId: record.orgId,
        });
        continue;
      }

      records.push({
        orgId: record.orgId,
        subscriptionId: record.subscriptionId,
        stripeCustomerId: record.stripeCustomerId,
        currentPeriodStart: record.currentPeriodStart,
        subscriptionStatus: record.subscriptionStatus,
      });
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log('[usage-orchestrator] Found subscriptions', { count: records.length });

  if (records.length === 0) return;

  // Step 2: Deduplicate by orgId, resolve auroraTenantId, invoke workers
  const orgSeen = new Map<string, { subscriptionId: string; stripeCustomerId: string }>();
  let skippedDuplicate = 0;
  let skippedNoTenant = 0;
  let invoked = 0;
  let failed = 0;

  for (const record of records) {
    const existing = orgSeen.get(record.orgId);
    if (existing) {
      skippedDuplicate++;
      if (
        existing.subscriptionId !== record.subscriptionId ||
        existing.stripeCustomerId !== record.stripeCustomerId
      ) {
        console.warn('[usage-orchestrator] Conflicting duplicate for orgId', {
          orgId: record.orgId,
          first: {
            subscriptionId: existing.subscriptionId,
            stripeCustomerId: existing.stripeCustomerId,
          },
          duplicate: {
            subscriptionId: record.subscriptionId,
            stripeCustomerId: record.stripeCustomerId,
          },
        });
      }
      continue;
    }
    orgSeen.set(record.orgId, {
      subscriptionId: record.subscriptionId,
      stripeCustomerId: record.stripeCustomerId,
    });

    // Resolve auroraTenantId
    const profileResult = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: {
          pk: { S: `ORG#${record.orgId}` },
          sk: { S: 'PROFILE' },
        },
        ProjectionExpression: 'auroraTenantId',
      }),
    );

    const auroraTenantId = profileResult.Item?.auroraTenantId?.S;
    if (!auroraTenantId) {
      skippedNoTenant++;
      console.warn('[usage-orchestrator] Missing auroraTenantId, skipping', {
        orgId: record.orgId,
      });
      continue;
    }

    // Invoke worker
    const payload: UsageReportingWorkerPayload = {
      orgId: record.orgId,
      auroraTenantId,
      subscriptionId: record.subscriptionId,
      stripeCustomerId: record.stripeCustomerId,
      currentPeriodStart: record.currentPeriodStart,
      subscriptionStatus: record.subscriptionStatus,
      reportDate,
    };

    try {
      await lambda.send(
        new InvokeCommand({
          FunctionName: workerFunctionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
      );
      invoked++;
    } catch (error) {
      failed++;
      console.error('[usage-orchestrator] Failed to invoke worker', {
        orgId: record.orgId,
        error: (error as Error).message,
      });
    }
  }

  console.log('[usage-orchestrator] Complete', {
    totalSubscriptions: records.length,
    uniqueOrgs: orgSeen.size,
    invoked,
    failed,
    skippedDuplicate,
    skippedNoTenant,
  });
}
