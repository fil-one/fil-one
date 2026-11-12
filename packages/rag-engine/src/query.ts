import * as lancedb from '@lancedb/lancedb';
import type {
  RagCitation,
  RagEngineQueryRequest,
  RagEngineQueryResponse,
  RagQueryTrace,
  RagSearchMode,
} from '@filone/shared';

import { ANSWER_TIMEOUT_MS } from './answer.ts';
import type { EngineContext } from './engine-context.ts';
import { readEngineState } from './engine-state.ts';
import { EngineError, errorLogFields } from './errors.ts';
import { TEXT_COLUMN, VECTOR_COLUMN, VersionNotFoundError, openTable } from './lance-store.ts';
import {
  TABLE_NAME,
  companionBucketName,
  createS3Client,
  datasetUri,
  storageFor,
} from './storage.ts';

const RESULT_COLUMNS = ['objectKey', 'chunkIndex', 'text'];

interface ResultRow {
  objectKey: string;
  chunkIndex: number;
  text: string;
  _distance?: number;
  _score?: number;
  _relevance_score?: number;
}

const SCORE_KIND: Record<RagSearchMode, RagCitation['scoreKind']> = {
  vector: 'distance',
  fulltext: 'bm25',
  hybrid: 'rrf',
};

function scoreOf(row: ResultRow, mode: RagSearchMode): number {
  if (mode === 'vector') return Number(row._distance ?? 0);
  if (mode === 'fulltext') return Number(row._score ?? 0);
  return Number(row._relevance_score ?? 0);
}

/** The search for `request`; hybrid fuses vector and full-text results with RRF. */
function buildSearch(
  table: lancedb.Table,
  request: RagEngineQueryRequest,
  embedding: number[] | undefined,
  reranker: lancedb.rerankers.RRFReranker | undefined,
): lancedb.VectorQuery | lancedb.Query {
  const { searchMode, topK, query } = request;
  if (searchMode === 'fulltext') {
    return table
      .query()
      .fullTextSearch(query)
      .select([...RESULT_COLUMNS, '_score'])
      .limit(topK);
  }
  const vector = table
    .query()
    .nearestTo(embedding ?? [])
    .distanceType('cosine')
    .limit(topK);
  // Naming the score column keeps Lance from warning that it adds it. Hybrid
  // search rejects score columns in the projection, so it names none.
  if (searchMode === 'vector' || !reranker) return vector.select([...RESULT_COLUMNS, '_distance']);
  return vector.fullTextSearch(query).select(RESULT_COLUMNS).rerank(reranker);
}

/** Sum a metric such as `bytes_read=1.81 K` over every node of an analyzed plan. */
export function sumPlanMetric(plan: string, metric: string): number {
  const units: Record<string, number> = {
    '': 1,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  let total = 0;
  for (const match of plan.matchAll(new RegExp(`\\b${metric}=([\\d.]+)\\s?([KMGT]?)\\b`, 'g'))) {
    total += Number(match[1]) * (units[match[2] ?? ''] ?? 1);
  }
  return Math.round(total);
}

/**
 * Bytes and requests the search reads from storage, from Lance's analyzed
 * plan. Lance cannot return rows and metrics from one execution, so this runs
 * the search a second time, after the timed one: the figures reflect a warm
 * cache and count only what that run fetched. Hybrid search runs two plans
 * and a reranker, so it reports none.
 */
async function measureIo(
  search: lancedb.VectorQuery | lancedb.Query,
  mode: RagSearchMode,
): Promise<RagQueryTrace['io']> {
  if (mode === 'hybrid') return undefined;
  try {
    const plan = await search.analyzePlan();
    return {
      bytesRead: sumPlanMetric(plan, 'bytes_read'),
      requests: sumPlanMetric(plan, 'requests'),
    };
  } catch {
    return undefined;
  }
}

async function indexTypeFor(table: lancedb.Table, mode: RagSearchMode): Promise<string> {
  const indexes = await table.listIndices();
  const vectorIndex = indexes.find((index) => index.columns.includes(VECTOR_COLUMN));
  const vectorType = vectorIndex
    ? ((await table.indexStats(vectorIndex.name))?.indexType ?? vectorIndex.indexType)
    : 'flat';
  const hasFts = indexes.some((index) => index.columns.includes(TEXT_COLUMN));
  if (mode === 'vector') return vectorType;
  if (mode === 'fulltext') return hasFts ? 'FTS' : 'none';
  return `${vectorType}+FTS`;
}

async function openForQuery(
  ctx: EngineContext,
  request: RagEngineQueryRequest,
  companion: string,
): Promise<lancedb.Table> {
  const storage = storageFor(request.target, ctx.config.s3EndpointOverrides);
  let table: lancedb.Table | undefined;
  try {
    table = await openTable(storage, companion, request.version);
  } catch (error) {
    if (error instanceof VersionNotFoundError) {
      throw new EngineError(404, 'VERSION_NOT_FOUND', error.message);
    }
    throw error;
  }
  if (!table) throw new EngineError(409, 'NOT_INDEXED', 'This bucket has not been indexed yet');
  return table;
}

/**
 * Refuse a vector or hybrid search when the index was built with another
 * embedding model than the engine now runs: the query vector would not be
 * comparable with the stored ones. The next sync rebuilds the index with the
 * current model. A dataset with no recorded model predates the record and is
 * searched as before.
 */
async function assertSameEmbeddingModel(
  ctx: EngineContext,
  request: RagEngineQueryRequest,
  companion: string,
): Promise<void> {
  if (request.searchMode === 'fulltext') return;
  const s3 = createS3Client(storageFor(request.target, ctx.config.s3EndpointOverrides));
  let model: string | undefined;
  try {
    model = (await readEngineState(s3, companion)).embedding?.model;
  } finally {
    s3.destroy();
  }
  if (model && model !== ctx.embedder.model) {
    throw new EngineError(
      409,
      'EMBEDDING_MODEL_CHANGED',
      `This index was built with embedding model ${model}; sync the bucket to rebuild it with ${ctx.embedder.model}, or use full-text search`,
    );
  }
}

async function runSearch(
  search: lancedb.VectorQuery | lancedb.Query,
  mode: RagSearchMode,
): Promise<ResultRow[]> {
  try {
    return (await search.toArray()) as ResultRow[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode !== 'vector' && /required for phrase queries/i.test(message)) {
      // An index built before the engine recorded token positions; the next
      // sync rebuilds it, and versions it wrote before then keep the old one.
      throw new EngineError(
        409,
        'NO_PHRASE_INDEX',
        'This dataset version cannot run a quoted phrase search; remove the quotes, or sync and search the latest version',
      );
    }
    if (mode !== 'vector' && /full text search|INVERTED index/i.test(message)) {
      throw new EngineError(
        409,
        'NO_FULLTEXT_INDEX',
        'This dataset version has no full-text index; search a later version or use vector search',
      );
    }
    throw error;
  }
}

function toCitations(rows: ResultRow[], mode: RagSearchMode): RagCitation[] {
  return rows.map((row, i) => ({
    n: i + 1,
    objectKey: String(row.objectKey),
    chunkIndex: Number(row.chunkIndex),
    text: String(row.text),
    score: scoreOf(row, mode),
    scoreKind: SCORE_KIND[mode],
  }));
}

/**
 * The model's answer, or '' when the provider fails or runs past the
 * deadline: the retrieved citations are still worth returning, as they are
 * when no provider is configured. The deadline aborts the provider call, and
 * the race returns on time even if a provider ignores the abort.
 */
async function answerOrEmpty(
  ctx: EngineContext,
  question: string,
  citations: RagCitation[],
): Promise<string> {
  const timeoutMs = ctx.config.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // A symbol, so no text the provider returns can be mistaken for the deadline.
  const timeout = Symbol('timeout');
  const timedOut = new Promise<typeof timeout>((resolve) => {
    timer = setTimeout(() => {
      resolve(timeout);
      controller.abort();
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      ctx.answer!.answer(question, citations, controller.signal),
      timedOut,
    ]);
    if (result !== timeout) return result;
    ctx.log('warn', 'answer_timeout', { model: ctx.answer?.model, timeoutMs });
    return '';
  } catch (error) {
    if (controller.signal.aborted) {
      ctx.log('warn', 'answer_timeout', { model: ctx.answer?.model, timeoutMs });
      return '';
    }
    ctx.log('warn', 'answer_failed', { model: ctx.answer?.model, ...errorLogFields(error) });
    return '';
  } finally {
    clearTimeout(timer);
  }
}

export async function runQuery(
  ctx: EngineContext,
  request: RagEngineQueryRequest,
): Promise<RagEngineQueryResponse> {
  const started = performance.now();
  const { target, searchMode } = request;
  const companion = companionBucketName(target.orgId, target.region, target.bucketName);
  const table = await openForQuery(ctx, request, companion);
  await assertSameEmbeddingModel(ctx, request, companion);

  const embedStart = performance.now();
  const embedding =
    searchMode === 'fulltext' ? undefined : (await ctx.embedder.embed([request.query]))[0];
  const embedMs = performance.now() - embedStart;

  const searchStart = performance.now();
  const reranker =
    searchMode === 'hybrid' ? await lancedb.rerankers.RRFReranker.create() : undefined;
  const query = buildSearch(table, request, embedding, reranker);
  const rows = await runSearch(query, searchMode);
  const searchMs = performance.now() - searchStart;
  const citations = toCitations(rows, searchMode);

  // The trace's storage reads do not depend on the answer, so they run while
  // it is written rather than after it.
  const details = Promise.all([
    table.version(),
    table.countRows(),
    indexTypeFor(table, searchMode),
    measureIo(query, searchMode),
  ]);
  const wantsAnswer = Boolean(request.answer && ctx.answer);
  const answerStart = performance.now();
  const answered = (
    wantsAnswer && citations.length > 0
      ? answerOrEmpty(ctx, request.query, citations)
      : Promise.resolve('')
  ).then((text) => {
    // Timings stop here: the I/O measurement runs the search a second time.
    const finished = performance.now();
    return {
      text,
      answerMs: wantsAnswer ? finished - answerStart : 0,
      totalMs: finished - started,
    };
  });
  const [{ text: answer, answerMs, totalMs }, [version, rowCount, indexType, io]] =
    await Promise.all([answered, details]);
  const trace: RagQueryTrace = {
    searchMode,
    version,
    rows: rowCount,
    indexType,
    datasetUri: `${datasetUri(companion)}/${TABLE_NAME}.lance`,
    timings: {
      embedMs: Math.round(embedMs),
      searchMs: Math.round(searchMs),
      answerMs: Math.round(answerMs),
      totalMs: Math.round(totalMs),
    },
    ...(io ? { io } : {}),
    models: {
      embedding: ctx.embedder.model,
      ...(wantsAnswer && ctx.answer ? { answer: ctx.answer.model } : {}),
    },
  };
  const sources = [...new Set(citations.map((c) => c.objectKey))];
  return { answer, citations, sources, trace };
}
