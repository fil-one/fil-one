import type { QueryBucketResponse } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api.js';
import { Alert } from './Alert.js';
import { QuerySources } from './QuerySources.js';

export type QueryAnswerProps = {
  bucket: RagBucket;
  question: string | null;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  result: QueryBucketResponse | undefined;
};

/** Renders the query result region — loading skeleton, error, or grounded answer. */
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
        <div data-testid="query-answer-loading" className="space-y-2.5" aria-label="Loading answer">
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
        <>
          <p data-testid="query-answer-text" className="text-sm leading-relaxed text-zinc-700">
            {result.answer}
          </p>
          <QuerySources bucket={bucket} sources={result.sources} />
        </>
      ) : null}
    </div>
  );
}
