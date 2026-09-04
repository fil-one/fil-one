// What un-provisioning one region touches, decided before anything is written.
//
// bin/reset-region-provisioning.ts scans two tables and then deletes; the
// classification in between lives here so it can be tested without AWS. The
// same object it builds is the backup file's body, so a restore reads exactly
// what the run decided to delete.

import { createHash } from 'node:crypto';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

// Inlined from packages/backend/src/lib/service-orchestrator-registry.ts and
// packages/shared/src/constants.ts — bin/ scripts must NOT import
// @filone/shared or the backend. Keep in sync when a region is added or
// re-homed. The map is also what reaches us-east-9, which getAvailableRegions
// currently disables on every stage.
export const ORCHESTRATOR_ID_BY_REGION: Record<string, string> = {
  'eu-west-1': 'aurora',
  'us-east-1': 'fth',
  'eu-central-3': 'forge',
  'us-east-9': 'forgeDev',
};

/**
 * The region an ACCESSKEY# row belongs to when it predates the `region`
 * attribute — the same fallback as
 * packages/backend/src/handlers/delete-access-key.ts.
 */
export const DEFAULT_ACCESS_KEY_REGION = 'eu-west-1';

/** Inlined from packages/backend/src/lib/org-setup-status.ts. */
export const FILONE_ORG_CREATED = 'FILONE_ORG_CREATED';

/**
 * The regions production refuses.
 *
 * Aurora (eu-west-1) and FTH (us-east-1) are the generally-available regions
 * carrying real customer data; clearing their tenant pointers would cut off
 * every production customer at once. Production leaves the pilot regions,
 * which is what retiring one needs.
 */
const PRODUCTION_REFUSED_REGIONS: Record<string, string> = {
  'eu-west-1': 'Aurora',
  'us-east-1': 'FTH',
};

/** One `ACCESSKEY#` / `BUCKET#` / `PROFILE` row as DynamoDB stores it. */
export type StoredRow = Record<string, AttributeValue>;

/** The `PROFILE` row and `ACCESSKEY#` rows of one account, keyed by `pk`. */
export interface OrgRows {
  profile?: StoredRow;
  accessKeys: StoredRow[];
}

/** One RAG-enabled bucket in the region being reset, with everything naming it. */
export interface RagBucketPlan {
  bucketName: string;
  /** The S3 Vectors index behind the bucket, as {@link ragIndexName} derives it. */
  indexName: string;
  /** Its `RAG`, `MANIFEST#` and `CHECKPOINT` rows in RagIndexerTable. */
  rows: StoredRow[];
}

/** Everything one account loses in this region. */
export interface AccountPlan {
  orgPk: string;
  orgId: string;
  /** Absent when only dangling RAG rows put the account in the plan. */
  tenantId?: string;
  /** True when AccountDeletionWorker is already tearing the account down. */
  deleting: boolean;
  /** The profile attributes the reset removes or rewinds, and their prior values. */
  profileAttributes: Record<string, unknown>;
  accessKeys: StoredRow[];
  ragBuckets: RagBucketPlan[];
  ssmParameterNames: string[];
}

export interface ResetPlan {
  stage: string;
  region: string;
  orchestratorId: string;
  tenantIdAttribute: string;
  vectorBucket: string;
  accounts: AccountPlan[];
  /** Accounts holding no state in this region, so nothing to do. */
  notProvisioned: number;
}

export interface ResetPlanInput {
  stage: string;
  region: string;
  orchestratorId: string;
  vectorBucket: string;
  orgRows: Map<string, OrgRows>;
  ragRows: StoredRow[];
}

/**
 * Stop before any AWS call when the stage does not allow the region.
 *
 * Throws rather than exiting so the caller owns the message; every other
 * stage accepts all four regions.
 */
export function assertRegionAllowed(stage: string, region: string): void {
  if (!ORCHESTRATOR_ID_BY_REGION[region]) {
    throw new Error(
      `Unknown region "${region}". Known regions: ${Object.keys(ORCHESTRATOR_ID_BY_REGION).join(', ')}.`,
    );
  }
  if (stage !== 'production') return;

  const orchestrator = PRODUCTION_REFUSED_REGIONS[region];
  if (orchestrator) {
    throw new Error(
      `Refusing to reset ${region} in production: ${orchestrator} is generally available and ` +
        'carries real customer data, so clearing its tenant pointers would cut off every ' +
        'production customer. Production allows only the pilot regions: ' +
        `${Object.keys(ORCHESTRATOR_ID_BY_REGION)
          .filter((candidate) => !PRODUCTION_REFUSED_REGIONS[candidate])
          .join(', ')}.`,
    );
  }
}

export type RagPkKind = 'bucket' | 'checkpoint';

/** The prefix each RAG partition-key shape carries, from RAGKeys in dynamo-records.ts. */
const RAG_PK_KIND_BY_PREFIX: Record<string, RagPkKind> = {
  BUCKET: 'bucket',
  INDEXER_CHECKPOINT: 'checkpoint',
};

/**
 * Split a RAG partition key back into its parts.
 *
 * Mirrors `RAGKeys.parseBucketPk` in packages/backend/src/lib/dynamo-records.ts
 * for both shapes it writes — `BUCKET#{orgId}#{region}#{bucketName}` and
 * `INDEXER_CHECKPOINT#{orgId}#{region}#{bucketName}`. None of the three
 * segments can hold a `#`, so a 4-way split is unambiguous. Region membership
 * is checked stage-independently, because a currently-disabled region must
 * still parse.
 */
export function parseRagPk(
  pk: string,
): { kind: RagPkKind; orgId: string; region: string; bucketName: string } | undefined {
  const parts = pk.split('#');
  if (parts.length !== 4) return undefined;

  const kind = RAG_PK_KIND_BY_PREFIX[parts[0]!];
  const [, orgId, region, bucketName] = parts;
  if (!kind || !orgId || !bucketName) return undefined;
  if (!ORCHESTRATOR_ID_BY_REGION[region!]) return undefined;

  return { kind, orgId, region: region!, bucketName };
}

/**
 * The S3 Vectors index behind one RAG-enabled bucket.
 *
 * Mirrors `S3VectorsStore#indexName` in
 * packages/rag-shared/src/s3-vectors-store.ts, which is private and cannot be
 * imported here anyway: Node's type stripping does not resolve that module's
 * `./constants.js` specifier. region-reset.test.ts holds this copy to the real
 * store, because a copy that drifts would name an index nothing deletes.
 */
export function ragIndexName(orgId: string, region: string, bucketName: string): string {
  const digest = createHash('sha256').update([orgId, region, bucketName].join('#')).digest('hex');
  return `rag-${digest.slice(0, 56)}`;
}

/** The prefix every account partition key carries, from lib/account-creation.ts. */
const ORG_PK_PREFIX = 'ORG#';

/**
 * Everything the reset deletes, per account.
 *
 * An account is provisioned in a region iff its `PROFILE` row carries
 * `{orchestratorId}TenantId` — setup writes it last. RAG rows naming the
 * region are dangling whether or not that attribute is there, so an account
 * holding only those still gets an entry; its access keys and SSM parameters
 * do not, because both are reachable only through a tenant id this region
 * never granted it.
 */
export function buildResetPlan({
  stage,
  region,
  orchestratorId,
  vectorBucket,
  orgRows,
  ragRows,
}: ResetPlanInput): ResetPlan {
  const tenantIdAttribute = `${orchestratorId}TenantId`;
  const ragByOrg = groupRagRows(region, ragRows);
  const accounts: AccountPlan[] = [];
  let notProvisioned = 0;

  for (const [orgPk, { profile, accessKeys }] of orgRows) {
    const orgId = orgPk.slice(ORG_PK_PREFIX.length);
    const ragBuckets = takeRagBuckets(ragByOrg, orgId, region);
    const tenantId = profile?.[tenantIdAttribute]?.S;

    if (!tenantId) {
      if (ragBuckets.length === 0) {
        notProvisioned++;
        continue;
      }
      accounts.push({
        orgPk,
        orgId,
        deleting: profile?.deleting?.BOOL === true,
        profileAttributes: {},
        accessKeys: [],
        ragBuckets,
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
      accessKeys: accessKeys.filter(
        (row) => (row.region?.S ?? DEFAULT_ACCESS_KEY_REGION) === region,
      ),
      ragBuckets,
      ssmParameterNames: ssmParameterNames(stage, orchestratorId, tenantId),
    });
  }

  // RAG rows whose account has no row in UserInfoTable at all are dangling
  // twice over; nothing else would ever find them.
  for (const [orgId, buckets] of ragByOrg) {
    accounts.push({
      orgPk: `${ORG_PK_PREFIX}${orgId}`,
      orgId,
      deleting: false,
      profileAttributes: {},
      accessKeys: [],
      ragBuckets: bucketPlans(buckets, orgId, region),
      ssmParameterNames: [],
    });
  }

  return {
    stage,
    region,
    orchestratorId,
    tenantIdAttribute,
    vectorBucket,
    accounts,
    notProvisioned,
  };
}

/** The lines printed before the confirmation prompt. */
export function formatResetPlan(plan: ResetPlan): string[] {
  const lines: string[] = [];

  for (const account of plan.accounts) {
    const ragRows = account.ragBuckets.reduce((total, bucket) => total + bucket.rows.length, 0);
    lines.push(
      `  ${account.orgPk}` +
        ` tenantId=${account.tenantId ?? '(none)'}` +
        ` keys=${account.accessKeys.length}` +
        ` ragBuckets=${account.ragBuckets.length}` +
        ` ragRows=${ragRows}` +
        ` ssm=${account.ssmParameterNames.length}` +
        (account.deleting ? ' [account deletion in progress]' : ''),
    );
    for (const bucket of account.ragBuckets) {
      lines.push(`      ${bucket.bucketName} index=${bucket.indexName} rows=${bucket.rows.length}`);
    }
  }

  lines.push('');
  lines.push(`Accounts to reset: ${plan.accounts.length}`);
  lines.push(`Not provisioned in ${plan.region}: ${plan.notProvisioned}`);
  lines.push(`Access-key rows to delete: ${count(plan, (a) => a.accessKeys.length)}`);
  lines.push(`RAG buckets to clear: ${count(plan, (a) => a.ragBuckets.length)}`);
  lines.push(
    `S3 Vectors indexes to drop: ${count(plan, (a) => a.ragBuckets.length)} (bucket ${plan.vectorBucket})`,
  );
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

/** Rows naming the target region, by account and then by bucket. */
function groupRagRows(region: string, ragRows: StoredRow[]): Map<string, Map<string, StoredRow[]>> {
  const byOrg = new Map<string, Map<string, StoredRow[]>>();

  for (const row of ragRows) {
    const pk = row.pk?.S;
    if (!pk) continue;

    const parsed = parseRagPk(pk);
    if (!parsed || parsed.region !== region) continue;

    let buckets = byOrg.get(parsed.orgId);
    if (!buckets) {
      buckets = new Map<string, StoredRow[]>();
      byOrg.set(parsed.orgId, buckets);
    }
    const rows = buckets.get(parsed.bucketName);
    if (rows) rows.push(row);
    else buckets.set(parsed.bucketName, [row]);
  }

  return byOrg;
}

/** One account's buckets, removed from the map so the leftovers are the orphans. */
function takeRagBuckets(
  ragByOrg: Map<string, Map<string, StoredRow[]>>,
  orgId: string,
  region: string,
): RagBucketPlan[] {
  const buckets = ragByOrg.get(orgId);
  if (!buckets) return [];
  ragByOrg.delete(orgId);
  return bucketPlans(buckets, orgId, region);
}

function bucketPlans(
  buckets: Map<string, StoredRow[]>,
  orgId: string,
  region: string,
): RagBucketPlan[] {
  return [...buckets].map(([bucketName, rows]) => ({
    bucketName,
    indexName: ragIndexName(orgId, region, bucketName),
    rows,
  }));
}
