import type {
  BucketRagEngineResponse,
  QueryBucketRequest,
  QueryBucketResponse,
  RagCitation,
} from '@filone/shared';

import { hybridAnswer, timeTravelAnswer } from './rag-engine-fixtures.js';

/**
 * A stand-in for the console API's engine routes, for Storybook. It answers
 * `GET .../rag/engine`, `POST .../rag/sync` and `POST .../query` from the
 * fixtures, so a story can be clicked through end to end: Index now advances a
 * run every poll until it commits a new version, and a question comes back in
 * the chosen search mode, from the chosen version.
 *
 * Install with {@link installRagEngineMockFetch}; it returns the restore function
 * Storybook's `beforeEach` expects.
 */

export type RagEngineMockOptions = {
  engine: BucketRagEngineResponse;
  /** Objects a sync started from the drawer walks through. */
  syncObjects?: number;
  /** Delay before a query answers, so the loading state is visible. */
  queryDelayMs?: number;
};

const SCORE_BY_MODE: Record<string, { kind: RagCitation['scoreKind']; scores: number[] }> = {
  vector: { kind: 'distance', scores: [0.164, 0.208, 0.297] },
  fulltext: { kind: 'bm25', scores: [14.82, 11.37, 9.04] },
  hybrid: { kind: 'rrf', scores: [0.0325, 0.0318, 0.0161] },
};

function answerFor(
  request: QueryBucketRequest,
  engine: BucketRagEngineResponse,
): QueryBucketResponse {
  const latest = engine.versions[0]?.version ?? 1;
  const version = request.version ?? latest;
  const mode = request.search_mode ?? 'vector';
  const base = version <= 11 ? timeTravelAnswer : hybridAnswer;
  const score = SCORE_BY_MODE[mode]!;
  return {
    ...base,
    citations: base.citations!.map((c, i) => ({
      ...c,
      score: score.scores[i] ?? c.score,
      scoreKind: score.kind,
    })),
    trace: {
      ...base.trace!,
      searchMode: mode,
      version,
      rows: version <= 11 ? base.trace!.rows : (engine.status.dataset?.rows ?? base.trace!.rows),
      indexType:
        mode === 'fulltext'
          ? 'FTS'
          : mode === 'vector'
            ? base.trace!.indexType.replace(/\+FTS$/, '')
            : `${base.trace!.indexType.replace(/\+FTS$/, '')}+FTS`,
    },
  };
}

export function installRagEngineMockFetch({
  engine: initial,
  syncObjects = 40,
  queryDelayMs = 900,
}: RagEngineMockOptions): () => void {
  let engine: BucketRagEngineResponse = structuredClone(initial);
  const original = window.fetch;

  function advance() {
    const progress = engine.status.progress;
    if (engine.status.syncState !== 'syncing' || !progress) return;
    const objectsDone = Math.min(progress.objectsTotal, progress.objectsDone + 7);
    if (objectsDone < progress.objectsTotal) {
      engine.status.progress = {
        ...progress,
        objectsDone,
        chunksWritten: Math.round((objectsDone / progress.objectsTotal) * 1_912),
      };
      return;
    }
    // Run finished: commit a new version and settle.
    const now = new Date().toISOString();
    const version = (engine.versions[0]?.version ?? 0) + 1;
    const dataset = engine.status.dataset;
    engine = {
      versions: [{ version, timestamp: now }, ...engine.versions],
      status: {
        syncState: 'idle',
        lastSyncedAt: now,
        filesIndexed: progress.objectsTotal,
        indexedBytes: engine.status.indexedBytes || 38_412_904,
        ...(dataset ? { dataset: { ...dataset, version } } : {}),
      },
    };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  function startSync() {
    if (engine.status.syncState === 'syncing') return;
    engine.status = {
      ...engine.status,
      syncState: 'syncing',
      progress: { objectsTotal: syncObjects, objectsDone: 0, chunksWritten: 0 },
    };
  }

  async function answer(init: RequestInit | undefined) {
    const body = typeof init?.body === 'string' ? init.body : '{}';
    const request = JSON.parse(body) as QueryBucketRequest;
    await new Promise((resolve) => setTimeout(resolve, queryDelayMs));
    return json(answerFor(request, engine));
  }

  window.fetch = async (input, init) => {
    const path = new URL(requestUrl(input), window.location.origin).pathname;
    if (/\/rag\/engine$/.test(path)) {
      advance();
      return json(engine);
    }
    if (/\/rag\/sync$/.test(path)) {
      startSync();
      return json(engine.status, 202);
    }
    if (/\/query$/.test(path)) return answer(init);
    return original(input, init);
  };

  return () => {
    window.fetch = original;
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
