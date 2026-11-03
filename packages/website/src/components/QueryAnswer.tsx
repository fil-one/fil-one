import { useState } from 'react';

import type { QueryBucketResponse } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api.js';
import { Alert } from './Alert.js';
import { CitationList, CitedAnswer, QueryTrace } from './QueryCitations.js';
import { QuerySources } from './QuerySources.js';

export type QueryAnswerProps = {
  bucket: RagBucket;
  question: string | null;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  result: QueryBucketResponse | undefined;
};

/**
 * Renders the query result region — loading skeleton, error, or grounded answer.
 *
 * Engine-backed (Forge) answers carry numbered citations and a trace; those
 * render with clickable `[n]` markers, the cited passages and how the query was
 * served. Answers without citations keep the plain text and source pills.
 */
export function QueryAnswer({
  bucket,
  question,
  isPending,
  isError,
  error,
  result,
}: QueryAnswerProps) {
  if (!((isPending && question) || isError || result)) return null;
  return (
    <div
      data-testid="query-answer"
      className="mt-4 rounded-lg border border-zinc-100 bg-zinc-50/50 p-4"
    >
      {question && (
        <p data-testid="query-answer-question" className="mb-3 text-xs italic text-zinc-400">
          "{question}"
        </p>
      )}
      {isPending ? (
        <div data-testid="query-answer-loading" role="status" className="space-y-2.5">
          <span className="sr-only">Loading answer</span>
          <div className="h-2 w-3/4 animate-pulse rounded-full bg-zinc-200" />
          <div className="h-2 w-full animate-pulse rounded-full bg-zinc-200" />
          <div className="h-2 w-5/6 animate-pulse rounded-full bg-zinc-200" />
          <div className="h-2 w-2/3 animate-pulse rounded-full bg-zinc-200" />
        </div>
      ) : isError ? (
        <div data-testid="query-answer-error">
          <Alert
            variant="red"
            description={
              error instanceof Error ? error.message : 'Something went wrong. Try again.'
            }
          />
        </div>
      ) : result ? (
        <QueryResult bucket={bucket} result={result} />
      ) : null}
    </div>
  );
}

function EngineAnswer({ bucket, result }: { bucket: RagBucket; result: QueryBucketResponse }) {
  // Tied to the result it was made on, so a new answer starts with nothing selected.
  const [selected, setSelected] = useState<{ result: QueryBucketResponse; n: number } | null>(null);
  const activeCitation = selected?.result === result ? selected.n : null;
  const setActiveCitation = (n: number) => setSelected({ result, n });
  const citations = result.citations ?? [];
  return (
    <>
      {result.answer ? (
        <CitedAnswer
          answer={result.answer}
          citations={citations}
          activeCitation={activeCitation}
          onSelectCitation={setActiveCitation}
        />
      ) : (
        <p data-testid="query-answer-empty" className="text-sm text-zinc-500">
          {citations.length > 0
            ? 'No answer was generated. These are the closest passages.'
            : 'Nothing in this bucket matched the question.'}
        </p>
      )}
      <CitationList
        bucket={bucket}
        citations={citations}
        activeCitation={activeCitation}
        onSelectCitation={setActiveCitation}
      />
      {result.trace && <QueryTrace trace={result.trace} />}
    </>
  );
}

/** Engine answers carry citations; everything else is plain text plus source pills. */
function QueryResult({ bucket, result }: { bucket: RagBucket; result: QueryBucketResponse }) {
  if (result.citations) return <EngineAnswer bucket={bucket} result={result} />;
  return (
    <>
      <p data-testid="query-answer-text" className="text-sm leading-relaxed text-zinc-700">
        {result.answer}
      </p>
      <QuerySources bucket={bucket} sources={result.sources} />
    </>
  );
}
