import { describe, expect, it } from 'vitest';

import {
  type BucketRAGEnablementRecord,
  type ObjectChunkManifestRecord,
  type RAGConfigRecord,
  RAGKeys,
} from './dynamo-records.js';
import { S3Region } from '@filone/shared';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

describe('RAGKeys', () => {
  it('builds the per-account RAG config pk/sk', () => {
    expect(RAGKeys.configPk('org-1')).toBe('ORG#org-1');
    expect(RAGKeys.configSk()).toBe('RAGCONFIG');
  });

  it('builds the per-bucket enablement pk/sk', () => {
    expect(RAGKeys.bucketPk(S3Region.EuWest1, 'bucket-1')).toBe('BUCKET#eu-west-1#bucket-1');
    expect(RAGKeys.enablementSk()).toBe('RAG');
  });

  it('builds manifest sks sharing a begins_with-able prefix', () => {
    expect(RAGKeys.manifestSk('file1.pdf')).toBe('MANIFEST#file1.pdf');
    expect(RAGKeys.manifestSk('file1.pdf').startsWith(RAGKeys.manifestSkPrefix())).toBe(true);
  });
});

describe('RAGConfigRecord', () => {
  it('captures enabled + model choice under ORG#{orgId} / RAGCONFIG', () => {
    const now = new Date().toISOString();
    const record: RAGConfigRecord = {
      pk: RAGKeys.configPk('org-1'),
      sk: RAGKeys.configSk(),
      enabled: true,
      modelChoice: 'bedrock-titan',
      createdAt: now,
      updatedAt: now,
    };

    expect(record.pk).toBe('ORG#org-1');
    expect(record.sk).toBe('RAGCONFIG');
    expect(record.enabled).toBe(true);
    expect(record.modelChoice).toBe('bedrock-titan');
    expect(record.createdAt).toMatch(ISO_8601);
    expect(record.updatedAt).toMatch(ISO_8601);
  });
});

describe('BucketRAGEnablementRecord', () => {
  it('captures status, telemetry, and settings under BUCKET#{bucketId} / RAG', () => {
    const now = new Date().toISOString();
    const record: BucketRAGEnablementRecord = {
      pk: RAGKeys.bucketPk(S3Region.EuWest1, 'bucket-1'),
      sk: RAGKeys.enablementSk(),
      status: 'active',
      filesIndexed: 12,
      indexSize: 4096,
      lastSyncedAt: now,
      settings: { chunkSize: 512 },
      createdAt: now,
      updatedAt: now,
    };

    expect(record.pk).toBe('BUCKET#eu-west-1#bucket-1');
    expect(record.sk).toBe('RAG');
    expect(record.filesIndexed).toBe(12);
    expect(record.indexSize).toBe(4096);
    expect(record.settings).toEqual({ chunkSize: 512 });
    expect(record.lastSyncedAt).toMatch(ISO_8601);
  });

  it('accepts each of the allowed statuses', () => {
    const statuses = ['active', 'disabled', 'paused'] as const;
    for (const status of statuses) {
      const record: BucketRAGEnablementRecord = {
        pk: RAGKeys.bucketPk(S3Region.EuWest1, 'bucket-1'),
        sk: RAGKeys.enablementSk(),
        status,
        filesIndexed: 0,
        indexSize: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(record.status).toBe(status);
    }
  });
});

describe('ObjectChunkManifestRecord', () => {
  function makeManifest(objectKey: string, chunkKeys: string[]): ObjectChunkManifestRecord {
    return {
      pk: RAGKeys.bucketPk(S3Region.EuWest1, 'bucket-1'),
      sk: RAGKeys.manifestSk(objectKey),
      objectKey,
      etag: 'etag-abc',
      chunkKeys,
      chunkCount: chunkKeys.length,
      updatedAt: new Date().toISOString(),
    };
  }

  it('persists the full chunk-key list for explicit-key deletes', () => {
    const manifest = makeManifest('file1.pdf', ['file1.pdf#0', 'file1.pdf#1', 'file1.pdf#2']);
    expect(manifest.chunkKeys).toEqual(['file1.pdf#0', 'file1.pdf#1', 'file1.pdf#2']);
    expect(manifest.chunkCount).toBe(3);
    expect(manifest.objectKey).toBe('file1.pdf');
    expect(manifest.etag).toBe('etag-abc');
    expect(manifest.updatedAt).toMatch(ISO_8601);
  });

  it("returns all of a bucket's objects via a begins_with MANIFEST# query", () => {
    // Simulate a single-table partition for BUCKET#bucket-1 with mixed sks.
    const partition: Array<{ sk: string }> = [
      { sk: RAGKeys.enablementSk() },
      makeManifest('file1.pdf', ['file1.pdf#0']),
      makeManifest('file2.pdf', ['file2.pdf#0']),
      makeManifest('file3.pdf', ['file3.pdf#0']),
    ];

    const prefix = RAGKeys.manifestSkPrefix();
    const manifests = partition.filter((item) => item.sk.startsWith(prefix));

    expect(manifests).toHaveLength(3);
    expect(manifests.map((m) => m.sk)).toEqual([
      'MANIFEST#file1.pdf',
      'MANIFEST#file2.pdf',
      'MANIFEST#file3.pdf',
    ]);
  });
});
