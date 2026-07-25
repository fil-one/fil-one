import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LanceVectorStore, type LanceStorageContext } from './lance-vector-store.js';
import { companionBucketName } from './bucket-object-vector-store.js';
import { EMBEDDING_DIMENSION } from './constants.js';
import { startTestS3Server, type TestS3Server } from './test-s3-server.js';

const ORG = 'org-1';
const REGION = 'eu-west-1';
const BUCKET = 'docs';

let server: TestS3Server;
let root: string;

/** A deterministic unit vector: all weight on `axis`. */
function unit(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  v[axis] = 1;
  return v;
}

function chunk(key: string, axis: number, text = key) {
  return { key, text, metadata: { objectKey: key.split('#')[0] }, embedding: unit(axis) };
}

function makeStore(overrides: Partial<LanceStorageContext> = {}) {
  const storage: LanceStorageContext = {
    endpointUrl: server.url,
    region: 'us-east-1',
    credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    forcePathStyle: true,
    ...overrides,
  };
  return new LanceVectorStore(storage, {
    ensureBucket: async (name) => {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    },
    // Keep tests small: no ANN index is trained, so results are exact.
    indexThreshold: Number.POSITIVE_INFINITY,
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lance-store-'));
  server = await startTestS3Server({ root });
});

afterAll(async () => {
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(root, companionBucketName(ORG, REGION, BUCKET)), {
    recursive: true,
    force: true,
  });
  server.reset();
});

describe('LanceVectorStore', () => {
  it('writes the dataset into the companion bucket for the (org, region, bucket) triple', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [chunk('a.txt#0', 0)]);

    const companion = companionBucketName(ORG, REGION, BUCKET);
    expect(companion.startsWith('filone-rag-')).toBe(true);
    expect(fs.existsSync(path.join(root, companion, 'lance'))).toBe(true);
    // Nothing was written anywhere else.
    expect(fs.readdirSync(root)).toEqual([companion]);
  });

  it('returns nearest neighbours ordered closest-first with cosine distance', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [
      chunk('a.txt#0', 0, 'alpha'),
      chunk('b.txt#0', 1, 'bravo'),
      chunk('c.txt#0', 2, 'charlie'),
    ]);

    const results = await store.query(ORG, REGION, BUCKET, { embedding: unit(1), k: 3 });

    expect(results).toHaveLength(3);
    expect(results[0]?.key).toBe('b.txt#0');
    expect(results[0]?.text).toBe('bravo');
    // Exact match on a unit vector: cosine distance 0. The other two are
    // orthogonal to the query and to each other, so they tie at 1 — assert the
    // scores rather than an arbitrary tie-break order.
    expect(results[0]?.score).toBeCloseTo(0, 5);
    expect(results[1]?.score).toBeCloseTo(1, 5);
    expect(results[2]?.score).toBeCloseTo(1, 5);
    expect(results.map((r) => r.key).sort()).toEqual(['a.txt#0', 'b.txt#0', 'c.txt#0']);
    // Ordered closest-first regardless.
    expect(results[0]!.score).toBeLessThanOrEqual(results[1]!.score);
  });

  it('round-trips metadata', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [
      { key: 'a.txt#0', text: 'x', metadata: { objectKey: 'a.txt', page: 4 }, embedding: unit(0) },
    ]);

    const [result] = await store.query(ORG, REGION, BUCKET, { embedding: unit(0), k: 1 });

    expect(result?.metadata).toEqual({ objectKey: 'a.txt', page: 4 });
  });

  it('scopes a query to one object when filtered by objectKey', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [
      chunk('a.txt#0', 0),
      chunk('a.txt#1', 1),
      chunk('b.txt#0', 2),
    ]);

    const results = await store.query(ORG, REGION, BUCKET, {
      embedding: unit(2),
      k: 5,
      filters: { objectKey: 'a.txt' },
    });

    expect(results.map((r) => r.key).sort()).toEqual(['a.txt#0', 'a.txt#1']);
  });

  it('overwrites a chunk on re-upsert rather than duplicating it', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [chunk('a.txt#0', 0, 'first')]);
    await store.upsertChunks(ORG, REGION, BUCKET, [chunk('a.txt#0', 0, 'second')]);

    const results = await store.query(ORG, REGION, BUCKET, { embedding: unit(0), k: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe('second');
  });

  it('deletes chunks by key', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [chunk('a.txt#0', 0), chunk('a.txt#1', 1)]);

    await store.deleteChunks(ORG, REGION, BUCKET, ['a.txt#0']);
    const results = await store.query(ORG, REGION, BUCKET, { embedding: unit(0), k: 10 });

    expect(results.map((r) => r.key)).toEqual(['a.txt#1']);
  });

  it('escapes quotes in keys rather than breaking the delete predicate', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [
      chunk("o'brien.txt#0", 0),
      chunk('safe.txt#0', 1),
    ]);

    await store.deleteChunks(ORG, REGION, BUCKET, ["o'brien.txt#0"]);
    const results = await store.query(ORG, REGION, BUCKET, { embedding: unit(0), k: 10 });

    expect(results.map((r) => r.key)).toEqual(['safe.txt#0']);
  });

  it('returns [] for a bucket that has never been indexed', async () => {
    const store = makeStore();

    const results = await store.query(ORG, REGION, 'never-indexed', {
      embedding: unit(0),
      k: 3,
    });

    expect(results).toEqual([]);
  });

  it('is idempotent on ensureIndex', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [chunk('a.txt#0', 0)]);
    await store.ensureIndex(ORG, REGION, BUCKET);

    const results = await store.query(ORG, REGION, BUCKET, { embedding: unit(0), k: 10 });
    expect(results).toHaveLength(1);
  });

  it('drops the dataset but leaves the companion bucket in place', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    await store.upsertChunks(ORG, REGION, BUCKET, [chunk('a.txt#0', 0)]);

    await store.dropIndex(ORG, REGION, BUCKET);

    expect(fs.existsSync(path.join(root, companionBucketName(ORG, REGION, BUCKET)))).toBe(true);
    expect(await store.query(ORG, REGION, BUCKET, { embedding: unit(0), k: 3 })).toEqual([]);
  });

  it('tolerates dropIndex on a bucket that was never indexed', async () => {
    const store = makeStore();
    await expect(store.dropIndex(ORG, REGION, 'never-indexed')).resolves.toBeUndefined();
  });

  it('rejects an embedding of the wrong dimension', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);

    await expect(
      store.upsertChunks(ORG, REGION, BUCKET, [
        { key: 'a.txt#0', text: 'x', metadata: {}, embedding: [1, 2, 3] },
      ]),
    ).rejects.toThrow(/3 dimensions, expected 1024/);
  });

  it('rejects metadata over the 40KB parity limit', async () => {
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);

    await expect(
      store.upsertChunks(ORG, REGION, BUCKET, [
        { key: 'a.txt#0', text: 'x', metadata: { blob: 'y'.repeat(41_000) }, embedding: unit(0) },
      ]),
    ).rejects.toThrow(/exceeding the 40960 byte limit/);
  });

  describe('against a provider that does not support conditional writes', () => {
    // This is the compatibility question for Aurora/FTH. Lance commits a dataset
    // by writing its manifest with `If-None-Match: *` — exactly one conditional
    // PUT per commit. Reads never use one. So a provider lacking conditional
    // write support can serve queries but cannot host the indexer.
    let strict: TestS3Server;

    beforeAll(async () => {
      // Same backing directory as the permissive server, so a dataset written
      // through `server` is readable through `strict`.
      strict = await startTestS3Server({ root, rejectConditionalWrites: true });
    });

    afterAll(async () => {
      await strict.close();
    });

    function strictStore() {
      return new LanceVectorStore(
        {
          endpointUrl: strict.url,
          region: 'us-east-1',
          credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
          forcePathStyle: true,
        },
        { indexThreshold: Number.POSITIVE_INFINITY },
      );
    }

    it('serves queries — the read path needs no conditional writes', async () => {
      const writer = makeStore();
      await writer.ensureIndex(ORG, REGION, BUCKET);
      await writer.upsertChunks(ORG, REGION, BUCKET, [chunk('a.txt#0', 0), chunk('b.txt#0', 1)]);

      strict.reset();
      const results = await strictStore().query(ORG, REGION, BUCKET, {
        embedding: unit(1),
        k: 2,
      });

      expect(results[0]?.key).toBe('b.txt#0');
      expect(strict.stats.refused).toEqual([]);
    });

    it('cannot index — the commit path requires a conditional PUT of the manifest', async () => {
      const store = strictStore();

      await expect(store.ensureIndex(ORG, REGION, 'strict-write-target')).rejects.toThrow();
      expect(strict.stats.refused.some((r) => r.includes('.manifest'))).toBe(true);
    });
  });

  it('queries with ranged reads and no writes', async () => {
    // The byte-volume claim is measured at realistic scale by `spike/lance-probe`
    // — at unit-test size there are too few rows to train an ANN index, so a
    // query is a flat scan either way. What this asserts is the mechanism.
    const store = makeStore();
    await store.ensureIndex(ORG, REGION, BUCKET);
    const chunks = Array.from({ length: 200 }, (_, i) =>
      chunk(`doc-${Math.floor(i / 10)}.txt#${i % 10}`, i % EMBEDDING_DIMENSION),
    );
    await store.upsertChunks(ORG, REGION, BUCKET, chunks);

    server.reset();
    await store.query(ORG, REGION, BUCKET, { embedding: unit(3), k: 5 });

    // Ranged reads are the mechanism the byte reduction depends on.
    expect(server.stats.requests.some((r) => r.ranged === true)).toBe(true);
    // And a query is reads only — no writes on the query path.
    expect(server.stats.requests.every((r) => r.op === 'GET' || r.op === 'ListObjectsV2')).toBe(
      true,
    );
  });
});
