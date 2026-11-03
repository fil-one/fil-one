import {
  formatBytes,
  type RagCitation,
  type RagEngineStatus,
  type RagSearchMode,
} from '@filone/shared';

/**
 * Presentation helpers for engine-backed (Forge) Bucket Intelligence: the Lance
 * dataset panel, the search controls, and the cited answer. Pure functions, so
 * the components stay thin and the formatting is tested in one place.
 */

export const SEARCH_MODE_LABELS: Record<RagSearchMode, string> = {
  vector: 'Vector',
  fulltext: 'Full text',
  hybrid: 'Hybrid',
};

/** One-line description of each search mode, shown as the segmented control's hint. */
export const SEARCH_MODE_HINTS: Record<RagSearchMode, string> = {
  vector: 'Nearest neighbours by embedding (cosine distance)',
  fulltext: 'Keyword match with BM25 on the full-text index',
  hybrid: 'Vector and full-text results merged with reciprocal rank fusion',
};

/** A piece of a cited answer: plain text, or a `[n]` marker that resolves to a citation. */
export type CitedAnswerSegment = { kind: 'text'; text: string } | { kind: 'cite'; n: number };

/**
 * Split an answer into text and citation markers.
 *
 * Models write citations as `[1]`, `[1][2]` or `[1, 2]`. Each number that matches
 * a returned citation becomes a marker; anything else (a number with no citation
 * behind it, `[a]`, a footnote the source text happened to contain) stays text,
 * so a marker on screen always leads somewhere.
 */
export function parseCitedAnswer(
  answer: string,
  citationNumbers: Iterable<number>,
): CitedAnswerSegment[] {
  const known = new Set(citationNumbers);
  const segments: CitedAnswerSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'text') last.text += text;
    else segments.push({ kind: 'text', text });
  };

  const pattern = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let cursor = 0;
  for (const match of answer.matchAll(pattern)) {
    const numbers = match[1]!.split(',').map((part) => Number(part.trim()));
    if (!numbers.every((n) => known.has(n))) continue;
    pushText(answer.slice(cursor, match.index));
    for (const n of numbers) segments.push({ kind: 'cite', n });
    cursor = match.index + match[0].length;
  }
  pushText(answer.slice(cursor));
  return segments;
}

/**
 * The score a citation was ranked by, labelled with its kind. The three modes
 * score on different scales (lower distance is better, higher BM25 and RRF are
 * better), so the number is never shown without its name.
 */
export function formatCitationScore(citation: Pick<RagCitation, 'score' | 'scoreKind'>): string {
  switch (citation.scoreKind) {
    case 'distance':
      return `Distance ${citation.score.toFixed(3)}`;
    case 'bm25':
      return `BM25 ${citation.score.toFixed(2)}`;
    case 'rrf':
      return `RRF ${citation.score.toFixed(4)}`;
  }
}

const versionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A dataset version's commit time, compact enough for a select option: "Nov 3, 2:06 PM". */
export function formatVersionTime(isoString: string): string {
  return versionTimeFormatter.format(new Date(isoString));
}

/** Milliseconds as "18 ms" below a second, "6.2 s" above. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The last path segment of an object key, for compact display. */
export function objectBasename(key: string): string {
  return key.split('/').filter(Boolean).pop() ?? key;
}

/** Percentage (0 to 100) of a running sync, or undefined when the total is not known yet. */
export function syncPercent(progress: RagEngineStatus['progress']): number | undefined {
  if (!progress || progress.objectsTotal <= 0) return undefined;
  return Math.round((progress.objectsDone / progress.objectsTotal) * 100);
}

/** "12 of 40 objects · 540 chunks written" for a running sync. */
export function syncProgressLabel(progress: RagEngineStatus['progress']): string {
  if (!progress) return 'Starting';
  if (progress.objectsTotal <= 0) return 'Listing objects';
  return `${progress.objectsDone.toLocaleString()} of ${progress.objectsTotal.toLocaleString()} objects · ${progress.chunksWritten.toLocaleString()} chunks written`;
}

/** "412 KB in 27 requests" for a query's reads from Forge storage. */
export function formatIo(io: { bytesRead: number; requests: number }): string {
  return `${formatBytes(io.bytesRead)} in ${io.requests.toLocaleString()} ${io.requests === 1 ? 'request' : 'requests'}`;
}

/**
 * The index a query used, as the trace shows it. The engine reports `flat` when
 * the vector column has no index yet, `none` when full text has no index, and
 * joins the vector and text parts with `+` for hybrid (`flat+FTS`).
 */
export function formatIndexType(indexType: string): string {
  return indexType
    .split('+')
    .map((part) => (part === 'flat' ? 'Flat scan' : part === 'none' ? 'No index' : part))
    .join(' + ');
}

/** Whether a value looks like an engine status (the sync route may answer 202 with no body). */
export function isEngineStatus(value: unknown): value is RagEngineStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { syncState?: unknown }).syncState === 'string'
  );
}

/** How often the drawer re-reads an engine-backed bucket while a sync runs. */
export const ENGINE_SYNC_POLL_MS = 3_000;

/**
 * The directory that holds a dataset's tables: the dataset URI without its
 * trailing `/<table>.lance`. A URI in another shape loses its last segment.
 */
export function lanceDatabaseUri(datasetUri: string, table: string): string {
  const suffix = `/${table}.lance`;
  if (datasetUri.endsWith(suffix)) return datasetUri.slice(0, -suffix.length);
  const cut = datasetUri.replace(/\/+$/, '').lastIndexOf('/');
  return cut > 's3://'.length ? datasetUri.slice(0, cut) : datasetUri;
}

/**
 * Python that opens the bucket's Lance dataset directly from Forge storage with
 * the open-source `lancedb` package. Credentials come from environment variables
 * so a pasted snippet never carries a real key, and the session token is pinned
 * empty so one exported for another AWS account is never sent to Forge.
 */
export function buildLancePythonSnippet({
  datasetUri,
  table,
  endpoint,
  region,
}: {
  datasetUri: string;
  table: string;
  endpoint: string;
  region: string;
}): string {
  const storageOptions = [
    `        "aws_endpoint": "${endpoint}",`,
    `        "aws_region": "${region}",`,
    '        "aws_access_key_id": os.environ["FILONE_ACCESS_KEY_ID"],',
    '        "aws_secret_access_key": os.environ["FILONE_SECRET_ACCESS_KEY"],',
    '        "aws_session_token": "",',
    '        "aws_virtual_hosted_style_request": "false",',
  ];
  if (endpoint.startsWith('http://')) storageOptions.push('        "allow_http": "true",');
  return [
    'import os',
    'import lancedb',
    '',
    'db = lancedb.connect(',
    `    "${lanceDatabaseUri(datasetUri, table)}",`,
    '    storage_options={',
    ...storageOptions,
    '    },',
    ')',
    `table = db.open_table("${table}")`,
    'print(table.count_rows(), table.version)',
    'print(table.search("your search terms", query_type="fts").limit(5).to_list())',
  ].join('\n');
}
