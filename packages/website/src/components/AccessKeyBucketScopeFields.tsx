import { useEffect, useState } from 'react';

import { SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import type { AccessKeyBucketScope, ListBucketsResponse } from '@filone/shared';

import { apiRequest } from '../lib/api.js';
import { Checkbox } from './Checkbox.js';
import { Icon } from './Icon.js';

type AccessKeyBucketScopeFieldsProps = {
  bucketScope: AccessKeyBucketScope;
  onBucketScopeChange: (scope: AccessKeyBucketScope) => void;
  selectedBuckets: string[];
  onSelectedBucketsChange: (buckets: string[]) => void;
};

export function AccessKeyBucketScopeFields({
  bucketScope,
  onBucketScopeChange,
  selectedBuckets,
  onSelectedBucketsChange,
}: AccessKeyBucketScopeFieldsProps) {
  const [buckets, setBuckets] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  useEffect(() => {
    if (bucketScope !== 'specific' || fetched) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    apiRequest<ListBucketsResponse>('/buckets')
      .then((data) => {
        if (cancelled) return;
        setBuckets(data.buckets.map((b) => b.name));
        setFetched(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load buckets');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [bucketScope, fetched]);

  function toggleBucket(name: string) {
    if (selectedBuckets.includes(name)) {
      onSelectedBucketsChange(selectedBuckets.filter((b) => b !== name));
    } else {
      onSelectedBucketsChange([...selectedBuckets, name]);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Scope radio buttons */}
      <div className="flex gap-3">
        {(['all', 'specific'] as const).map((scope) => (
          <label
            key={scope}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2.5 text-sm hover:bg-zinc-50 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50"
          >
            <input
              type="radio"
              name="bucket-scope"
              value={scope}
              checked={bucketScope === scope}
              onChange={() => onBucketScopeChange(scope)}
              className="accent-brand-600"
            />
            <span className="font-medium text-zinc-900">
              {scope === 'all' ? 'All buckets' : 'Specific buckets'}
            </span>
          </label>
        ))}
      </div>

      {/* Bucket checklist (only when "specific" is selected) */}
      {bucketScope === 'specific' && (
        <div className="mt-1 rounded-lg border border-zinc-200 bg-white">
          {loading && (
            <div className="flex items-center justify-center py-6" role="status">
              <span className="text-brand-700 animate-spin">
                <Icon component={SpinnerIcon} size={20} />
              </span>
              <span className="sr-only">Loading buckets</span>
            </div>
          )}

          {error && <p className="px-4 py-3 text-sm text-red-600">{error}</p>}

          {!loading && !error && buckets.length === 0 && (
            <p className="px-4 py-3 text-sm text-zinc-500">No buckets found.</p>
          )}

          {!loading && !error && buckets.length > 0 && (
            <div className="flex flex-col">
              {buckets.map((name) => (
                <label
                  key={name}
                  className="flex cursor-pointer items-center gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-b-0 hover:bg-zinc-50"
                >
                  <Checkbox
                    checked={selectedBuckets.includes(name)}
                    onChange={() => toggleBucket(name)}
                  />
                  <span className="text-sm font-medium text-zinc-900">{name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
