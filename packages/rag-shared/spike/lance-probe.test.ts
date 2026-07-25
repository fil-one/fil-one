// Head-to-head: BucketObjectVectorStore (JSON blobs, brute force) vs
// LanceVectorStore (Lance dataset, IVF-PQ), both against the same S3-compatible
// server, so the byte counts are measured rather than estimated.
//
// Skipped by default — it writes tens of MB and takes a minute. Run it with:
//
//   RAG_SPIKE=1 pnpm --filter @filone/rag-shared exec vitest run spike/lance-probe.test.ts
//
// Set N to vary corpus size (default 10000 chunks ≈ 3,000 pages of text).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BucketObjectVectorStore } from '../src/bucket-object-vector-store.js';
import { LanceVectorStore } from '../src/lance-vector-store.js';
import { EMBEDDING_DIMENSION } from '../src/constants.js';
import { startTestS3Server, type TestS3Server } from '../src/test-s3-server.js';
import type { VectorStoreChunk } from '../src/schemas.js';

const N = Number(process.env.N ?? 10_000);
const ORG = 'org-1';
const REGION = 'eu-west-1';
const CHUNKS_PER_OBJECT = 20;

let server: TestS3Server;
let root: string;

function randomUnitVector(): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    v[i] = Math.random() * 2 - 1;
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) v[i]! /= norm;
  return v;
}

function corpus(): VectorStoreChunk[] {
  return Array.from({ length: N }, (_, i) => {
    const objectKey = `doc-${Math.floor(i / CHUNKS_PER_OBJECT)}.pdf`;
    return {
      key: `${objectKey}#${i % CHUNKS_PER_OBJECT}`,
      // ~1 KB, the chunker's default target.
      text: 'lorem ipsum '.repeat(84),
      metadata: { objectKey },
      embedding: randomUnitVector(),
    };
  });
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lance-probe-'));
  server = await startTestS3Server({ root });
});

afterAll(async () => {
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!process.env.RAG_SPIKE)('vector store comparison', () => {
  it(`compares query cost over ${N} chunks`, async () => {
    const chunks = corpus();
    const ensureBucket = async (name: string) => {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    };

    // ── brute force ────────────────────────────────────────────────────
    const s3 = new S3Client({
      endpoint: server.url,
      region: 'us-east-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
      forcePathStyle: true,
    });
    const blobStore = new BucketObjectVectorStore(s3, { ensureBucket });
    await blobStore.ensureIndex(ORG, REGION, 'blob-bucket');
    const blobWriteStart = Date.now();
    await blobStore.upsertChunks(ORG, REGION, 'blob-bucket', chunks);
    const blobWriteMs = Date.now() - blobWriteStart;

    server.reset();
    const blobQueryStart = Date.now();
    const blobResults = await blobStore.query(ORG, REGION, 'blob-bucket', {
      embedding: randomUnitVector(),
      k: 10,
    });
    const blobQueryMs = Date.now() - blobQueryStart;
    const blobBytes = server.stats.bytesOut;
    const blobRequests = server.stats.requests.length;

    // ── lance ──────────────────────────────────────────────────────────
    const lanceStore = new LanceVectorStore(
      {
        endpointUrl: server.url,
        region: 'us-east-1',
        credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
        forcePathStyle: true,
      },
      { ensureBucket, indexThreshold: 1_000 },
    );
    await lanceStore.ensureIndex(ORG, REGION, 'lance-bucket');
    const lanceWriteStart = Date.now();
    await lanceStore.upsertChunks(ORG, REGION, 'lance-bucket', chunks);
    const lanceWriteMs = Date.now() - lanceWriteStart;

    server.reset();
    const lanceQueryStart = Date.now();
    const lanceResults = await lanceStore.query(ORG, REGION, 'lance-bucket', {
      embedding: randomUnitVector(),
      k: 10,
    });
    const lanceQueryMs = Date.now() - lanceQueryStart;
    const lanceBytes = server.stats.bytesOut;
    const lanceRequests = server.stats.requests.length;

    console.log(`
┌─ ${N} chunks (~${((N * 1000) / 1e6).toFixed(1)} MB of source text), k=10
│
│  BucketObjectVectorStore (brute force over JSON blobs)
│    index write      ${blobWriteMs} ms
│    query            ${blobQueryMs} ms
│    bytes per query  ${mb(blobBytes)}   (${blobRequests} requests)
│
│  LanceVectorStore (IVF-PQ, ranged reads)
│    index write      ${lanceWriteMs} ms
│    query            ${lanceQueryMs} ms
│    bytes per query  ${mb(lanceBytes)}   (${lanceRequests} requests)
│
└─ reduction: ${(blobBytes / Math.max(lanceBytes, 1)).toFixed(0)}x fewer bytes per query
`);

    expect(blobResults).toHaveLength(10);
    expect(lanceResults).toHaveLength(10);
    // The point of the exercise.
    expect(lanceBytes).toBeLessThan(blobBytes / 5);
  });
});
