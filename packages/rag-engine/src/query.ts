import * as lancedb from '@lancedb/lancedb';
import type {
  RagCitation,
  RagEngineQueryRequest,
  RagEngineQueryResponse,
  RagQueryTrace,
  RagSearchMode,
} from '@filone/shared';

import type { EngineContext } from './engine-context.ts';
import { EngineError } from './errors.ts';
import { TEXT_COLUMN, VECTOR_COLUMN, openTable } from './lance-store.ts';
import { TABLE_NAME, companionBucketName, datasetUri, storageFor } from './storage.ts';

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
  const units: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  let total = 0;
  for (const match of plan.matchAll(new RegExp(`\\b${metric}=([\\d.]+)\\s?([KMGT]?)\\b`, 'g'))) {
    total += Number(match[1]) * (units[match[2] ?? ''] ?? 1);
  }
  return Math.round(total);
}

/**
 * Bytes and requests the search reads from storage, from Lance's analyzed
 * plan (which runs the search once more). Hybrid search runs two plans and a
 * reranker, so it reports none.
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
  const storage = storageFor(request.target, ctx.config.s3EndpointOverride);
  let table: lancedb.Table | undefined;
  try {
    table = await openTable(storage, companion, request.version);
  } catch (error) {
    if (request.version !== undefined) {
      throw new EngineError(404, 'VERSION_NOT_FOUND', `Version ${request.version} does not exist`);
    }
    throw error;
  }
  if (!table) throw new EngineError(409, 'NOT_INDEXED', 'This bucket has not been indexed yet');
  return table;
}

async function runSearch(
  search: lancedb.VectorQuery | lancedb.Query,
  mode: RagSearchMode,
): Promise<ResultRow[]> {
  try {
    return (await search.toArray()) as ResultRow[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

export async function runQuery(
  ctx: EngineContext,
  request: RagEngineQueryRequest,
): Promise<RagEngineQueryResponse> {
  const started = performance.now();
  const { target, searchMode } = request;
  const companion = companionBucketName(target.orgId, target.region, target.bucketName);
  const table = await openForQuery(ctx, request, companion);

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

  const answerStart = performance.now();
  const answer =
    request.answer && ctx.answer && citations.length > 0
      ? await ctx.answer.answer(request.query, citations)
      : '';
  const answerMs = request.answer && ctx.answer ? performance.now() - answerStart : 0;

  const [version, rowCount, indexType, io] = await Promise.all([
    table.version(),
    table.countRows(),
    indexTypeFor(table, searchMode),
    measureIo(query, searchMode),
  ]);
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
      totalMs: Math.round(performance.now() - started),
    },
    ...(io ? { io } : {}),
    models: {
      embedding: ctx.embedder.model,
      ...(request.answer && ctx.answer ? { answer: ctx.answer.model } : {}),
    },
  };
  const sources = [...new Set(citations.map((c) => c.objectKey))];
  return { answer, citations, sources, trace };
}
