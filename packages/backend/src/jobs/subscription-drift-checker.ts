import { GetItemCommand, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getTenantStatus, type TenantStatusResult } from '../lib/aurora-backoffice.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { reportMetric } from '../lib/metrics.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';

const dynamo = getDynamoClient();

// Active subs in DynamoDB are expected to map to ACTIVE tenants in Aurora.
// Anything else — locked, disabled, missing, or any future Aurora state — is
// out of sync. Triage uses orgId/userId from log fields, not metric
// cardinality.
type DriftStatus = 'in_sync' | 'out_of_sync';

interface ActiveCandidate {
  userId: string;
  orgId: string;
}

interface ResolvedTenant {
  auroraTenantId: string | undefined;
  setupStatus: string | undefined;
}

interface RunStats {
  notInSync: number;
  missingTenant: number;
}

export async function handler(): Promise<void> {
  const startedAt = new Date();
  console.log('[subscription-drift-checker] start', {
    timestamp: startedAt.toISOString(),
  });

  const candidates = await scanActiveSubscriptions(Resource.BillingTable.name);
  const uniqueCandidates = dedupeByOrgId(candidates);
  const stats: RunStats = {
    notInSync: 0,
    missingTenant: 0,
  };

  for (const candidate of uniqueCandidates) {
    await evaluateCandidate(candidate, stats);
  }

  emitRunSummary(stats);
  console.log('[subscription-drift-checker] complete', stats);
}

// Multiple SUBSCRIPTION records can exist per orgId (e.g. user re-subscribed
// after cancellation). We probe Aurora once per org so drift metrics are not
// over-counted; the first userId encountered becomes the log/field
// representative for that org.
function dedupeByOrgId(candidates: ActiveCandidate[]): ActiveCandidate[] {
  const seen = new Map<string, ActiveCandidate>();
  for (const candidate of candidates) {
    if (seen.has(candidate.orgId)) continue;
    seen.set(candidate.orgId, candidate);
  }
  return [...seen.values()];
}

async function scanActiveSubscriptions(billingTableName: string): Promise<ActiveCandidate[]> {
  const out: ActiveCandidate[] = [];
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: billingTableName,
        FilterExpression: 'sk = :sk AND subscriptionStatus = :active',
        ExpressionAttributeValues: {
          ':sk': { S: 'SUBSCRIPTION' },
          ':active': { S: SubscriptionStatus.Active },
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);
      if (!record.orgId || typeof record.pk !== 'string') continue;
      out.push({
        userId: record.pk.replace('CUSTOMER#', ''),
        orgId: record.orgId,
      });
    }

    cursor = result.LastEvaluatedKey;
  } while (cursor);

  return out;
}

async function evaluateCandidate(candidate: ActiveCandidate, stats: RunStats): Promise<void> {
  try {
    const tenant = await resolveTenant(candidate.orgId);
    if (!tenant.auroraTenantId || !isOrgSetupComplete(tenant.setupStatus)) {
      stats.missingTenant += 1;
      return;
    }

    const tenantStatus = await getTenantStatus({ tenantId: tenant.auroraTenantId });
    if (tenantStatus.kind === 'error') {
      // No metric counter — total Aurora outages surface as a Grafana
      // no-data alert on SubscriptionStatusDrift; transient failures are for
      // log-based triage.
      console.error('[subscription-drift-checker] probe failed', {
        orgId: candidate.orgId,
        cause: tenantStatus.cause,
      });
      return;
    }

    const classification = getTenantDriftStatus(tenantStatus);
    if (classification === 'out_of_sync') stats.notInSync += 1;
    emitDriftStatus(candidate, classification);
  } catch (error) {
    console.error('[subscription-drift-checker] candidate failed', {
      orgId: candidate.orgId,
      error,
    });
  }
}

async function resolveTenant(orgId: string): Promise<ResolvedTenant> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      ProjectionExpression: 'auroraTenantId, setupStatus',
    }),
  );
  return {
    auroraTenantId: result.Item?.auroraTenantId?.S,
    setupStatus: result.Item?.setupStatus?.S,
  };
}

function getTenantDriftStatus(tenantStatus: TenantStatusResult): DriftStatus {
  return tenantStatus.kind === 'ok' && tenantStatus.status === 'ACTIVE' ? 'in_sync' : 'out_of_sync';
}

function emitDriftStatus(candidate: ActiveCandidate, classification: DriftStatus): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['classification']],
          Metrics: [{ Name: 'SubscriptionStatusDrift', Unit: 'Count' }],
        },
      ],
    },
    classification,
    orgId: candidate.orgId,
    userId: candidate.userId,
    SubscriptionStatusDrift: 1,
  });
}

function emitRunSummary(stats: RunStats): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [
            { Name: 'SubscriptionsNotInSync', Unit: 'Count' },
            { Name: 'SubscriptionsMissingTenant', Unit: 'Count' },
          ],
        },
      ],
    },
    SubscriptionsNotInSync: stats.notInSync,
    SubscriptionsMissingTenant: stats.missingTenant,
  });
}
