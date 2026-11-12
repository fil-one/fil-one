import { vi } from 'vitest';
import type {
  RagEngineQueryResponse,
  RagEngineStatus,
  RagEngineVersionsResponse,
} from '@filone/shared';

/** A Bucket Intelligence engine client whose every call is a `vi.fn()`. */
export interface FakeRagEngine {
  sync: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  versions: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  drop: ReturnType<typeof vi.fn>;
}

export const ENGINE_DATASET_URI = 's3://filone-rag-0123456789abcdef0123456789abcdef01234567/lance';

/** An engine status after one finished sync, with overrides. */
export function engineStatus(over: Partial<RagEngineStatus> = {}): RagEngineStatus {
  return {
    syncState: 'idle',
    lastSyncedAt: '2026-11-03T10:00:00.000Z',
    filesIndexed: 3,
    indexedBytes: 4096,
    dataset: {
      uri: `${ENGINE_DATASET_URI}/chunks.lance`,
      companionBucket: 'filone-rag-0123456789abcdef0123456789abcdef01234567',
      table: 'chunks',
      version: 4,
      rows: 42,
      objects: 3,
      indexes: [{ name: 'text_idx', type: 'FTS', columns: ['text'] }],
      embedding: { model: 'BAAI/bge-small-en-v1.5', dimension: 384 },
    },
    ...over,
  };
}

export function engineVersions(): RagEngineVersionsResponse {
  return {
    versions: [
      { version: 4, timestamp: '2026-11-03T10:00:00.000Z' },
      { version: 3, timestamp: '2026-11-03T09:00:00.000Z' },
    ],
  };
}

export function engineQueryResponse(
  over: Partial<RagEngineQueryResponse> = {},
): RagEngineQueryResponse {
  return {
    answer: 'The sky is blue [1].',
    citations: [
      {
        n: 1,
        objectKey: 'sky.md',
        chunkIndex: 0,
        text: 'the sky is blue',
        score: 0.12,
        scoreKind: 'distance',
      },
    ],
    sources: ['sky.md'],
    trace: {
      searchMode: 'vector',
      version: 4,
      rows: 42,
      indexType: 'flat',
      datasetUri: `${ENGINE_DATASET_URI}/chunks.lance`,
      timings: { embedMs: 5, searchMs: 7, answerMs: 900, totalMs: 912 },
      models: { embedding: 'BAAI/bge-small-en-v1.5', answer: 'claude-opus-5-5' },
    },
    ...over,
  };
}

export function fakeRagEngine(): FakeRagEngine {
  return {
    sync: vi.fn().mockResolvedValue(engineStatus({ syncState: 'syncing' })),
    status: vi.fn().mockResolvedValue(engineStatus()),
    versions: vi.fn().mockResolvedValue(engineVersions()),
    query: vi.fn().mockResolvedValue(engineQueryResponse()),
    drop: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * The engine request target a {@link fakeOrchestrator} produces for org-1's
 * `bucketName` in `region` (see `fakeS3ClientContext`).
 */
export function expectedTarget(orchestratorId: string, region: string, bucketName: string) {
  const tenantId = `${orchestratorId}:org-1`;
  return {
    orgId: 'org-1',
    region,
    bucketName,
    s3: {
      endpointUrl: `https://s3.${region}.test.invalid`,
      region,
      accessKeyId: `AK-${tenantId}`,
      secretAccessKey: `SK-${tenantId}`,
    },
  };
}
