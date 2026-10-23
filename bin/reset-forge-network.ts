#!/usr/bin/env node

// Usage: node bin/reset-forge-network.ts --network <staging|dev> --stage <stage>
//                [--dry-run] [--yes] [--backup <path>]
//
// Deletes every Forge tenant one stage owns on one Forge network, and resets
// the stage's FilOne state for the network's region, so the next console
// request runs tenant setup from scratch. Use it to start a stage over on a
// network, or after the network itself was wiped or re-deployed.
//
// Forge has no endpoint that lists tenants, and other stages and products
// share the network, so the tenants come from the stage's UserInfoTable: each
// account's `{orchestratorId}TenantId` on its PROFILE row. Only tenants
// FilOne provisioned for this stage are touched. Accounts whose deletion is in
// progress are included.
//
// Each Forge network serves one FilOne region today: `staging` is eu-central-3,
// `dev` is us-east-9 (bin/lib/forge-network.ts). For each account the run first
// disables and deletes its Forge tenant, retrying with backoff; a tenant that
// is already gone counts as deleted. Then it resets the account's FilOne state
// exactly as bin/reset-region-provisioning.ts does; that script's header
// describes what is deleted and in which order. An account whose tenant
// deletion fails after the retries keeps all of its FilOne state, so a re-run
// retries it. The run continues with the next account, lists the failures at
// the end and exits 1.
//
// Production is refused before the first AWS call.
//
// Credentials: table and function names come from `sst state export`, and
// every AWS call uses your ambient credentials, so confirm they target the
// right account first. The Management API URL is read from the deployed
// AccountDeletionWorker's environment, and the token from the stage's SST
// secret (ForgeManagementApiToken or ForgeDevManagementApiToken). The token is
// never printed or written to the backup. Besides what
// reset-region-provisioning.ts needs, the role must call
// lambda:GetFunctionConfiguration and read the stage's SST secrets.
//
// The run scans, prints the plan, writes a JSON backup (`--dry-run` included;
// same format as reset-region-provisioning.ts plus `network` and
// `managementApiUrl`), and asks for confirmation: type `yes` to apply. `--yes`
// skips the prompt, `--dry-run` prints the plan and exits without prompting,
// and a run carrying both stays a dry run. The backup cannot bring a deleted
// Forge tenant back.
//
//   node bin/reset-forge-network.ts --network dev --stage $USER --dry-run
//   node bin/reset-forge-network.ts --network staging --stage staging

import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { SSMClient } from '@aws-sdk/client-ssm';
import { extractApiMessage } from '@filone/backend/src/lib/orchestrator/api-message.ts';
import { FilOneOrchestrator } from '@filone/backend/src/lib/orchestrator/orchestrator.ts';
import { ORCHESTRATOR_ID_BY_REGION } from '@filone/backend/src/lib/service-orchestrator-ids.ts';
import { createClient } from '@filone/orchestrator-client';
import { getS3Endpoint } from '@filone/shared';
import { FORGE_NETWORKS, isForgeNetworkName, resolveForgeApi } from './lib/forge-network.ts';
import type { AccountPlan } from './lib/region-reset.ts';
import { assertRegionAllowed } from './lib/region-reset.ts';
import { runRegionReset } from './lib/region-reset-run.ts';
import { requireAwsProfile } from './lib/sst-state.ts';
import {
  assertStageResources,
  awsRegionForStage,
  exportStageState,
  resolveStageTables,
} from './lib/stage.ts';

const USAGE =
  'Usage: node bin/reset-forge-network.ts --network <network> --stage <stage> [--dry-run] [--yes] [--backup <path>]';

const args = parseCommandLine();

const dryRun = args['dry-run'] ?? false;
// A run carrying both stays a dry run: the flag that refuses to write wins.
const skipPrompt = (args.yes ?? false) && !dryRun;
const stage = args.stage ?? usage('Missing required --stage.');
const networkName = args.network ?? usage('Missing required --network.');
if (!isForgeNetworkName(networkName)) usage(`Unknown network: ${networkName}`);

const network = FORGE_NETWORKS[networkName];
const region = network.region;

// Before any AWS work: a stage the script refuses costs a message instead of a
// state export.
try {
  assertRegionAllowed(stage, region);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const orchestratorId = ORCHESTRATOR_ID_BY_REGION[region];

// Keep in sync with the RagVectorBucket name in sst.config.ts.
const vectorBucket = `filone-${stage}-rag-vectors`;

const backupPath =
  args.backup ??
  `forge-network-backup-${stage}-${networkName}-${new Date().toISOString().replaceAll(':', '-')}.json`;

requireAwsProfile();

const resources = exportStageState(stage);
const tables = resolveStageTables(
  stage,
  { userInfo: '::UserInfoTableTable', ragIndexer: '::RagIndexerTableTable' },
  resources,
);
assertStageResources(stage, tables);

const awsRegion = awsRegionForStage(stage);
const forgeApi = await resolveForgeApi(
  stage,
  network,
  resources,
  new LambdaClient({ region: awsRegion }),
);

const orchestrator = new FilOneOrchestrator({
  id: orchestratorId,
  region,
  stage,
  // Unused by deleteTenant; required by the config.
  s3EndpointUrl: forgeApi.s3EndpointUrl ?? getS3Endpoint(region, stage),
  // A pre-built client skips the metrics instrumentation the Lambdas get.
  api: { client: createClient({ baseUrl: forgeApi.baseUrl, auth: () => forgeApi.token }) },
});

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Deleting the Forge tenants on network "${networkName}" and ` +
    `un-provisioning region ${region} (orchestrator "${orchestratorId}", attribute ${orchestratorId}TenantId)`,
);
console.log(`  stage=${stage} awsRegion=${awsRegion}`);
console.log(`  Management API=${forgeApi.baseUrl}`);
console.log(`  UserInfoTable=${tables.userInfo} RagIndexerTable=${tables.ragIndexer}`);
console.log(`  vector bucket=${vectorBucket}`);
console.log('');

let tenantsDeleted = 0;

const failures = await runRegionReset(
  {
    stage,
    region,
    orchestratorId,
    awsRegion,
    tables,
    vectorBucket,
    dynamo: new DynamoDBClient({ region: awsRegion }),
    ssm: new SSMClient({ region: awsRegion }),
    s3vectors: new S3VectorsClient({ region: awsRegion }),
  },
  {
    backupPath,
    dryRun,
    skipPrompt,
    confirmQuestion: `Delete the Forge tenants and reset ${region} in stage "${stage}"?`,
    backupFields: { network: networkName, managementApiUrl: forgeApi.baseUrl },
    beforeAccount: deleteForgeTenant,
    summarize: () => [`Forge tenants deleted: ${tenantsDeleted}`],
  },
);

process.exit(failures.length > 0 ? 1 : 0);

/**
 * Disable and delete the account's tenant; deleteTenant retries, and treats a
 * tenant that is already gone as deleted. An account with only dangling rows
 * and no tenant id has nothing upstream.
 */
async function deleteForgeTenant(account: AccountPlan): Promise<void> {
  if (!account.tenantId) return;
  try {
    await orchestrator.deleteTenant(account.tenantId);
  } catch (err) {
    throw new Error(describeForgeError(err));
  }
  tenantsDeleted++;
  console.log(`      deleted Forge tenant ${account.tenantId}`);
}

/**
 * The orchestrator's message plus the API's own, from the `{ message }` body
 * it attaches as the cause. Request headers, which carry the token, are never
 * part of either.
 */
function describeForgeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const apiMessage = extractApiMessage(err.cause);
  return apiMessage ? `${err.message}: ${apiMessage}` : err.message;
}

/**
 * The command line, or usage and exit 1.
 *
 * Strict parsing stops the run on an unrecognized `--` argument: a misspelled
 * `--dry-run` that is silently ignored is the worst possible place to be quiet.
 */
function parseCommandLine() {
  try {
    return parseArgs({
      options: {
        network: { type: 'string' },
        stage: { type: 'string' },
        backup: { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
}

function usage(message: string): never {
  console.error(message);
  console.error(USAGE);
  console.error(`Networks: ${Object.keys(FORGE_NETWORKS).join(', ')}`);
  process.exit(1);
}
