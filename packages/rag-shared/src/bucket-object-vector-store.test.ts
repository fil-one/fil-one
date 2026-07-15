import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RAG_COMPANION_BUCKET_PREFIX } from '@filone/shared';
import { BucketObjectVectorStore, companionBucketName } from './bucket-object-vector-store.js';

const ORG = 'org-abc';
const REGION = 'eu-west-1';
const INDEX = 'bucket-1';
const COMPANION = companionBucketName(ORG, REGION, INDEX);

const s3Mock = mockClient(S3Client);

function makeStore(ensureBucket?: (name: string) => Promise<void>): BucketObjectVectorStore {
  return new BucketObjectVectorStore(s3Mock as unknown as S3Client, {
    ...(ensureBucket ? { ensureBucket } : {}),
  });
}

/** A `v1/<sha256(objectKey)>.json` blob key, mirroring the store's derivation. */
function blobKey(objectKey: string): string {
  return `v1/${createHash('sha256').update(objectKey).digest('hex')}.json`;
}

/** Base64 little-endian Float32Array, mirroring the store's encoding. */
function encode(embedding: number[]): string {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) buffer.writeFloatLE(embedding[i]!, i * 4);
  return buffer.toString('base64');
}

/** A streaming GetObject Body carrying `json`. */
function body(json: string) {
  return sdkStreamMixin(Readable.from(Buffer.from(json, 'utf-8')));
}

function blob(
  objectKey: string,
  chunks: Array<{ key: string; text: string; embedding: number[] }>,
) {
  return JSON.stringify({
    formatVersion: 1,
    objectKey,
    dimension: chunks[0]?.embedding.length ?? 0,
    chunks: chunks.map((c) => ({
      key: c.key,
      text: c.text,
      metadata: { objectKey },
      embedding: encode(c.embedding),
    })),
  });
}

describe('companionBucketName', () => {
  it('is 51 chars, charset/length-valid, and uses the reserved prefix', () => {
    const name = companionBucketName(ORG, REGION, INDEX);
    expect(name.startsWith(RAG_COMPANION_BUCKET_PREFIX)).toBe(true);
    expect(name).toHaveLength(51);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('gives two orgs distinct companion buckets for the same region+bucketName (FIL-596)', () => {
    expect(companionBucketName('org-a', REGION, INDEX)).not.toBe(
      companionBucketName('org-b', REGION, INDEX),
    );
  });

  it('is deterministic', () => {
    expect(companionBucketName(ORG, REGION, INDEX)).toBe(companionBucketName(ORG, REGION, INDEX));
  });
});

describe('BucketObjectVectorStore', () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  describe('ensureIndex', () => {
    it('invokes the ensureBucket callback with the companion bucket name', async () => {
      const ensureBucket = vi.fn(async () => {});
      await makeStore(ensureBucket).ensureIndex(ORG, REGION, INDEX);
      expect(ensureBucket).toHaveBeenCalledWith(COMPANION);
    });

    it('is a no-op when no ensureBucket callback is supplied', async () => {
      await expect(makeStore().ensureIndex(ORG, REGION, INDEX)).resolves.toBeUndefined();
    });
  });

  describe('upsertChunks', () => {
    it('writes one blob per source object at v1/<sha256(objectKey)>.json', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      await makeStore().upsertChunks(ORG, REGION, INDEX, [
        { key: 'doc.pdf#0', text: 'a', metadata: {}, embedding: [1, 0, 0] },
        { key: 'doc.pdf#1', text: 'b', metadata: {}, embedding: [0, 1, 0] },
        { key: 'other.txt#0', text: 'c', metadata: {}, embedding: [0, 0, 1] },
      ]);

      const puts = s3Mock.commandCalls(PutObjectCommand);
      expect(puts).toHaveLength(2);
      const byKey = (a: string, b: string) => a.localeCompare(b);
      const keys = puts.map((c) => c.args[0]!.input.Key!).sort(byKey);
      expect(keys).toEqual([blobKey('doc.pdf'), blobKey('other.txt')].sort(byKey));
      const docPut = puts.find((c) => c.args[0]!.input.Key === blobKey('doc.pdf'))!;
      expect(docPut.args[0]!.input.Bucket).toBe(COMPANION);
    });

    it('round-trips embeddings through base64 and packs both chunks of an object', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      await makeStore().upsertChunks(ORG, REGION, INDEX, [
        { key: 'doc.pdf#0', text: 'first', metadata: { page: 1 }, embedding: [1.5, -2.25, 3.75] },
        { key: 'doc.pdf#1', text: 'second', metadata: {}, embedding: [0.5, 0.5, 0.5] },
      ]);

      const put = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0]!.input;
      const parsed = JSON.parse(put.Body as string);
      expect(parsed.formatVersion).toBe(1);
      expect(parsed.objectKey).toBe('doc.pdf');
      expect(parsed.chunks).toHaveLength(2);
      expect(parsed.chunks[0].metadata).toEqual({ page: 1, objectKey: 'doc.pdf' });

      const decoded = Buffer.from(parsed.chunks[0].embedding, 'base64');
      const floats = [decoded.readFloatLE(0), decoded.readFloatLE(4), decoded.readFloatLE(8)];
      expect(floats).toEqual([1.5, -2.25, 3.75]);
    });

    it('derives objectKey from the final # so keys containing # survive', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      await makeStore().upsertChunks(ORG, REGION, INDEX, [
        { key: 'a#b/c.txt#3', text: 't', metadata: {}, embedding: [1, 0, 0] },
      ]);
      expect(s3Mock.commandCalls(PutObjectCommand)[0]!.args[0]!.input.Key).toBe(
        blobKey('a#b/c.txt'),
      );
    });

    it('rejects an object exceeding the chunks-per-object cap', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const chunks = Array.from({ length: 2001 }, (_, i) => ({
        key: `doc.pdf#${i}`,
        text: 't',
        metadata: {},
        embedding: [1, 0, 0],
      }));
      await expect(makeStore().upsertChunks(ORG, REGION, INDEX, chunks)).rejects.toThrow(
        /chunks-per-object limit/,
      );
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('rejects a chunk whose serialized metadata exceeds 40KB', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const huge = 'x'.repeat(41 * 1024);
      await expect(
        makeStore().upsertChunks(ORG, REGION, INDEX, [
          { key: 'doc.pdf#0', text: 't', metadata: { blob: huge }, embedding: [1, 0, 0] },
        ]),
      ).rejects.toThrow(/40KB|per-vector limit/);
    });

    it('rejects a chunk missing its embedding', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      await expect(
        makeStore().upsertChunks(ORG, REGION, INDEX, [
          { key: 'doc.pdf#0', text: 't', metadata: {} },
        ]),
      ).rejects.toThrow(/missing an embedding/);
    });

    it('no-ops on empty input', async () => {
      await makeStore().upsertChunks(ORG, REGION, INDEX, []);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });
  });

  describe('deleteChunks', () => {
    it('fast-path: deletes the whole blob when every chunk is removed', async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: body(
          blob('doc.pdf', [
            { key: 'doc.pdf#0', text: 'a', embedding: [1, 0, 0] },
            { key: 'doc.pdf#1', text: 'b', embedding: [0, 1, 0] },
          ]),
        ),
      });
      s3Mock.on(DeleteObjectCommand).resolves({});

      await makeStore().deleteChunks(ORG, REGION, INDEX, ['doc.pdf#0', 'doc.pdf#1']);

      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(DeleteObjectCommand)[0]!.args[0]!.input).toMatchObject({
        Bucket: COMPANION,
        Key: blobKey('doc.pdf'),
      });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('partial-rewrite: rewrites the blob without the deleted chunks', async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: body(
          blob('doc.pdf', [
            { key: 'doc.pdf#0', text: 'a', embedding: [1, 0, 0] },
            { key: 'doc.pdf#1', text: 'b', embedding: [0, 1, 0] },
          ]),
        ),
      });
      s3Mock.on(PutObjectCommand).resolves({});

      await makeStore().deleteChunks(ORG, REGION, INDEX, ['doc.pdf#0']);

      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
      const put = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0]!.input;
      const parsed = JSON.parse(put.Body as string);
      expect(parsed.chunks.map((c: { key: string }) => c.key)).toEqual(['doc.pdf#1']);
    });

    it('is idempotent: a missing blob (NoSuchKey) is a no-op', async () => {
      s3Mock.on(GetObjectCommand).rejects(namedError('NoSuchKey'));
      await makeStore().deleteChunks(ORG, REGION, INDEX, ['doc.pdf#0']);
      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('no-ops on empty keys', async () => {
      await makeStore().deleteChunks(ORG, REGION, INDEX, []);
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    });
  });

  describe('query', () => {
    it('objectKey fast path: single GET, no LIST, ordered closest-first', async () => {
      s3Mock.on(GetObjectCommand, { Key: blobKey('doc.pdf') }).resolves({
        Body: body(
          blob('doc.pdf', [
            { key: 'doc.pdf#0', text: 'match', embedding: [1, 0, 0] },
            { key: 'doc.pdf#1', text: 'far', embedding: [0, 1, 0] },
          ]),
        ),
      });

      const results = await makeStore().query(ORG, REGION, INDEX, {
        embedding: [1, 0, 0],
        k: 5,
        filters: { objectKey: 'doc.pdf' },
      });

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
      expect(results.map((r) => r.key)).toEqual(['doc.pdf#0', 'doc.pdf#1']);
      expect(results[0]!.score).toBeCloseTo(0, 5);
      expect(results[0]!.text).toBe('match');
      expect(results[0]!.metadata).toEqual({ objectKey: 'doc.pdf' });
      expect(results[1]!.score).toBeCloseTo(1, 5);
    });

    it('full scan: paginates the listing, GETs blobs, and returns global top-k', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: blobKey('a') }],
          IsTruncated: true,
          NextContinuationToken: 't',
        })
        .resolvesOnce({ Contents: [{ Key: blobKey('b') }], IsTruncated: false });
      s3Mock
        .on(GetObjectCommand, { Key: blobKey('a') })
        .resolves({ Body: body(blob('a', [{ key: 'a#0', text: 'a', embedding: [0, 1, 0] }])) });
      s3Mock
        .on(GetObjectCommand, { Key: blobKey('b') })
        .resolves({ Body: body(blob('b', [{ key: 'b#0', text: 'b', embedding: [1, 0, 0] }])) });

      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: [1, 0, 0], k: 1 });

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(2);
      expect(results.map((r) => r.key)).toEqual(['b#0']);
    });

    it('scopes the listing to the v1/ prefix', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
      await makeStore().query(ORG, REGION, INDEX, { embedding: [1, 0, 0], k: 3 });
      expect(s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0]!.input.Prefix).toBe('v1/');
    });

    it('skips unparseable blobs and keeps valid ones', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: blobKey('good') }, { Key: blobKey('bad') }],
        IsTruncated: false,
      });
      s3Mock.on(GetObjectCommand, { Key: blobKey('good') }).resolves({
        Body: body(blob('good', [{ key: 'good#0', text: 'ok', embedding: [1, 0, 0] }])),
      });
      s3Mock.on(GetObjectCommand, { Key: blobKey('bad') }).resolves({ Body: body('not json{') });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const results = await makeStore().query(ORG, REGION, INDEX, { embedding: [1, 0, 0], k: 5 });
        expect(results.map((r) => r.key)).toEqual(['good#0']);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('returns [] when the companion bucket does not exist (NoSuchBucket)', async () => {
      s3Mock.on(ListObjectsV2Command).rejects(namedError('NoSuchBucket'));
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: [1, 0, 0], k: 5 });
      expect(results).toEqual([]);
    });

    it('returns [] for k <= 0 without any S3 calls', async () => {
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: [1, 0, 0], k: 0 });
      expect(results).toEqual([]);
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });
  });

  describe('dropIndex', () => {
    it('pages the listing and batch-deletes every object', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: 'v1/a.json' }],
          IsTruncated: true,
          NextContinuationToken: 't',
        })
        .resolvesOnce({ Contents: [{ Key: 'v1/b.json' }], IsTruncated: false });
      s3Mock.on(DeleteObjectsCommand).resolves({});

      await makeStore().dropIndex(ORG, REGION, INDEX);

      const deletes = s3Mock.commandCalls(DeleteObjectsCommand);
      expect(deletes).toHaveLength(2);
      expect(deletes[0]!.args[0]!.input.Delete!.Objects).toEqual([{ Key: 'v1/a.json' }]);
    });

    it('falls back to single deletes when multi-object delete is unsupported', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: 'v1/a.json' }, { Key: 'v1/b.json' }], IsTruncated: false });
      s3Mock.on(DeleteObjectsCommand).rejects(namedError('NotImplemented'));
      s3Mock.on(DeleteObjectCommand).resolves({});

      await makeStore().dropIndex(ORG, REGION, INDEX);

      const singles = s3Mock
        .commandCalls(DeleteObjectCommand)
        .map((c) => c.args[0]!.input.Key!)
        .sort((a, b) => a.localeCompare(b));
      expect(singles).toEqual(['v1/a.json', 'v1/b.json']);
    });

    it('treats a missing bucket (NoSuchBucket) as success', async () => {
      s3Mock.on(ListObjectsV2Command).rejects(namedError('NoSuchBucket'));
      await expect(makeStore().dropIndex(ORG, REGION, INDEX)).resolves.toBeUndefined();
    });
  });
});

/** Build an Error whose `name` matches an AWS SDK service exception. */
function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
