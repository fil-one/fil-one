import { SubscriptionStatus } from '@filone/shared';
import { reportMetric } from '../lib/metrics.js';
import { getOrgProfile, isOrgDeletedOrDeleting, type OrgProfileItem } from '../lib/org-profile.js';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import type { ServiceOrchestrator } from '../lib/service-orchestrator.js';
import { scanSubscriptions } from '../lib/subscription-store.js';

interface ActiveCandidate {
  pk: string;
  userId?: string;
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

  const orchestrators = getAvailableOrchestrators();
  const uniqueCandidates = await scanActiveSubscriptions();

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
    // transient DDB error skips just this candidate, not the whole run. The
    // deletion probe is inside the try for that reason — it reads the same row.
    let orgProfile;
    try {
      // A tenant mid-teardown looks out of sync but is not drift, so it is left
      // out of the stats rather than reported.
      if (await isOrgDeletedOrDeleting(candidate.orgId)) continue;

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

// One candidate per org, so drift counts are not inflated by the twin a
// dual-write leaves behind or by a re-subscription duplicate; the first userId
// encountered becomes the log representative.
//
// Scan filters are applied after consuming RCUs for the full table; at scale
// a GSI on subscriptionStatus would be cheaper (and shareable with the other
// SUBSCRIPTION-status scanners — grace-period-enforcer, usage-reporting-orchestrator).
// Deferred to a follow-up tech-debt ticket.
async function scanActiveSubscriptions(): Promise<ActiveCandidate[]> {
  return scanSubscriptions<ActiveCandidate>({
    job: 'subscription-drift-checker',
    filterExpression:
      'sk = :sk AND subscriptionStatus = :active AND attribute_not_exists(deletedAt)',
    expressionAttributeValues: {
      ':sk': { S: 'SUBSCRIPTION' },
      ':active': { S: SubscriptionStatus.Active },
    },
    select: (_record, owner) => owner,
  });
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
