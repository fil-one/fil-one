// What ../unlock-tenants.ts needs to run the backend's own tenant status sync
// from a laptop: the deployed orchestrator settings, the tokens they use, and
// how to read the result.
//
// The backend reads its settings from process.env and its secrets and tables
// through `Resource` from 'sst', which parses each `SST_RESOURCE_<Name>`
// variable as JSON on first access. Seeding those variables before the first
// access lets the script call `syncTenantStatusInProvisionedNetworks` unchanged.

import { SubscriptionStatus } from '@filone/shared';
import type { TenantSyncOutcome } from '@filone/backend/src/lib/region-helpers.ts';

/**
 * The orchestrator settings in the deployed Lambda's environment (orchestratorEnv
 * in sst.config.ts) that the status sync reads.
 */
export const ORCHESTRATOR_ENV_NAMES = [
  'FILONE_STAGE',
  'AURORA_BACKOFFICE_URL',
  'AURORA_PARTNER_ID',
  'AURORA_REGION_ID',
  'FTH_MANAGEMENT_API_URL',
  'FORGE_MANAGEMENT_API_URL',
  'FORGE_DEV_MANAGEMENT_API_URL',
  'FORGE_DEV_S3_ENDPOINT_URL',
  'FORGE_DEV_S3_PRESIGN_ENDPOINT_URL',
] as const;

// Each orchestrator's API URL variable, and the SST secret holding its token.
// A stage without the URL does not run that orchestrator, so needs no token.
const TOKEN_BY_URL: ReadonlyArray<[string, string]> = [
  ['AURORA_BACKOFFICE_URL', 'AuroraBackofficeToken'],
  ['FTH_MANAGEMENT_API_URL', 'FthManagementApiToken'],
  ['FORGE_MANAGEMENT_API_URL', 'ForgeManagementApiToken'],
  ['FORGE_DEV_MANAGEMENT_API_URL', 'ForgeDevManagementApiToken'],
];

type LambdaEnv = Record<string, string | undefined>;

/** The SST secrets the stage's orchestrators need. */
export function orchestratorSecrets(lambdaEnv: LambdaEnv): string[] {
  return TOKEN_BY_URL.filter(([url]) => lambdaEnv[url]).map(([, secret]) => secret);
}

/**
 * The process environment that makes the backend reach the stage's
 * orchestrators: the deployed settings that are set, plus each secret and the
 * UserInfoTable as an SST resource.
 */
export function orchestratorProcessEnv({
  stage,
  lambdaEnv,
  secrets,
  userInfoTable,
}: {
  stage: string;
  lambdaEnv: LambdaEnv;
  secrets: Record<string, string>;
  userInfoTable: string;
}): Record<string, string> {
  const settings = Object.entries(lambdaEnv).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
  return {
    ...Object.fromEntries(settings),
    SST_RESOURCE_App: JSON.stringify({ name: 'filone', stage }),
    SST_RESOURCE_UserInfoTable: JSON.stringify({ name: userInfoTable }),
    ...Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [
        `SST_RESOURCE_${name}`,
        JSON.stringify({ value }),
      ]),
    ),
  };
}

// Statuses no scheduled job locks: the usage job skips paid and manual orgs,
// and the grace-period job reads only grace_period rows.
const STAYS_UNLOCKED: ReadonlySet<string> = new Set([
  SubscriptionStatus.Manual,
  SubscriptionStatus.Active,
]);

/** What the operator should know before unlocking an org with this billing status. */
export function unlockWarnings(subscriptionStatus: string | undefined): string[] {
  if (subscriptionStatus && STAYS_UNLOCKED.has(subscriptionStatus)) return [];
  return [
    `The org's billing status is ${subscriptionStatus ?? 'unset'}, so the usage or grace-period job ` +
      'may lock its tenants again on its next run. Set the billing row first, e.g. with ' +
      'bin/set-manual-billing.ts.',
  ];
}

/**
 * One line per region, and whether the run failed: a region that errored or
 * has no tenant, or no region at all, means the org is not unlocked.
 */
export function summarizeOutcomes(outcomes: TenantSyncOutcome[]): {
  lines: string[];
  failed: boolean;
} {
  if (outcomes.length === 0) return { lines: ['  (no provisioned networks)'], failed: true };
  return {
    lines: outcomes.map(({ orchestratorId, tenantId, outcome, cause }) => {
      const detail =
        outcome === 'error' ? `error: ${(cause as Error | undefined)?.message}` : outcome;
      return `  ${orchestratorId}  ${tenantId}  ${detail}`;
    }),
    // A missing tenant was not made active either.
    failed: outcomes.some(({ outcome }) => outcome === 'error' || outcome === 'not-found'),
  };
}
