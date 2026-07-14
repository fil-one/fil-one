import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { reportMetric } from '../lib/metrics.js';
import { getOrgProfile, type OrgProfileItem } from '../lib/org-profile.js';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import type { ServiceOrchestrator } from '../lib/service-orchestrator.js';

const dynamo = getDynamoClient();

interface ActiveCandidate {
  userId: string;
  orgId: string;
}

interface OrchestratorStats {
  total: number;
  missingTenant: number;
  checked: number;
  notInSync: number;
  probeFailed: number;
}

export async function handler(): Promise<void> {
  console.log('[subscription-drift-checker] start');

  const orchestrators = getAvailableOrchestrators(process.env.FILONE_STAGE!);
  const candidates = await scanActiveSubscriptions(Resource.BillingTable.name);
  const uniqueCandidates = dedupeByOrgId(candidates);

  // Counters are tracked per orchestrator and emitted with an `orchestrator`
  // CloudWatch dimension, so Aurora vs FTH drift is separable. Every active-sub
  // org is evaluated against every available orchestrator, so `total` is the
  // unique-org count repeated per dimension (read one series for the global total).
  const stats = new Map<string, OrchestratorStats>(
    orchestrators.map((o) => [
      o.id,
      { total: 0, missingTenant: 0, checked: 0, notInSync: 0, probeFailed: 0 },
    ]),
  );

  for (const candidate of uniqueCandidates) {
    // A failed PROFILE read counts as probeFailed on every orchestrator so a
    // transient DDB error skips just this candidate, not the whole run.
    let orgProfile;
    try {
      orgProfile = await getOrgProfile(candidate.orgId);
    } catch (error) {
      console.error('[subscription-drift-checker] PROFILE read failed', {
        orgId: candidate.orgId,
        userId: candidate.userId,
        error,
      });
      for (const orchestrator of orchestrators) {
        const orchestratorStats = stats.get(orchestrator.id)!;
        orchestratorStats.total += 1;
        orchestratorStats.probeFailed += 1;
      }
      continue;
    }

    for (const orchestrator of orchestrators) {
      await evaluateCandidate(candidate, orchestrator, orgProfile, stats.get(orchestrator.id)!);
    }
  }

  emitRunSummary(stats);
  console.log('[subscription-drift-checker] complete', Object.fromEntries(stats));
}

// Multiple SUBSCRIPTION records can exist per orgId (e.g. user re-subscribed
// after cancellation). We probe each orchestrator once per org so drift counts
// are not inflated; the first userId encountered becomes the log representative.
function dedupeByOrgId(candidates: ActiveCandidate[]): ActiveCandidate[] {
  const seen = new Map<string, ActiveCandidate>();
  for (const candidate of candidates) {
    if (seen.has(candidate.orgId)) continue;
    seen.set(candidate.orgId, candidate);
  }
  return [...seen.values()];
}

// Scan filters are applied after consuming RCUs for the full table; at scale
// a GSI on subscriptionStatus would be cheaper (and shareable with the other
// SUBSCRIPTION-status scanners — grace-period-enforcer, usage-reporting-orchestrator).
// Deferred to a follow-up tech-debt ticket.
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
      if (typeof record.pk !== 'string' || !record.orgId) {
        console.warn('[subscription-drift-checker] missing orgId', { pk: record.pk });
        continue;
      }
      out.push({
        userId: record.pk.replace('CUSTOMER#', ''),
        orgId: record.orgId,
      });
    }

    cursor = result.LastEvaluatedKey;
  } while (cursor);

  return out;
}

// Probes a single org against a single orchestrator. An active subscription is
// expected to map to an `active` tenant; anything else (locked/disabled/missing)
// is drift. Each orchestrator resolves its own tenant from the pre-fetched
// PROFILE row via isTenantReady, so an org legitimately absent from an
// orchestrator counts as missingTenant there.
async function evaluateCandidate(
  candidate: ActiveCandidate,
  orchestrator: ServiceOrchestrator,
  orgProfile: OrgProfileItem | undefined,
  stats: OrchestratorStats,
): Promise<void> {
  stats.total += 1;
  try {
    const tenantId = orchestrator.isTenantReady(orgProfile);
    if (!tenantId) {
      stats.missingTenant += 1;
      return;
    }

    stats.checked += 1;
    const probe = await orchestrator.getTenantStatus(tenantId);
    if (probe.kind === 'error') {
      stats.probeFailed += 1;
      console.error('[subscription-drift-checker] probe failed', {
        orgId: candidate.orgId,
        userId: candidate.userId,
        orchestrator: orchestrator.id,
        tenantId,
        cause: probe.cause,
      });
      return;
    }

    if (probe.kind === 'ok' && probe.status === 'active') return;

    stats.notInSync += 1;
    console.log('[subscription-drift-checker] out_of_sync', {
      orgId: candidate.orgId,
      userId: candidate.userId,
      orchestrator: orchestrator.id,
      tenantId,
      status: probe.kind === 'not_found' ? 'not_found' : (probe.status ?? 'unknown'),
    });
  } catch (error) {
    stats.probeFailed += 1;
    console.error('[subscription-drift-checker] candidate failed', {
      orgId: candidate.orgId,
      userId: candidate.userId,
      orchestrator: orchestrator.id,
      error,
    });
  }
}

function emitRunSummary(stats: Map<string, OrchestratorStats>): void {
  for (const [orchestratorId, s] of stats) {
    reportMetric({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [['orchestrator']],
            Metrics: [
              { Name: 'SubscriptionsTotal', Unit: 'Count' },
              { Name: 'SubscriptionsMissingTenant', Unit: 'Count' },
              { Name: 'SubscriptionsTenantsChecked', Unit: 'Count' },
              { Name: 'SubscriptionsNotInSync', Unit: 'Count' },
              { Name: 'SubscriptionsProbeFailed', Unit: 'Count' },
            ],
          },
        ],
      },
      orchestrator: orchestratorId,
      SubscriptionsTotal: s.total,
      SubscriptionsMissingTenant: s.missingTenant,
      SubscriptionsTenantsChecked: s.checked,
      SubscriptionsNotInSync: s.notInSync,
      SubscriptionsProbeFailed: s.probeFailed,
    });
  }
}
