import { useQuery } from '@tanstack/react-query';

import { SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import type { AccessKeyBucketScope, ListBucketsResponse } from '@filone/shared';

import { apiRequest } from '../lib/api.js';
import { Checkbox } from './Checkbox.js';
import { Icon } from './Icon.js';
import { RadioOption } from './RadioOption.js';
import { queryKeys } from '../lib/query-client.js';

type AccessKeyBucketScopeFieldsProps = {
  bucketScope: AccessKeyBucketScope;
  onBucketScopeChange: (scope: AccessKeyBucketScope) => void;
  selectedBuckets: string[];
  onSelectedBucketsChange: (buckets: string[]) => void;
  /** Always show this bucket in the list even when unchecked (e.g. the bucket being created). */
  pinnedBucket?: string;
};

export function AccessKeyBucketScopeFields({
  bucketScope,
  onBucketScopeChange,
  selectedBuckets,
  onSelectedBucketsChange,
  pinnedBucket,
}: AccessKeyBucketScopeFieldsProps) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.buckets,
    queryFn: () => apiRequest<ListBucketsResponse>('/buckets'),
    enabled: bucketScope === 'specific',
  });
  const buckets = data?.buckets.map((b) => b.name) ?? [];
  const loading = isPending && bucketScope === 'specific';

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
      <div className="flex gap-2">
        {(['all', 'specific'] as const).map((scope) => (
          <RadioOption
            key={scope}
            name="bucket-scope"
            value={scope}
            checked={bucketScope === scope}
            onChange={() => onBucketScopeChange(scope)}
          >
            {scope === 'all' ? 'All buckets' : 'Specific buckets'}
          </RadioOption>
        ))}
      </div>

      {/* Bucket checklist (only when "specific" is selected) */}
      {bucketScope === 'specific' && (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
          {loading && (
            <div className="flex items-center justify-center py-4" role="status">
              <span className="text-brand-700 animate-spin">
                <Icon component={SpinnerIcon} size={20} />
              </span>
              <span className="sr-only">Loading buckets</span>
            </div>
          )}

          {isError && (
            <p className="text-sm text-red-600">{error?.message ?? 'Failed to load buckets'}</p>
          )}

          {!loading &&
            !isError &&
            buckets.length === 0 &&
            selectedBuckets.length === 0 &&
            !pinnedBucket && <p className="text-sm text-zinc-500">No buckets found.</p>}

          {!loading &&
            !isError &&
            (buckets.length > 0 || selectedBuckets.length > 0 || pinnedBucket) && (
              <div className="flex flex-col space-y-1.5">
                {[
                  ...new Set([
                    ...(pinnedBucket ? [pinnedBucket] : []),
                    ...selectedBuckets,
                    ...buckets,
                  ]),
                ].map((name) => (
                  <label key={name} className="flex cursor-pointer items-center gap-2.5 py-1">
                    <Checkbox
                      aria-label={name}
                      checked={selectedBuckets.includes(name)}
                      onChange={() => toggleBucket(name)}
                    />
                    <span className="text-sm font-normal text-zinc-900">{name}</span>
                  </label>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}
