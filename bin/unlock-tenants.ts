#!/usr/bin/env node

// Usage: ./bin/unlock-tenants.ts --stage <name> --org-id <orgId> [--execute]
//
// Sets one org's tenant to `active` in every region it is provisioned in,
// lifting a write-lock or a disable: the trial limit's lock, a grace period's,
// or one left behind when the org moved to manual billing.
//
// It runs the backend's own status sync (syncTenantStatusInProvisionedRegions),
// so each region is probed first, updated only when it differs, and retried
// through a transient outage. The orchestrator URLs come from the deployed
// AccountDeletionWorker's environment and the tokens from the stage's SST
// secrets, held in memory only. Works on every stage, production included.
//
// Unlocking does not change billing. An org that is still trialing over its
// limits, or in a grace period, is locked again by the usage or grace-period job
// on its next run; the run warns when that applies. Move it to manual billing
// first with bin/set-manual-billing.ts.
//
// DRY RUN BY DEFAULT: prints each region's tenant and current status. --execute
// unlocks, and exits 1 when any region fails.
//
//   ./bin/unlock-tenants.ts --stage production --org-id <orgId>
//   ./bin/unlock-tenants.ts --stage production --org-id <orgId> --execute 2>&1 | tee unlock.log
//
// Your AWS role needs DynamoDB read, lambda:GetFunctionConfiguration and read
// access to the stage's SST secrets.

import { parseCli } from './lib/args.ts';

const cli = parseCli({
  script: './bin/unlock-tenants.ts',
  options: ['--org-id'],
  help: ['--org-id <orgId>  Required. The org whose tenants to set active.'],
  runbook: 'bin/README.md',
});

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SubscriptionKeys } from '@filone/backend/src/lib/subscription-store.ts';
import { applyShellOverrides, readLambdaEnv, readStageSecret } from './lib/forge-network.ts';
import {
  assertStageResources,
  awsRegionForStage,
  exportStageState,
  findResourceName,
  resolveStageTables,
} from './lib/stage.ts';
import {
  ORCHESTRATOR_ENV_NAMES,
  orchestratorProcessEnv,
  orchestratorSecrets,
  summarizeOutcomes,
  unlockWarnings,
} from './lib/tenant-unlock.ts';

const orgId = cli.option('--org-id');
if (!orgId) {
  console.error('--org-id is required. Run with --help for usage.');
  process.exit(1);
}

const resources = exportStageState(cli.stage);
const tables = resolveStageTables(
  cli.stage,
  { UserInfoTable: '::UserInfoTableTable', BillingTable: '::BillingTableTable' },
  resources,
);
const workerFunction = findResourceName(
  resources,
  'aws:lambda/function:Function',
  '::AccountDeletionWorkerFunction',
);
if (!workerFunction) {
  console.error(
    `No AccountDeletionWorker function in the exported state for stage "${cli.stage}".`,
  );
  process.exit(1);
}
assertStageResources(cli.stage, { ...tables, AccountDeletionWorker: workerFunction });

const awsRegion = awsRegionForStage(cli.stage);
const lambdaEnv = applyShellOverrides(
  await readLambdaEnv(new LambdaClient({ region: awsRegion }), workerFunction, [
    ...ORCHESTRATOR_ENV_NAMES,
  ]),
  process.env,
);
if (lambdaEnv.FILONE_STAGE !== cli.stage) {
  console.error(
    `${workerFunction} runs as stage "${lambdaEnv.FILONE_STAGE}", not "${cli.stage}". Nothing was changed.`,
  );
  process.exit(1);
}

const secrets = Object.fromEntries(
  orchestratorSecrets(lambdaEnv).map((name) => [name, readStageSecret(cli.stage, name)]),
);
// Before the backend modules load: `Resource` reads the environment once, on
// first access.
Object.assign(
  process.env,
  orchestratorProcessEnv({
    stage: cli.stage,
    lambdaEnv,
    secrets,
    userInfoTable: tables.UserInfoTable,
  }),
  { AWS_REGION: awsRegion },
);
const { getProvisionedRegions, syncTenantStatusInProvisionedRegions } =
  await import('@filone/backend/src/lib/region-helpers.ts');
const { isOrgDeletedOrDeleting } = await import('@filone/backend/src/lib/org-profile.ts');

console.log(`${cli.execute ? 'EXECUTE' : 'DRY-RUN'} — set tenants active`);
console.log(`  stage: ${cli.stage} (${awsRegion})`);
console.log(`  org:   ${orgId}`);

if (await isOrgDeletedOrDeleting(orgId)) {
  console.error('Refused: the org is being deleted, or has no profile. Nothing was changed.');
  process.exit(1);
}

const { Item: billingRow } = await new DynamoDBClient({ region: awsRegion }).send(
  new GetItemCommand({
    TableName: tables.BillingTable,
    Key: { pk: { S: SubscriptionKeys.orgPk(orgId) }, sk: { S: SubscriptionKeys.sk() } },
    ProjectionExpression: 'subscriptionStatus',
    ConsistentRead: true,
  }),
);
const billingStatus = billingRow?.subscriptionStatus?.S;
console.log(`  billing status: ${billingStatus ?? '(none)'}\n`);

const regions = await getProvisionedRegions(orgId, { consistent: true });
if (regions.length === 0) {
  console.error('Refused: the org has no provisioned region. Nothing was changed.');
  process.exit(1);
}
for (const { orchestrator, tenantId } of regions) {
  const probe = await orchestrator.getTenantStatus(tenantId);
  const status = probe.kind === 'ok' ? probe.status : probe.kind;
  console.log(`  ${orchestrator.id}  ${tenantId}  ${status}`);
}
for (const warning of unlockWarnings(billingStatus)) console.log(`\nWARNING: ${warning}`);
console.log('');

if (!cli.execute) {
  console.log('Dry run only — nothing was changed. Re-run with --execute to unlock.');
  process.exit(0);
}

const { lines, failed } = summarizeOutcomes(
  await syncTenantStatusInProvisionedRegions(orgId, 'active', { consistent: true }),
);
console.log('Result:');
for (const line of lines) console.log(line);
if (failed) {
  console.error(
    '\nNot every region was unlocked. Re-run to retry an error; a not-found tenant needs investigating.',
  );
  process.exit(1);
}
console.log('\nDone.');
