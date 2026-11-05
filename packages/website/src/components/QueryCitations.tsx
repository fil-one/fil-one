import { useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { clsx } from 'clsx';

import type { RagCitation, RagQueryTrace } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api.js';
import {
  SEARCH_MODE_LABELS,
  formatCitationScore,
  formatDuration,
  formatIndexType,
  formatIo,
  objectBasename,
  parseCitedAnswer,
} from '../lib/rag-engine.js';

/*
 * The answer, the passages it cites and how the query was served, for
 * engine-backed (Forge) buckets. Other buckets render the plain answer and
 * source pills in QueryAnswer, unchanged.
 */

export type CitedAnswerProps = {
  answer: string;
  citations: RagCitation[];
  activeCitation: number | null;
  onSelectCitation: (n: number) => void;
};

/** Answer text with each `[n]` rendered as a button that selects citation n. */
export function CitedAnswer({
  answer,
  citations,
  activeCitation,
  onSelectCitation,
}: CitedAnswerProps) {
  const segments = parseCitedAnswer(
    answer,
    citations.map((c) => c.n),
  );
  return (
    <p
      data-testid="query-answer-text"
      className="text-sm leading-relaxed whitespace-pre-line text-zinc-700"
    >
      {segments.map((segment, i) =>
        segment.kind === 'text' ? (
          // A marker sits against the word it supports, like a footnote.
          <span key={i}>
            {segments[i + 1]?.kind === 'cite' ? segment.text.trimEnd() : segment.text}
          </span>
        ) : (
          <button
            key={i}
            type="button"
            data-testid="citation-marker"
            aria-label={`Show source ${segment.n}`}
            aria-pressed={activeCitation === segment.n}
            onClick={() => onSelectCitation(segment.n)}
            className={clsx(
              'ml-1 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 align-text-top text-meta font-medium tabular-nums transition-colors duration-150 focus-visible:brand-outline',
              activeCitation === segment.n
                ? 'bg-brand-600 text-white'
                : 'bg-brand-50 text-brand-700 hover:bg-brand-100',
            )}
          >
            {segment.n}
          </button>
        ),
      )}
    </p>
  );
}

export type CitationListProps = {
  bucket: RagBucket;
  citations: RagCitation[];
  activeCitation: number | null;
  onSelectCitation: (n: number) => void;
};

/**
 * The retrieved passages, numbered as the answer cites them. Each shows the
 * passage text, the object it came from (linking into the object browser), the
 * chunk position and the score it was ranked by. The selected one expands to
 * its full text and scrolls into view.
 */
export function CitationList({
  bucket,
  citations,
  activeCitation,
  onSelectCitation,
}: CitationListProps) {
  if (citations.length === 0) return null;
  return (
    <div data-testid="query-citations" className="mt-4 border-t border-zinc-100 pt-3">
      <p className="mb-2 text-meta font-medium uppercase tracking-widest text-zinc-500">Sources</p>
      <ol className="flex flex-col gap-2">
        {citations.map((citation) => (
          <CitationCard
            key={citation.n}
            bucket={bucket}
            citation={citation}
            active={activeCitation === citation.n}
            onSelect={() => onSelectCitation(citation.n)}
          />
        ))}
      </ol>
    </div>
  );
}

function CitationCard({
  bucket,
  citation,
  active,
  onSelect,
}: {
  bucket: RagBucket;
  citation: RagCitation;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // jsdom has no scrollIntoView; the optional call keeps tests honest without a stub.
    if (active) {
      ref.current?.scrollIntoView?.({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, [active]);

  return (
    <li
      ref={ref}
      data-testid="citation-card"
      data-active={active || undefined}
      className={clsx(
        'rounded-lg border bg-white p-3 transition-colors duration-150',
        active ? 'border-brand-300 ring-1 ring-brand-100' : 'border-zinc-200',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Select source ${citation.n}`}
          className={clsx(
            'inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-meta font-medium tabular-nums transition-colors duration-150 focus-visible:brand-outline',
            active ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700 hover:bg-brand-100',
          )}
        >
          {citation.n}
        </button>
        <Link
          data-testid="citation-object"
          to="/buckets/$bucketName/objects"
          params={{ bucketName: bucket.name }}
          search={{ key: citation.objectKey, region: bucket.region }}
          title={citation.objectKey}
          className="min-w-0 truncate text-ui font-medium text-zinc-900 hover:text-brand-700 hover:underline focus-visible:brand-outline"
        >
          {objectBasename(citation.objectKey)}
        </Link>
        <span className="ml-auto shrink-0 font-mono text-meta text-zinc-500 tabular-nums">
          {formatCitationScore(citation)}
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-meta text-zinc-400" title={citation.objectKey}>
        {citation.objectKey} · chunk {citation.chunkIndex}
      </p>
      <p
        data-testid="citation-text"
        className={clsx('mt-2 text-xs leading-relaxed text-zinc-600', !active && 'line-clamp-3')}
      >
        {citation.text}
      </p>
    </li>
  );
}

/**
 * One compact line on how the query was served: mode, dataset version, index,
 * rows, bytes read from Forge (when the engine measured them) and timings.
 */
export function QueryTrace({ trace }: { trace: RagQueryTrace }) {
  const facts: { label: string; value: string; testId: string }[] = [
    { label: 'Mode', value: SEARCH_MODE_LABELS[trace.searchMode], testId: 'trace-mode' },
    { label: 'Version', value: `v${trace.version}`, testId: 'trace-version' },
    {
      label: 'Index',
      value: formatIndexType(trace.indexType),
      testId: 'trace-index',
    },
    { label: 'Rows', value: trace.rows.toLocaleString(), testId: 'trace-rows' },
  ];
  if (trace.io) facts.push({ label: 'Read', value: formatIo(trace.io), testId: 'trace-io' });

  const { embedMs, searchMs, answerMs, totalMs } = trace.timings;
  const timings: { label: string; ms: number }[] = [
    { label: 'Embed', ms: embedMs },
    { label: 'Search', ms: searchMs },
    ...(answerMs > 0 ? [{ label: 'Answer', ms: answerMs }] : []),
  ];

  return (
    <div
      data-testid="query-trace"
      className="mt-4 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-meta text-zinc-500"
    >
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        {facts.map((fact) => (
          <div key={fact.label} className="flex gap-1.5" data-testid={fact.testId}>
            <dt>{fact.label}</dt>
            <dd className="font-medium text-zinc-800 tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <dl
        data-testid="trace-timings"
        className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-100 pt-1.5"
      >
        {timings.map((t) => (
          <div key={t.label} className="flex gap-1.5">
            <dt>{t.label}</dt>
            <dd className="font-mono text-zinc-800 tabular-nums">{formatDuration(t.ms)}</dd>
          </div>
        ))}
        <div className="ml-auto flex gap-1.5">
          <dt>Total</dt>
          <dd className="font-mono font-medium text-zinc-900 tabular-nums">
            {formatDuration(totalMs)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** DESIGN.md rule 11: no movement under `prefers-reduced-motion`. jsdom has no `matchMedia`. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
