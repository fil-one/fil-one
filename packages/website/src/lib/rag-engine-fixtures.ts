import {
  S3Region,
  type BucketRagEngineResponse,
  type QueryBucketResponse,
  type RagEngineStatus,
  type RagEngineVersion,
} from '@filone/shared';

import type { RagBucket } from './rag-bucket-api.js';

/**
 * Realistic engine data for stories and tests: a Forge bucket of ~40 policy and
 * runbook documents chunked into 1,912 rows, fourteen dataset versions, an
 * IVF_HNSW_SQ vector index plus a full-text index, and a hybrid answer citing three
 * passages. Kept in one place so the drawer, the panel and the answer agree.
 */

export const forgeBucket: RagBucket = {
  name: 'acme-handbook',
  region: S3Region.EuCentral3,
  enabled: true,
  filesIndexed: 41,
  indexSize: 38_412_904,
  lastSyncedAt: '2026-11-03T14:06:12Z',
};

export const COMPANION_BUCKET = 'filone-rag-3f9a1c07e2b84d5a96c1f0e7d2a4b8c3e5f71d09';

export const engineVersions: RagEngineVersion[] = [
  { version: 14, timestamp: '2026-11-03T14:06:12Z' },
  { version: 13, timestamp: '2026-11-03T14:06:09Z' },
  { version: 12, timestamp: '2026-11-03T14:05:58Z' },
  { version: 11, timestamp: '2026-11-03T11:42:31Z', tags: ['before-retention-update'] },
  { version: 10, timestamp: '2026-11-03T11:42:27Z' },
  { version: 9, timestamp: '2026-11-03T09:00:44Z' },
  { version: 8, timestamp: '2026-11-03T09:00:40Z' },
  { version: 7, timestamp: '2026-11-02T21:00:52Z' },
  { version: 6, timestamp: '2026-11-02T21:00:47Z' },
  { version: 5, timestamp: '2026-11-02T16:18:05Z' },
  { version: 4, timestamp: '2026-11-02T16:18:01Z' },
  { version: 3, timestamp: '2026-11-02T16:17:39Z' },
  { version: 2, timestamp: '2026-11-02T16:17:12Z' },
  { version: 1, timestamp: '2026-11-02T16:16:58Z' },
];

export const engineStatus: RagEngineStatus = {
  syncState: 'idle',
  lastSyncedAt: '2026-11-03T14:06:12Z',
  filesIndexed: 41,
  indexedBytes: 38_412_904,
  dataset: {
    uri: `s3://${COMPANION_BUCKET}/lance/chunks.lance`,
    companionBucket: COMPANION_BUCKET,
    table: 'chunks',
    version: 14,
    rows: 1_912,
    objects: 41,
    storageBytes: 5_204_480,
    fragments: 6,
    indexes: [
      {
        name: 'vector_idx',
        type: 'IVF_HNSW_SQ',
        columns: ['vector'],
        indexedRows: 1_880,
        unindexedRows: 32,
      },
      { name: 'text_idx', type: 'FTS', columns: ['text'], indexedRows: 1_912, unindexedRows: 0 },
    ],
    embedding: { model: 'BAAI/bge-small-en-v1.5', dimension: 384 },
  },
};

export const engineResponse: BucketRagEngineResponse = {
  status: engineStatus,
  versions: engineVersions,
};

/** A run in flight: 17 of 40 objects read, the previous version still searchable. */
export const engineSyncing: BucketRagEngineResponse = {
  status: {
    ...engineStatus,
    syncState: 'syncing',
    progress: { objectsTotal: 40, objectsDone: 17, chunksWritten: 796 },
  },
  versions: engineVersions,
};

/** Enabled, never synced: no dataset yet. */
export const engineEmpty: BucketRagEngineResponse = {
  status: { syncState: 'idle', filesIndexed: 0, indexedBytes: 0 },
  versions: [],
};

/** A small dataset below the vector-index threshold: flat search, FTS only. */
export const engineFlat: BucketRagEngineResponse = {
  status: {
    syncState: 'idle',
    lastSyncedAt: '2026-11-03T14:06:12Z',
    filesIndexed: 3,
    indexedBytes: 412_330,
    dataset: {
      ...engineStatus.dataset!,
      version: 3,
      rows: 118,
      objects: 3,
      storageBytes: 322_816,
      fragments: 1,
      indexes: [{ name: 'text_idx', type: 'FTS', columns: ['text'], indexedRows: 118 }],
    },
  },
  versions: engineVersions.slice(-3),
};

export const engineError: BucketRagEngineResponse = {
  status: {
    ...engineStatus,
    syncState: 'error',
    lastSyncError: 'Could not read reports/q3-board-pack.pdf: the object was deleted mid-run',
  },
  versions: engineVersions,
};

export const QUESTION = 'How long do we keep customer backups after an account is closed?';

export const hybridAnswer: QueryBucketResponse = {
  answer:
    'Backups of a closed account are kept for 35 days and then deleted [1]. During that window the customer can ask support to restore the account in full [2]. Legal holds override the schedule: data under a hold is kept until the hold is released, even past 35 days [3].',
  sources: [
    'policies/data-retention.pdf',
    'runbooks/account-restore.md',
    'legal/litigation-hold-procedure.docx',
  ],
  citations: [
    {
      n: 1,
      objectKey: 'policies/data-retention.pdf',
      chunkIndex: 7,
      text: 'When an account is closed, its primary data is removed from production storage within 24 hours. Backup snapshots that contain the account are retained for 35 days from the closure date and are then permanently deleted as part of the nightly expiry job.',
      score: 0.0325,
      scoreKind: 'rrf',
    },
    {
      n: 2,
      objectKey: 'runbooks/account-restore.md',
      chunkIndex: 2,
      text: 'A closed account can be restored on request while its backups are still within the 35-day retention window. Open a restore ticket, confirm the requester is an owner of the closed organisation, and restore from the most recent snapshot.',
      score: 0.0318,
      scoreKind: 'rrf',
    },
    {
      n: 3,
      objectKey: 'legal/litigation-hold-procedure.docx',
      chunkIndex: 11,
      text: 'Data subject to a litigation hold is exempt from scheduled deletion, including backup expiry. Legal releases the hold in writing; only then does the normal retention schedule resume.',
      score: 0.0161,
      scoreKind: 'rrf',
    },
  ],
  trace: {
    searchMode: 'hybrid',
    version: 14,
    rows: 1_912,
    indexType: 'IVF_HNSW_SQ+FTS',
    datasetUri: `s3://${COMPANION_BUCKET}/lance/chunks.lance`,
    timings: { embedMs: 21, searchMs: 38, answerMs: 5_840, totalMs: 5_912 },
    io: { bytesRead: 412_672, requests: 27 },
    models: { embedding: 'BAAI/bge-small-en-v1.5', answer: 'claude-opus-5-5' },
  },
};

/** The same question answered against version 11, before the retention policy changed. */
export const timeTravelAnswer: QueryBucketResponse = {
  answer:
    'Backups of a closed account are kept for 90 days before they are deleted [1]. Restores are possible during that period [2].',
  sources: ['policies/data-retention.pdf', 'runbooks/account-restore.md'],
  citations: [
    {
      n: 1,
      objectKey: 'policies/data-retention.pdf',
      chunkIndex: 7,
      text: 'Backup snapshots that contain a closed account are retained for 90 days from the closure date and are then permanently deleted.',
      score: 0.182,
      scoreKind: 'distance',
    },
    {
      n: 2,
      objectKey: 'runbooks/account-restore.md',
      chunkIndex: 2,
      text: 'A closed account can be restored on request while its backups are still within the retention window.',
      score: 0.241,
      scoreKind: 'distance',
    },
  ],
  trace: {
    searchMode: 'vector',
    version: 11,
    rows: 1_874,
    indexType: 'IVF_HNSW_SQ',
    datasetUri: `s3://${COMPANION_BUCKET}/lance/chunks.lance`,
    timings: { embedMs: 19, searchMs: 31, answerMs: 4_210, totalMs: 4_266 },
    models: { embedding: 'BAAI/bge-small-en-v1.5', answer: 'claude-opus-5-5' },
  },
};
