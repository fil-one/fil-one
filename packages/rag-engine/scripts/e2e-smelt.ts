// End-to-end check of a running engine against a local smelt Forge network.
// Opt-in: does nothing unless RAG_ENGINE_E2E=1.
//
//   cd fil-forge/smelt && INGOT_REGION=us-east-9 make up && make s3-key
//   TEI_IMAGE=... docker compose -f packages/rag-engine/docker-compose.local.yml up -d --build
//   RAG_ENGINE_E2E=1 node packages/rag-engine/scripts/e2e-smelt.ts
//
// Environment:
//   ENGINE_URL            default http://127.0.0.1:18080
//   ENGINE_TOKEN          default local-dev-token
//   SMELT_S3_ENDPOINT     default http://127.0.0.1:15130 (sent as target.s3.endpointUrl)
//   SMELT_REGION          default us-east-9
//   SMELT_ACCESS_KEY_ID / SMELT_SECRET_ACCESS_KEY
//                         default: read from the AWS CLI profile `smelt` (`make s3-key`)

import { execFileSync } from 'node:child_process';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  RagEngineQueryResponse,
  RagEngineStatus,
  RagEngineTarget,
  RagEngineVersionsResponse,
} from '@filone/shared';
import { buildPdf } from '@filone/rag-shared/src/test-fixtures.ts';

if (process.env.RAG_ENGINE_E2E !== '1') {
  console.log('Skipping: set RAG_ENGINE_E2E=1 to run against smelt.');
  process.exit(0);
}

const engineUrl = process.env.ENGINE_URL ?? 'http://127.0.0.1:18080';
const token = process.env.ENGINE_TOKEN ?? 'local-dev-token';
const endpoint = process.env.SMELT_S3_ENDPOINT ?? 'http://127.0.0.1:15130';
const region = process.env.SMELT_REGION ?? 'us-east-9';

function awsProfileValue(name: string): string {
  return execFileSync('aws', ['configure', 'get', '--profile', 'smelt', name], {
    encoding: 'utf8',
  }).trim();
}

const accessKeyId = process.env.SMELT_ACCESS_KEY_ID ?? awsProfileValue('aws_access_key_id');
const secretAccessKey =
  process.env.SMELT_SECRET_ACCESS_KEY ?? awsProfileValue('aws_secret_access_key');

const s3 = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
const bucketName = process.env.E2E_BUCKET ?? `rag-e2e-${Date.now().toString(36)}`;
const target: RagEngineTarget = {
  orgId: 'e2e-org',
  region,
  bucketName,
  s3: { endpointUrl: endpoint, region, accessKeyId, secretAccessKey },
};

const DOCS: Record<string, string | Uint8Array> = {
  'handbook/storage.md':
    '# Storage on Forge\n\nForge stores every object as encrypted blobs on storage providers. ' +
    'Each provider proves possession of the data on chain with PDP proofs every proving period.',
  'handbook/retrieval.txt':
    'Retrieval reads objects back through the S3 gateway. Ranged reads fetch only the blob extents that cover the range.',
  'notes/lance.md':
    'Lance is a columnar format for AI data. A Lance dataset keeps every version, so readers can time travel to an older version.',
  'reports/q3.pdf': buildPdf([
    ['Quarterly report.', 'Stored data grew to 12 petabytes across 40 providers.'],
  ]),
};

async function call<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${engineUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as T;
  if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function syncAndWait(label: string): Promise<RagEngineStatus> {
  const started = performance.now();
  await call<RagEngineStatus>('/v1/sync', { target });
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await call<RagEngineStatus>('/v1/status', { target });
    if (status.syncState === 'syncing') {
      console.log(`  [${label}] syncing`, JSON.stringify(status.progress));
      continue;
    }
    console.log(
      `  [${label}] ${status.syncState} in ${Math.round(performance.now() - started)} ms`,
    );
    if (status.syncState === 'error') throw new Error(`sync failed: ${status.lastSyncError}`);
    return status;
  }
}

async function query(
  q: string,
  searchMode: 'vector' | 'fulltext' | 'hybrid',
  version?: number,
): Promise<RagEngineQueryResponse> {
  const answer = Boolean(process.env.E2E_ANSWER);
  const result = await call<RagEngineQueryResponse>('/v1/query', {
    target,
    query: q,
    searchMode,
    topK: 3,
    answer,
    ...(version ? { version } : {}),
  });
  console.log(`\n  query "${q}" mode=${searchMode}${version ? ` version=${version}` : ''}`);
  for (const c of result.citations) {
    console.log(
      `    [${c.n}] ${c.objectKey}#${c.chunkIndex} ${c.scoreKind}=${c.score.toFixed(4)} "${c.text.slice(0, 70)}"`,
    );
  }
  console.log('    trace', JSON.stringify(result.trace));
  if (result.answer) console.log('    answer:', result.answer);
  return result;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`);
  console.log(`  ok: ${message}`);
}

async function main(): Promise<void> {
  console.log(`bucket ${bucketName} on ${endpoint} (${region}); engine ${engineUrl}`);
  await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
  for (const [key, body] of Object.entries(DOCS)) {
    await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body }));
  }

  const first = await syncAndWait('initial');
  console.log('  status', JSON.stringify(first, null, 2));
  check(first.filesIndexed === 4, 'four documents indexed');

  check(
    (await query('how do providers prove they store data', 'vector')).citations[0]?.objectKey ===
      'handbook/storage.md',
    'vector search finds the storage page',
  );
  check(
    (await query('petabytes', 'fulltext')).citations[0]?.objectKey === 'reports/q3.pdf',
    'full-text search finds the PDF',
  );
  check(
    (await query('time travel to older versions', 'hybrid')).citations[0]?.objectKey ===
      'notes/lance.md',
    'hybrid search finds the Lance note',
  );

  const before = await call<RagEngineVersionsResponse>('/v1/versions', { target });
  const pastVersion = before.versions[0]!.version;
  console.log('  versions', JSON.stringify(before.versions));

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: 'handbook/retrieval.txt',
      Body: 'Retrieval now goes through a regional cache in front of the gateway.',
    }),
  );
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: 'notes/lance.md' }));
  const second = await syncAndWait('after change');
  console.log('  status', JSON.stringify(second, null, 2));
  check(second.filesIndexed === 3, 'deleted document removed');

  check(
    (await query('regional cache', 'fulltext')).citations[0]?.objectKey ===
      'handbook/retrieval.txt',
    'changed document re-indexed',
  );
  check(
    (await query('columnar format', 'fulltext')).citations.length === 0,
    'deleted document no longer found',
  );
  const past = await query('columnar format', 'fulltext', pastVersion);
  check(
    past.citations[0]?.objectKey === 'notes/lance.md',
    `version ${pastVersion} still has the deleted document`,
  );
  console.log('\nE2E PASSED');
}

main().catch((error: unknown) => {
  console.error('E2E FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
