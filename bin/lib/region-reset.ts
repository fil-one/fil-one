// What un-provisioning one region touches, decided before anything is written.
//
// region-reset-run.ts scans UserInfoTable and then deletes; the classification in
// between lives here so it can be tested without AWS. The
// same object it builds is the backup file's body, so a restore reads exactly
// what the run decided to delete.

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  AccessKeyKeys,
  DEFAULT_ACCESS_KEY_REGION,
} from '@filone/backend/src/lib/dynamo-records.ts';
import {
  ORCHESTRATOR_ID_BY_REGION,
  orchestratorIdForRegion,
} from '@filone/backend/src/lib/service-orchestrator-ids.ts';

/** One `ACCESSKEY#` / `PROFILE` row as DynamoDB stores it. */
export type StoredRow = Record<string, AttributeValue>;

/** The `PROFILE` row and `ACCESSKEY#` rows of one account, keyed by `pk`. */
export interface OrgRows {
  profile?: StoredRow;
  accessKeys: StoredRow[];
}

/** Everything one account loses in this region. */
export interface AccountPlan {
  orgPk: string;
  orgId: string;
  /** Absent when only access keys put the account in the plan. */
  tenantId?: string;
  /** True when AccountDeletionWorker is already tearing the account down. */
  deleting: boolean;
  /** The profile attributes the reset removes or rewinds, and their prior values. */
  profileAttributes: Record<string, unknown>;
  accessKeys: StoredRow[];
  ssmParameterNames: string[];
}

export interface ResetPlan {
  stage: string;
  region: string;
  orchestratorId: string;
  tenantIdAttribute: string;
  accounts: AccountPlan[];
  /** Accounts holding no state in this region, so nothing to do. */
  notProvisioned: number;
}

export interface ResetPlanInput {
  stage: string;
  region: string;
  orchestratorId: string;
  orgRows: Map<string, OrgRows>;
}

/**
 * Stop before any AWS call when the stage does not allow the region.
 *
 * Production is refused for every region: each one carries real customer
 * data, and a reset takes the region away from every account at once. Every
 * other stage accepts every known region. Throws rather than exiting so the
 * caller owns the message.
 */
export function assertRegionAllowed(stage: string, region: string): void {
  if (!orchestratorIdForRegion(region)) {
    throw new Error(
      `Unknown region "${region}". Known regions: ${Object.keys(ORCHESTRATOR_ID_BY_REGION).join(', ')}.`,
    );
  }
  if (stage === 'production') {
    throw new Error(
      `Refusing to reset ${region} in production: clearing its tenant pointers would cut off ` +
        'every production account in the region. Run this against a non-production stage.',
    );
  }
}

/** AccessKeyKeys has no parser for the ORG# prefix, so derive it from the builder. */
const ORG_PK_PREFIX = AccessKeyKeys.orgPk('');

/**
 * Everything the reset deletes, per account.
 *
 * An account is provisioned in a region iff its `PROFILE` row carries
 * `{orchestratorId}TenantId` — setup writes it last. An account without it
 * still gets an entry when it holds access keys claimed by the region (see
 * below), but no SSM parameters, which are reachable only through a tenant id
 * this region never granted it.
 */
export function buildResetPlan({
  stage,
  region,
  orchestratorId,
  orgRows,
}: ResetPlanInput): ResetPlan {
  const tenantIdAttribute = `${orchestratorId}TenantId`;
  const accounts: AccountPlan[] = [];
  let notProvisioned = 0;

  for (const [orgPk, { profile, accessKeys }] of orgRows) {
    const orgId = orgPk.slice(ORG_PK_PREFIX.length);
    // Access keys are claimed by their own `region` attribute, whether or not
    // the tenant pointer is still there: a key minted between the scan and the
    // pointer removal of an earlier run has no pointer left to find it by, and
    // this is what lets the next run pick it up.
    const regionalAccessKeys = accessKeys.filter(
      (row) => (row.region?.S ?? DEFAULT_ACCESS_KEY_REGION) === region,
    );
    const tenantId = profile?.[tenantIdAttribute]?.S;

    if (!tenantId) {
      if (regionalAccessKeys.length === 0) {
        notProvisioned++;
        continue;
      }
      accounts.push({
        orgPk,
        orgId,
        deleting: profile?.deleting?.BOOL === true,
        profileAttributes: {},
        accessKeys: regionalAccessKeys,
        ssmParameterNames: [],
      });
      continue;
    }

    accounts.push({
      orgPk,
      orgId,
      tenantId,
      deleting: profile?.deleting?.BOOL === true,
      profileAttributes: priorProfileAttributes(profile!, orchestratorId, tenantIdAttribute),
      accessKeys: regionalAccessKeys,
      ssmParameterNames: ssmParameterNames(stage, orchestratorId, tenantId),
    });
  }

  return {
    stage,
    region,
    orchestratorId,
    tenantIdAttribute,
    accounts,
    notProvisioned,
  };
}

/** The lines printed before the confirmation prompt. */
export function formatResetPlan(plan: ResetPlan): string[] {
  const lines: string[] = [];

  for (const account of plan.accounts) {
    lines.push(
      `  ${account.orgPk}` +
        ` tenantId=${account.tenantId ?? '(none)'}` +
        ` keys=${account.accessKeys.length}` +
        ` ssm=${account.ssmParameterNames.length}` +
        (account.deleting ? ' [account deletion in progress]' : ''),
    );
  }

  lines.push('');
  lines.push(`Accounts to reset: ${plan.accounts.length}`);
  lines.push(`Not provisioned in ${plan.region}: ${plan.notProvisioned}`);
  lines.push(`Access-key rows to delete: ${count(plan, (a) => a.accessKeys.length)}`);
  lines.push(`SSM parameters to delete: ${count(plan, (a) => a.ssmParameterNames.length)}`);

  return lines;
}

function count(plan: ResetPlan, of: (account: AccountPlan) => number): number {
  return plan.accounts.reduce((total, account) => total + of(account), 0);
}

/**
 * The console credentials tenant setup stashed for this region.
 *
 * Paths are uniform across orchestrators (see
 * packages/backend/src/lib/s3-credentials.ts); Aurora additionally holds a
 * portal API key.
 */
function ssmParameterNames(stage: string, orchestratorId: string, tenantId: string): string[] {
  const names = [`/filone/${stage}/${orchestratorId}-s3/access-key/${tenantId}`];
  if (orchestratorId === 'aurora') {
    names.push(`/filone/${stage}/aurora-portal/tenant-api-key/${tenantId}`);
  }
  return names;
}

/**
 * What the reset takes off the `PROFILE` row, as the row holds it now.
 *
 * Aurora's setup state machine throws on an unexpected `auroraSetupStatus` and
 * `advanceStatus()` conditions on FILONE_ORG_CREATED, so dropping
 * `auroraTenantId` without rewinding the status would wedge the account.
 * `auroraSetupFailureCount` goes too — at >= 3 it drives the stuck-tenant
 * metric.
 */
function priorProfileAttributes(
  profile: StoredRow,
  orchestratorId: string,
  tenantIdAttribute: string,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    [tenantIdAttribute]: profile[tenantIdAttribute]?.S,
  };
  if (orchestratorId === 'aurora') {
    attributes.auroraSetupStatus = profile.auroraSetupStatus?.S;
    attributes.auroraSetupFailureCount = profile.auroraSetupFailureCount?.N;
  }
  return attributes;
}
