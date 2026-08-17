import { getOrgProfile } from '../lib/org-profile.js';
import { scanSubscriptions } from '../lib/subscription-store.js';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { UsageReportingWorkerPayload } from './usage-reporting-worker.js';

const lambda = new LambdaClient({});

interface SubscriptionRecord {
  pk: string;
  orgId: string;
  /** From the row, or from a legacy pk; lets the worker close out the record when self-healing. */
  userId?: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  subscriptionStatus: string;
}

export async function handler(): Promise<void> {
  const workerFunctionName = process.env.USAGE_WORKER_FUNCTION_NAME!;
  const reportDate = new Date().toISOString().split('T')[0];

  console.log('[usage-orchestrator] Starting usage reporting', { reportDate });

  const records = await scanActiveSubscriptionRecords();

  console.log('[usage-orchestrator] Found subscriptions', { count: records.length });

  if (records.length === 0) return;

  let invoked = 0;
  let failed = 0;

  for (const record of records) {
    // Tenant resolution lives in the worker; the orchestrator passes only the
    // org id (plus billing fields and the org name for Stripe metadata sync).
    const orgName = await resolveOrgName(record.orgId);

    const payload: UsageReportingWorkerPayload = {
      orgId: record.orgId,
      userId: record.userId,
      orgName,
      subscriptionId: record.subscriptionId,
      stripeCustomerId: record.stripeCustomerId,
      currentPeriodStart: record.currentPeriodStart,
      subscriptionStatus: record.subscriptionStatus,
      reportDate,
    };

    if (await invokeUsageWorker(workerFunctionName, payload)) {
      invoked++;
    } else {
      failed++;
    }
  }

  console.log('[usage-orchestrator] Complete', {
    uniqueOrgs: records.length,
    invoked,
    failed,
  });
}

/**
 * The orgs to meter this run: one record per org, so a Stripe meter is never
 * fed twice for one tenant. A second row for an org names both subscription ids
 * in the scan's collision warning, because billing the wrong one is the whole
 * cost of getting this wrong.
 */
async function scanActiveSubscriptionRecords(): Promise<SubscriptionRecord[]> {
  return scanSubscriptions<SubscriptionRecord>({
    job: 'usage-orchestrator',
    // attribute_not_exists(deletedAt) is redundant against the status a scrub
    // writes, and deliberately so: either alone keeps a torn-down org out.
    filterExpression:
      'sk = :sk AND subscriptionStatus <> :canceled AND attribute_exists(subscriptionId) ' +
      'AND attribute_not_exists(deletedAt)',
    expressionAttributeValues: {
      ':sk': { S: 'SUBSCRIPTION' },
      ':canceled': { S: 'canceled' },
    },
    select: (record, owner) => {
      if (!record.currentPeriodStart) {
        console.warn('[usage-orchestrator] Missing currentPeriodStart, skipping', {
          orgId: owner.orgId,
        });
        return undefined;
      }

      if (!record.subscriptionStatus) {
        console.warn('[usage-orchestrator] Missing subscriptionStatus, skipping', {
          orgId: owner.orgId,
        });
        return undefined;
      }

      return {
        ...owner,
        subscriptionId: record.subscriptionId as string,
        stripeCustomerId: record.stripeCustomerId as string,
        currentPeriodStart: record.currentPeriodStart as string,
        subscriptionStatus: record.subscriptionStatus as string,
      };
    },
    describe: (row) => ({
      subscriptionId: row.subscriptionId,
      stripeCustomerId: row.stripeCustomerId,
    }),
  });
}

/** Best-effort org name for Stripe metadata sync; `undefined` if the org has no profile/name. */
async function resolveOrgName(orgId: string): Promise<string | undefined> {
  const orgProfile = await getOrgProfile(orgId);
  return orgProfile?.name?.S;
}

async function invokeUsageWorker(
  workerFunctionName: string,
  payload: UsageReportingWorkerPayload,
): Promise<boolean> {
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    return true;
  } catch (error) {
    console.error('[usage-orchestrator] Failed to invoke worker', {
      orgId: payload.orgId,
      error,
    });
    return false;
  }
}
