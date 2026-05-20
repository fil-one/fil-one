#!/usr/bin/env node

// Usage: ./bin/fth-demo.ts <orgId>
//
// Drives the Fortilyx (FTH) integration end-to-end via FthOrchestrator:
//   - ensureTenantReady creates an FTH client + service storage user +
//     service access key, and caches the credentials in SSM.
//   - bucket CRUD goes through the orchestrator (which speaks S3 against
//     the FTH S3 endpoint).
//   - object CRUD uses the credentials returned by getPresignerContext
//     (the same service "filone-console" key issued in step 1) — no new
//     access key is issued by the demo.
//
// Refuses to run against the "production" stage.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const orgId = process.argv[2];
if (!orgId) {
  console.error('Usage: ./bin/fth-demo.ts <orgId>');
  process.exit(1);
}

if (!process.env.SST_RESOURCE_App) {
  execFileSync('pnpx', ['sst', 'shell', 'node', import.meta.filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(0);
}

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { fthOrchestrator } from '../packages/backend/src/lib/fth/fth-orchestrator.js';

const PROTECTED_STAGES = ['production'];
const stage = readFileSync('.sst/stage', 'utf8').trim();
if (PROTECTED_STAGES.includes(stage)) {
  console.error(`Refusing to run FTH demo in the "${stage}" stage.`);
  process.exit(1);
}

console.log(`Stage: ${stage}`);
console.log(`Org:   ${orgId}\n`);

console.log('=== ensureTenantReady ===');
const tenantId = await fthOrchestrator.ensureTenantReady(orgId);
if (!tenantId) {
  console.error('ensureTenantReady returned null (setup not complete)');
  process.exit(1);
}
console.log(`fthTenantId: ${tenantId}\n`);

const bucketName = `f1demo-${orgId.replaceAll('-', '').slice(0, 16)}`;
const objectKey = 'hello.txt';
const objectBody = 'hello world\n';

console.log(`=== createBucket: ${bucketName} ===`);
await fthOrchestrator.createBucket({ tenantId, bucketName });
console.log('created\n');

console.log('=== listBuckets ===');
const buckets = await fthOrchestrator.listBuckets(tenantId);
console.log(buckets);
const found = buckets.some((b) => b.name === bucketName);
if (!found) {
  console.error(`Bucket ${bucketName} did not appear in listBuckets`);
  process.exit(1);
}
console.log();

console.log(`=== getBucket: ${bucketName} ===`);
const bucket = await fthOrchestrator.getBucket(tenantId, bucketName);
console.log(bucket);
console.log();

if (!bucket) {
  console.error(`getBucket did not find bucket ${bucketName}`);
  process.exit(1);
}

console.log('=== Object CRUD via getPresignerContext ===');
const ctx = await fthOrchestrator.getPresignerContext(tenantId);
const s3 = new S3Client({
  endpoint: ctx.endpointUrl,
  region: ctx.region,
  credentials: ctx.credentials,
  forcePathStyle: ctx.forcePathStyle,
});

console.log(`--- PutObject: ${objectKey} ---`);
await s3.send(
  new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: objectBody,
    ContentType: 'text/plain',
  }),
);
console.log('uploaded');

console.log(`--- ListObjectsV2 ---`);
const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucketName }));
console.log((objects.Contents ?? []).map((o) => ({ key: o.Key, size: o.Size })));

console.log(`--- GetObject: ${objectKey} ---`);
const getResp = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
const body = await getResp.Body?.transformToString();
console.log(`body: ${JSON.stringify(body)}`);
if (body !== objectBody) {
  console.error(`Downloaded body did not match uploaded body`);
  process.exit(1);
}

console.log(`--- DeleteObject: ${objectKey} ---`);
await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }));
console.log('deleted\n');

console.log(`=== deleteBucket: ${bucketName} ===`);
await fthOrchestrator.deleteBucket(tenantId, bucketName);
console.log('deleted\n');

console.log('=== Demo complete ===');
