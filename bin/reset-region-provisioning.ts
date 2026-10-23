#!/usr/bin/env node

// Usage: node bin/reset-region-provisioning.ts --stage <stage> --region <region>
//                [--dry-run] [--yes] [--backup <path>]
//
// Un-provisions one region for every customer account in a stage, so the next
// console request re-runs tenant setup from scratch. Use it after the upstream
// orchestrator behind a region has been wiped or re-deployed (a Forge dev
// network reset), which leaves every account holding a dangling pointer to a
// tenant that no longer exists.
//
// Provisioning state for a region is a single flat attribute on the account's
// `ORG#{orgId}` / `PROFILE` row in UserInfoTable: an account is provisioned in
// a region iff `{orchestratorId}TenantId` exists, because setup writes it last.
// A personal account is an organization of one, so scanning `ORG#` covers both
// kinds. For each provisioned account the reset drops the region's S3 Vectors
// indexes and RagIndexerTable rows, deletes the region's ACCESSKEY# rows,
// deletes the region's console credentials from SSM, and removes the tenant-id
// attribute last — the inverse of setup, so an interrupted run stays resumable
// instead of orphaning state nothing can name. For eu-west-1 it also rewinds
// `auroraSetupStatus` to FILONE_ORG_CREATED and drops
// `auroraSetupFailureCount`, because Aurora's setup state machine throws on any
// other status. Regional ACCESSKEY# rows and RAG rows are planned by their own
// region, so an account whose pointer is already gone still has them deleted:
// a key minted between an earlier run's scan and its pointer removal is picked
// up by the next run.
//
// Production is refused before the first AWS call: every region there carries
// real customer data, and a reset takes the region away from every account at
// once. Every other stage allows every region the script knows.
//
// Credentials: table names come from `sst state export`, and every AWS call
// uses your ambient credentials, as in orgs-beta.ts and rag-access.ts, so
// confirm they target the right account first. Applying needs a role that can
// write UserInfoTable and RagIndexerTable, delete SSM parameters, and call
// s3vectors:GetVectorBucket and s3vectors:DeleteIndex.
//
// The run scans, prints the plan, and asks for confirmation: type `yes` to
// apply. `--yes` skips the prompt, `--dry-run` prints the plan and exits
// without prompting, and a run carrying both stays a dry run. This is the only
// interactive prompt in bin/, where every other script gates a write behind
// `--execute` alone; a reset takes a whole region away from every account in
// the stage, and the plan naming those accounts is what an operator has to read
// before saying yes. Without a TTY on stdin and without `--yes` the run exits
// rather than consuming a stray line of input.
//
// A run that finds something to reset writes a JSON backup of the state it is
// about to delete, `--dry-run` included. bin/README.md describes what the file
// holds and how a restore could be built on it.
//
// It deliberately does NOT call the orchestrators: upstream tenants, buckets
// and access keys are left in place, because the reset assumes they are already
// gone. bin/reset-forge-network.ts deletes the Forge tenants as well.
//
// There is no DynamoDB PITR, so the printed plan is the only audit trail —
// capture stdout, e.g. `| tee reset-region.log`.
//
//   node bin/reset-region-provisioning.ts --stage $USER --region eu-central-3 --dry-run
//   node bin/reset-region-provisioning.ts --stage staging --region eu-central-3

import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { SSMClient } from '@aws-sdk/client-ssm';
import {
  ORCHESTRATOR_ID_BY_REGION,
  orchestratorIdForRegion,
} from '@filone/backend/src/lib/service-orchestrator-ids.ts';
import { assertRegionAllowed } from './lib/region-reset.ts';
import { runRegionReset } from './lib/region-reset-run.ts';
import { requireAwsProfile } from './lib/sst-state.ts';
import { assertStageResources, awsRegionForStage, resolveStageTables } from './lib/stage.ts';

const USAGE =
  'Usage: node bin/reset-region-provisioning.ts --stage <stage> --region <region> [--dry-run] [--yes] [--backup <path>]';

const args = parseCommandLine();

const dryRun = args['dry-run'] ?? false;
// A run carrying both stays a dry run: the flag that refuses to write wins.
const skipPrompt = (args.yes ?? false) && !dryRun;
const stage = args.stage ?? usage('Missing required --stage.');
const region = args.region ?? usage('Missing required --region.');

// Before any AWS work: a stage or region the script refuses costs a message
// instead of a state export.
try {
  assertRegionAllowed(stage, region);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const orchestratorId = orchestratorIdForRegion(region)!;

// Keep in sync with the RagVectorBucket name in sst.config.ts.
const vectorBucket = `filone-${stage}-rag-vectors`;

const backupPath =
  args.backup ??
  `region-backup-${stage}-${region}-${new Date().toISOString().replaceAll(':', '-')}.json`;

requireAwsProfile();

const tables = resolveStageTables(stage, {
  userInfo: '::UserInfoTableTable',
  ragIndexer: '::RagIndexerTableTable',
});
assertStageResources(stage, tables);

const awsRegion = awsRegionForStage(stage);

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Un-provisioning region ${region} (orchestrator "${orchestratorId}", attribute ${orchestratorId}TenantId)`,
);
console.log(`  stage=${stage} awsRegion=${awsRegion}`);
console.log(`  UserInfoTable=${tables.userInfo} RagIndexerTable=${tables.ragIndexer}`);
console.log(`  vector bucket=${vectorBucket}`);
console.log('');

await runRegionReset(
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
    confirmQuestion: `Reset ${region} in stage "${stage}"?`,
  },
);

/**
 * The command line, or usage and exit 1.
 *
 * Strict parsing stops the run on an unrecognized `--` argument, the way
 * bin/lib/args.ts and bin/orgs-beta.ts stop on one: a misspelled `--dry-run`
 * that is silently ignored is the worst possible place to be quiet.
 */
function parseCommandLine() {
  try {
    return parseArgs({
      options: {
        stage: { type: 'string' },
        region: { type: 'string' },
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
  console.error(`Regions: ${Object.keys(ORCHESTRATOR_ID_BY_REGION).join(', ')}`);
  process.exit(1);
}
