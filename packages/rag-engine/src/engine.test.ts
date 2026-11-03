import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type {
  RagEngineQueryResponse,
  RagEngineStatus,
  RagEngineVersionsResponse,
} from '@filone/shared';
import { buildPdf } from '@filone/rag-shared/src/test-fixtures.ts';
import { afterEach, describe, expect, it } from 'vitest';

import { connectDataset } from './lance-store.ts';
import { TABLE_NAME, companionBucketName, storageFor } from './storage.ts';
import { startHarness, type Harness } from './testing/harness.ts';

const DOCS = {
  'animals/cats.txt': 'Cats are small carnivorous mammals. A cat sleeps most of the day and purrs.',
  'animals/dogs.md':
    '# Dogs\n\nDogs are loyal companions. A dog barks and fetches sticks in the park.',
  'space/mars.txt': 'Mars is the fourth planet from the sun. Its red colour comes from iron oxide.',
};

let h: Harness | undefined;

async function harness(options?: Parameters<typeof startHarness>[0]): Promise<Harness> {
  h = await startHarness(options);
  return h;
}

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function seed(harness: Harness): void {
  for (const [key, body] of Object.entries(DOCS)) harness.putSource(key, body);
}

function query(harness: Harness, body: Record<string, unknown>) {
  return harness.call<RagEngineQueryResponse>('/v1/query', {
    target: harness.target,
    answer: false,
    ...body,
  });
}

describe('sync', () => {
  it('indexes every supported object into the companion bucket', async () => {
    const t = await harness();
    seed(t);
    t.putSource('photo.png', 'not text');
    const status = await t.syncAndWait();
    expect(status.syncState).toBe('idle');
    expect(status.lastSyncedAt).toBeDefined();
    expect(status.filesIndexed).toBe(3);
    expect(status.indexedBytes).toBe(
      Object.values(DOCS).reduce((sum, body) => sum + Buffer.byteLength(body), 0),
    );
    const companion = companionBucketName('org-1', 'us-east-9', 'docs');
    expect(status.dataset).toMatchObject({
      uri: `s3://${companion}/lance/chunks.lance`,
      companionBucket: companion,
      table: 'chunks',
      rows: 3,
      objects: 3,
      embedding: { model: 'fake-bow-64', dimension: 64 },
    });
    expect(status.dataset?.indexes.map((i) => i.type)).toContain('FTS');
    expect(fs.existsSync(path.join(t.root, companion, 'lance', 'chunks.lance'))).toBe(true);
    // Nothing was written to the source bucket.
    const writes = t.s3.stats.requests.filter((r) => r.op === 'PUT' && r.bucket === 'docs');
    expect(writes).toEqual([]);
  });

  it('extracts PDFs', async () => {
    const t = await harness();
    t.putSource('report.pdf', buildPdf([['Quarterly storage report: usage grew strongly.']]));
    const status = await t.syncAndWait();
    expect(status.filesIndexed).toBe(1);
    const result = await query(t, {
      query: 'storage report',
      searchMode: 'fulltext',
    });
    expect(result.body.citations[0]?.objectKey).toBe('report.pdf');
  });

  it('adds new, replaces changed and removes deleted objects', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();

    t.putSource('animals/cats.txt', 'Cats were replaced by tigers. Tigers have stripes.');
    t.deleteSource('space/mars.txt');
    t.putSource('space/venus.txt', 'Venus is the hottest planet in the solar system.');
    const status = await t.syncAndWait();

    expect(status.filesIndexed).toBe(3);
    const keys = (await query(t, { query: 'planet', searchMode: 'vector', topK: 10 })).body.sources;
    expect(keys.sort()).toEqual(['animals/cats.txt', 'animals/dogs.md', 'space/venus.txt']);
    const cats = await query(t, {
      query: 'tigers stripes',
      searchMode: 'fulltext',
    });
    expect(cats.body.citations[0]?.text).toContain('Tigers have stripes');
    const old = await query(t, { query: 'purrs', searchMode: 'fulltext' });
    expect(old.body.citations).toEqual([]);
  });

  it('does nothing on a second sync with no changes', async () => {
    const t = await harness();
    seed(t);
    const first = await t.syncAndWait();
    const calls = t.embedder.calls;
    t.s3.reset();
    const second = await t.syncAndWait();
    expect(t.embedder.calls).toBe(calls);
    expect(second.dataset?.version).toBe(first.dataset?.version);
    // No CreateBucket, no state write, no commit: only reads.
    const writes = t.s3.stats.requests.filter(
      (r) => !['GET', 'HEAD', 'HeadBucket', 'ListObjectsV2'].includes(r.op),
    );
    expect(writes).toEqual([]);
  });

  it('recovers when the first commit failed and left data files behind', async () => {
    const t = await harness({ s3: { rejectConditionalWrites: true } });
    seed(t);
    await t.call('/v1/sync', { target: t.target });
    await t.syncs.idle();
    const companion = companionBucketName('org-1', 'us-east-9', 'docs');
    expect(fs.existsSync(path.join(t.root, companion, 'lance', 'chunks.lance', 'data'))).toBe(true);

    t.s3.options.rejectConditionalWrites = false;
    const status = await t.syncAndWait();
    expect(status.syncState).toBe('idle');
    expect(status.lastSyncError).toBeUndefined();
    expect(status.filesIndexed).toBe(3);
  });

  it('keeps the commits made before an embedding failure and finishes on the next sync', async () => {
    const t = await harness({ config: { flushRows: 1 } });
    seed(t);
    t.embedder.failOnCall = 2;
    await t.call('/v1/sync', { target: t.target });
    await t.syncs.idle();
    const failed = (await t.call<RagEngineStatus>('/v1/status', { target: t.target })).body;
    expect(failed.syncState).toBe('error');
    expect(failed.lastSyncError).toContain('embedding service unavailable');
    expect(failed.filesIndexed).toBe(1);

    const status = await t.syncAndWait();
    expect(status.syncState).toBe('idle');
    expect(status.filesIndexed).toBe(3);
    // Search works on the finished dataset.
    expect(status.dataset?.indexes.map((i) => i.type)).toContain('FTS');
  });

  it('rebuilds a missing full-text index even when no object changed', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    const companion = companionBucketName('org-1', 'us-east-9', 'docs');
    const db = await connectDataset(storageFor(t.target), companion);
    const table = await db.openTable(TABLE_NAME);
    await table.dropIndex('text_idx');
    expect((await query(t, { query: 'iron', searchMode: 'fulltext' })).status).toBe(409);

    const status = await t.syncAndWait();
    expect(status.dataset?.indexes.map((i) => i.type)).toContain('FTS');
    const result = await query(t, {
      query: 'iron oxide',
      searchMode: 'fulltext',
    });
    expect(result.body.citations[0]?.objectKey).toBe('space/mars.txt');
  });

  it('never sends a session token from the environment to storage', async () => {
    const previous = process.env.AWS_SESSION_TOKEN;
    process.env.AWS_SESSION_TOKEN = 'LEAKED-ENV-TOKEN';
    try {
      const t = await harness();
      seed(t);
      await t.syncAndWait();
      await query(t, { query: 'planet', searchMode: 'hybrid' });
      expect(t.s3.stats.requests.length).toBeGreaterThan(0);
      // Lance sends an empty header; the AWS SDK sends none.
      const tokens = new Set(t.s3.stats.requests.map((r) => r.securityToken ?? ''));
      expect([...tokens]).toEqual(['']);
    } finally {
      if (previous === undefined) delete process.env.AWS_SESSION_TOKEN;
      else process.env.AWS_SESSION_TOKEN = previous;
    }
  });

  it('commits in batches rather than once per object', async () => {
    const t = await harness({ config: { flushRows: 1000 } });
    for (let i = 0; i < 20; i += 1)
      t.putSource(`notes/${i}.txt`, `Note number ${i} about storage.`);
    await t.syncAndWait();
    const manifests = t.s3.stats.requests.filter(
      (r) => r.op === 'PUT' && r.conditional === '*' && r.key?.includes('_versions/'),
    );
    // Create, FTS index, optimize: a handful of commits, not twenty.
    expect(manifests.length).toBeLessThan(6);
  });

  it('builds the vector index once the dataset reaches the threshold', async () => {
    const t = await harness({ config: { vectorIndexMinRows: 10 } });
    for (let i = 0; i < 12; i += 1)
      t.putSource(`n/${i}.txt`, `Entry ${i} mentions harbour ${i % 3}.`);
    const status = await t.syncAndWait();
    const types = status.dataset?.indexes.map((i) => i.type) ?? [];
    expect(types.some((type) => /HNSW/i.test(type))).toBe(true);
    const result = await query(t, {
      query: 'harbour',
      searchMode: 'vector',
      topK: 3,
    });
    expect(result.body.trace.indexType).toMatch(/HNSW/i);
    expect(result.body.citations).toHaveLength(3);
  });

  it('reports a sync error when the provider refuses conditional writes', async () => {
    const t = await harness({ s3: { rejectConditionalWrites: true } });
    seed(t);
    await t.call('/v1/sync', { target: t.target });
    await t.syncs.idle();
    const status = (await t.call<RagEngineStatus>('/v1/status', { target: t.target })).body;
    expect(status.syncState).toBe('error');
    expect(status.lastSyncError).toMatch(/^CONDITIONAL_WRITE_REFUSED: /);
    expect(status.lastSyncError!.length).toBeLessThanOrEqual(300);
    expect(status.lastSyncError).not.toContain('.cargo');
    expect(t.s3.stats.refused.some((r) => r.includes('conditional PUT'))).toBe(true);
  });

  it('reports progress while a sync runs', async () => {
    const t = await harness();
    seed(t);
    t.embedder.delayMs = 300;
    const started = await t.call<RagEngineStatus>('/v1/sync', {
      target: t.target,
    });
    expect(started.status).toBe(202);
    expect(started.body.syncState).toBe('syncing');
    expect(started.body.progress).toBeDefined();
    // A second request while running joins the same sync.
    const again = await t.call<RagEngineStatus>('/v1/sync', {
      target: t.target,
    });
    expect(again.body.syncState).toBe('syncing');
    await t.syncs.idle();
  });
});

describe('query', () => {
  it('serves vector, full-text and hybrid search with citations and a trace', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();

    const vector = await query(t, {
      query: 'dog barks',
      searchMode: 'vector',
      topK: 2,
    });
    expect(vector.status).toBe(200);
    expect(vector.body.citations[0]).toMatchObject({
      n: 1,
      objectKey: 'animals/dogs.md',
      chunkIndex: 0,
      scoreKind: 'distance',
    });
    expect(vector.body.trace).toMatchObject({
      searchMode: 'vector',
      rows: 3,
      indexType: 'flat',
    });
    expect(vector.body.trace.io?.requests).toBeGreaterThan(0);
    expect(vector.body.trace.io?.bytesRead).toBeGreaterThan(0);

    const fulltext = await query(t, {
      query: 'iron oxide',
      searchMode: 'fulltext',
    });
    expect(fulltext.body.citations[0]).toMatchObject({
      objectKey: 'space/mars.txt',
      scoreKind: 'bm25',
    });
    expect(fulltext.body.trace.indexType).toBe('FTS');

    const hybrid = await query(t, {
      query: 'cat sleeps',
      searchMode: 'hybrid',
    });
    expect(hybrid.body.citations[0]).toMatchObject({
      objectKey: 'animals/cats.txt',
      scoreKind: 'rrf',
    });
    expect(hybrid.body.trace.indexType).toBe('flat+FTS');
    expect(hybrid.body.answer).toBe('');
  });

  it('answers with the configured provider, citing passages by number', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    const result = await t.call<RagEngineQueryResponse>('/v1/query', {
      target: t.target,
      query: 'What colour is Mars?',
      searchMode: 'hybrid',
      topK: 2,
    });
    expect(result.body.answer).toBe('Answer citing [1] from space/mars.txt');
    expect(t.answer.questions[0]?.passages[0]).toMatchObject({
      n: 1,
      objectKey: 'space/mars.txt',
    });
    expect(result.body.trace.models).toEqual({
      embedding: 'fake-bow-64',
      answer: 'fake-answer',
    });
    expect(result.body.sources[0]).toBe('space/mars.txt');
  });

  it('queries a past version (time travel)', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    const before = await t.call<RagEngineVersionsResponse>('/v1/versions', {
      target: t.target,
    });
    const pastVersion = before.body.versions[0]!.version;

    t.putSource('space/mars.txt', 'Mars has two moons, Phobos and Deimos.');
    await t.syncAndWait();
    const after = await t.call<RagEngineVersionsResponse>('/v1/versions', {
      target: t.target,
    });
    expect(after.body.versions[0]!.version).toBeGreaterThan(pastVersion);
    const versions = after.body.versions.map((v) => v.version);
    expect(versions).toEqual([...versions].sort((a, b) => b - a));
    expect(after.body.versions[0]!.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);

    const now = await query(t, { query: 'iron oxide', searchMode: 'fulltext' });
    expect(now.body.citations).toEqual([]);
    const then = await query(t, {
      query: 'iron oxide',
      searchMode: 'fulltext',
      version: pastVersion,
    });
    expect(then.body.citations[0]?.text).toContain('iron oxide');
    expect(then.body.trace.version).toBe(pastVersion);
  });

  it('returns the retrieval when the answer provider fails', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    t.answer.failWith = new Error('529 overloaded');
    const result = await t.call<RagEngineQueryResponse>('/v1/query', {
      target: t.target,
      query: 'What colour is Mars?',
      searchMode: 'hybrid',
    });
    expect(result.status).toBe(200);
    expect(result.body.answer).toBe('');
    expect(result.body.citations[0]?.objectKey).toBe('space/mars.txt');
  });

  it('tags the version each sync finished at, and every tagged version serves hybrid search', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    t.putSource('space/mars.txt', 'Mars has two moons, Phobos and Deimos.');
    await t.syncAndWait();
    const { versions } = (
      await t.call<RagEngineVersionsResponse>('/v1/versions', {
        target: t.target,
      })
    ).body;
    const tagged = versions.filter((v) => v.tags?.some((tag) => tag.startsWith('sync-')));
    expect(tagged).toHaveLength(2);
    expect(tagged[0]!.version).toBe(versions[0]!.version);
    for (const v of tagged) {
      const result = await query(t, {
        query: 'planet',
        searchMode: 'hybrid',
        version: v.version,
      });
      expect(result.status).toBe(200);
    }
  });

  it('reports a storage failure during time travel as an error, not a missing version', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    const target = {
      ...t.target,
      s3: { ...t.target.s3, accessKeyId: 'SOMEONE-ELSE' },
    };
    const result = await t.call('/v1/query', {
      target,
      query: 'x',
      version: 1,
    });
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL');
    expect(result.body.error.message.length).toBeLessThanOrEqual(300);
  });

  it('rejects an unknown version', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    const result = await t.call('/v1/query', {
      target: t.target,
      query: 'x',
      version: 999,
    });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('VERSION_NOT_FOUND');
  });
});

describe('reads never write', () => {
  it('query, status and versions on a never-indexed bucket write nothing', async () => {
    const t = await harness();
    seed(t);
    const q = await t.call('/v1/query', { target: t.target, query: 'cats' });
    expect(q.status).toBe(409);
    expect(q.body.error.code).toBe('NOT_INDEXED');

    const status = await t.call<RagEngineStatus>('/v1/status', {
      target: t.target,
    });
    expect(status.body).toMatchObject({
      syncState: 'idle',
      filesIndexed: 0,
      indexedBytes: 0,
    });
    expect(status.body.dataset).toBeUndefined();

    const versions = await t.call<RagEngineVersionsResponse>('/v1/versions', {
      target: t.target,
    });
    expect(versions.body.versions).toEqual([]);

    const writes = t.s3.stats.requests.filter((r) =>
      ['PUT', 'POST', 'DELETE', 'CreateBucket'].includes(r.op),
    );
    expect(writes).toEqual([]);
  });

  it('queries on an indexed bucket write nothing', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    t.s3.reset();
    for (const searchMode of ['vector', 'fulltext', 'hybrid']) {
      await query(t, { query: 'planet', searchMode });
    }
    await t.call('/v1/status', { target: t.target });
    await t.call('/v1/versions', { target: t.target });
    const writes = t.s3.stats.requests.filter(
      (r) => !['GET', 'HEAD', 'HeadBucket', 'ListObjectsV2'].includes(r.op),
    );
    expect(writes).toEqual([]);
  });
});

describe('drop', () => {
  it('removes the dataset and later status reports nothing indexed', async () => {
    const t = await harness();
    seed(t);
    await t.syncAndWait();
    const dropped = await t.call<{ dropped: boolean }>('/v1/drop', {
      target: t.target,
    });
    expect(dropped.body).toEqual({ dropped: true });
    const status = await t.call<RagEngineStatus>('/v1/status', {
      target: t.target,
    });
    expect(status.body.filesIndexed).toBe(0);
    expect(status.body.lastSyncedAt).toBeUndefined();
    const again = await t.call<{ dropped: boolean }>('/v1/drop', {
      target: t.target,
    });
    expect(again.body).toEqual({ dropped: false });
  });
});

describe('http surface', () => {
  it('requires the bearer token on /v1 routes but not on /healthz', async () => {
    const t = await harness();
    expect((await t.call('/v1/status', { target: t.target }, 'wrong')).status).toBe(401);
    const missing = await fetch(`${t.url}/v1/status`, {
      method: 'POST',
      body: '{}',
    });
    expect(missing.status).toBe(401);
    expect((await fetch(`${t.url}/healthz`)).status).toBe(200);
  });

  it('survives a malformed request target and keeps serving', async () => {
    const t = await harness();
    const port = Number(new URL(t.url).port);
    const firstLine = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'POST http://x:99999/v1/status HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
      socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
    expect(firstLine).toMatch(/^HTTP\/1\.1 401/);
    expect((await fetch(`${t.url}/healthz`)).status).toBe(200);
  });

  it('validates bodies against the contract', async () => {
    const t = await harness();
    const bad = await t.call('/v1/query', {
      target: t.target,
      query: '',
      topK: 500,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    const notJson = await t.call('/v1/status', '{not json');
    expect(notJson.status).toBe(400);
    expect((await t.call('/v1/nope', {})).status).toBe(404);
  });

  it('uses the tenant key it is given', async () => {
    const t = await harness();
    seed(t);
    const target = {
      ...t.target,
      s3: { ...t.target.s3, accessKeyId: 'SOMEONE-ELSE' },
    };
    await t.call('/v1/sync', { target });
    await t.syncs.idle();
    const status = await t.call<RagEngineStatus>('/v1/status', {
      target: t.target,
    });
    expect(status.body.filesIndexed).toBe(0);
  });
});
