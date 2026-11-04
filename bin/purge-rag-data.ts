#!/usr/bin/env node

// Usage: node bin/purge-rag-data.ts --stage <stage> [--execute]
//
// Deletes what Bucket Intelligence and its RAG API keys left on a stage after
// their removal deployed: the RAG rows in UserInfoTable (see
// bin/lib/rag-purge.ts for the shapes), every index in the S3 Vectors bucket
// and the bucket itself, and the RagIndexerTable. The embeddings in those
// indexes are derived from customer objects, so production has to be purged by
// hand: it retains removed resources rather than deleting them.
//
// On any other stage the deploy already deleted the bucket and the table, so
// the run finds only the UserInfoTable rows.
//
// Run it after the removal deployed. The indexer cron writes to both resources
// until then, and the run refuses a stage whose state still lists them. The
// retained resources are no longer in SST state, so they are found by the
// names sst.config.ts gave them.
//
// Dry run by default: the run prints what it would delete. `--execute`
// deletes. Every step skips what is already gone, so a re-run is safe.
//
// Credentials: the UserInfoTable name comes from `sst state export`, and every
// AWS call uses your ambient credentials, as in orgs-beta.ts, so confirm they
// target the right account first. Applying needs dynamodb:DeleteItem on
// UserInfoTable, dynamodb:DeleteTable on the RagIndexerTable, and
// s3vectors:ListIndexes, DeleteIndex and DeleteVectorBucket.

import {
  DeleteItemCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  paginateListTables,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteIndexCommand,
  DeleteVectorBucketCommand,
  S3VectorsClient,
  paginateListIndexes,
} from '@aws-sdk/client-s3vectors';
import { parseCli } from './lib/args.ts';
import { scanAll } from './lib/dynamo.ts';
import { isRagUserInfoRow, ragIndexerTablePrefix, ragVectorBucketName } from './lib/rag-purge.ts';
import { exportStageState } from './lib/stage.ts';
import { findTable, requireAwsProfile } from './lib/sst-state.ts';

const { stage, execute } = parseCli({ script: 'node bin/purge-rag-data.ts' });

requireAwsProfile();

const resources = exportStageState(stage);
const stillDeployed = resources.filter(
  (r) => r.urn.endsWith('::RagIndexerTableTable') || r.urn.endsWith('::RagVectorBucket'),
);
if (stillDeployed.length > 0) {
  console.error(
    `Stage "${stage}" still deploys the RAG resources, so the indexer may write again after ` +
      'the purge. Deploy the removal first, then re-run.',
  );
  process.exit(1);
}

const { tableName: userInfoTable, region } = findTable(stage, '::UserInfoTableTable', resources);
const dynamo = new DynamoDBClient({ region });
const s3vectors = new S3VectorsClient({ region });

console.log(`${execute ? '' : 'DRY-RUN — '}Purging RAG data from stage "${stage}" (${region})`);

const rows = await findRagRows();
const vectorBucket = ragVectorBucketName(stage);
const indexes = await listIndexes(vectorBucket);
const ragTable = await findRagIndexerTable();

console.log(`  UserInfoTable rows: ${rows.length} in ${userInfoTable}`);
console.log(
  indexes === undefined
    ? `  Vector bucket ${vectorBucket}: already gone`
    : `  Vector bucket ${vectorBucket}: ${indexes.length} index(es)`,
);
console.log(`  RagIndexerTable: ${ragTable ?? 'already gone'}`);

if (!execute) {
  console.log('Dry run — nothing was deleted. Re-run with --execute to delete.');
  process.exit(0);
}

for (const key of rows) {
  await dynamo.send(new DeleteItemCommand({ TableName: userInfoTable, Key: key }));
}
console.log(`Deleted ${rows.length} UserInfoTable row(s).`);

if (indexes !== undefined) {
  for (const indexName of indexes) {
    await s3vectors.send(new DeleteIndexCommand({ vectorBucketName: vectorBucket, indexName }));
  }
  await s3vectors.send(new DeleteVectorBucketCommand({ vectorBucketName: vectorBucket }));
  console.log(`Deleted ${indexes.length} index(es) and the vector bucket ${vectorBucket}.`);
}

if (ragTable) {
  await dynamo.send(new DeleteTableCommand({ TableName: ragTable }));
  console.log(`Deleted the table ${ragTable}.`);
}

console.log('Done.');

/** The keys of every RAG row in UserInfoTable, read consistently. */
async function findRagRows(): Promise<Record<string, AttributeValue>[]> {
  const keys: Record<string, AttributeValue>[] = [];
  for await (const item of scanAll(dynamo, {
    TableName: userInfoTable,
    ConsistentRead: true,
    ProjectionExpression: 'pk, sk',
  })) {
    const pk = item.pk?.S;
    const sk = item.sk?.S;
    if (pk && sk && isRagUserInfoRow(pk, sk)) keys.push({ pk: item.pk!, sk: item.sk! });
  }
  return keys;
}

/** Every index in the vector bucket, or undefined when the bucket is gone. */
async function listIndexes(vectorBucketName: string): Promise<string[] | undefined> {
  const names: string[] = [];
  try {
    for await (const page of paginateListIndexes({ client: s3vectors }, { vectorBucketName })) {
      for (const index of page.indexes ?? []) if (index.indexName) names.push(index.indexName);
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') return undefined;
    throw err;
  }
  return names;
}

/**
 * The RagIndexerTable's physical name, or undefined when it is gone.
 *
 * Stops on more than one match rather than guessing which to delete, and on a
 * table with deletion protection, which the operator has to lift on purpose.
 */
async function findRagIndexerTable(): Promise<string | undefined> {
  const prefix = ragIndexerTablePrefix(stage);
  const matches: string[] = [];
  for await (const page of paginateListTables({ client: dynamo }, {})) {
    matches.push(...(page.TableNames ?? []).filter((name) => name.startsWith(prefix)));
  }
  if (matches.length > 1) {
    console.error(`More than one table starts with ${prefix}: ${matches.join(', ')}`);
    process.exit(1);
  }
  const [name] = matches;
  if (!name) return undefined;

  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: name }));
  if (Table?.DeletionProtectionEnabled) {
    console.error(`${name} has deletion protection on. Turn it off first, then re-run.`);
    process.exit(1);
  }
  return name;
}
