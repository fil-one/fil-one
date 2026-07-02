import { Link } from '@tanstack/react-router';

import type { RagBucket } from '../lib/rag-bucket-api.js';

export type QuerySourcesProps = {
  bucket: RagBucket;
  sources: string[];
};

/** Source-document pills linking into the bucket's object viewer. */
export function QuerySources({ bucket, sources }: QuerySourcesProps) {
  if (sources.length === 0) return null;
  return (
    <div
      data-testid="query-sources"
      className="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-3"
    >
      {sources.map((source) => (
        <Link
          key={source}
          data-testid="query-sources-item"
          to="/buckets/$bucketName/objects"
          params={{ bucketName: bucket.name }}
          search={{ key: source, region: bucket.region }}
          title={source}
          className="inline-flex items-center rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-[11px] text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900"
        >
          {source.split('/').pop() ?? source}
        </Link>
      ))}
    </div>
  );
}
