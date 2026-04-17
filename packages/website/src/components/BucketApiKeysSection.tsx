import { useQuery } from '@tanstack/react-query';
import { KeyIcon, CaretDownIcon, CaretUpIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';

import type { AccessKey } from '@filone/shared';
import { getAccessKeys } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import type { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { AccessKeyFormFields } from './AccessKeyFormFields';
import { Badge } from './Badge';
import { Tooltip } from './Tooltip';

type BucketApiKeysSectionProps = {
  bucketName: string;
  form: ReturnType<typeof useAccessKeyForm>;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
};

function AllBucketKeyRow({ accessKey }: { accessKey: AccessKey }) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <KeyIcon
        size={13}
        className="shrink-0 text-(--color-paragraph-text-subtle)"
        aria-hidden="true"
      />
      <span className="flex-1 truncate text-xs text-(--color-paragraph-text-strong)">
        {accessKey.keyName}
      </span>
      <Tooltip content="Has access to all buckets, including this one" side="top">
        <Badge color="grey" size="sm">
          All buckets
        </Badge>
      </Tooltip>
    </div>
  );
}

export function BucketApiKeysSection({
  bucketName,
  form,
  createOpen,
  onCreateOpenChange,
}: BucketApiKeysSectionProps) {
  const { data } = useQuery({ queryKey: queryKeys.accessKeys, queryFn: getAccessKeys });

  const allBucketKeys = (data?.keys ?? []).filter(
    (k) => k.bucketScope === 'all' && k.status === 'active',
  );

  return (
    <div className="flex flex-col gap-2.5">
      <label className="text-xs font-medium text-(--color-text-base)">API keys</label>

      {/* Existing all-bucket keys */}
      {allBucketKeys.length > 0 && (
        <div className="rounded-md border border-(--input-border-color) bg-zinc-50 px-3 py-1">
          {allBucketKeys.map((key, i) => (
            <div key={key.id} className={i > 0 ? 'border-t border-(--color-border-muted)' : ''}>
              <AllBucketKeyRow accessKey={key} />
            </div>
          ))}
        </div>
      )}

      {/* Create new key toggle */}
      <button
        type="button"
        onClick={() => onCreateOpenChange(!createOpen)}
        className="flex w-full items-center justify-between rounded-md border border-(--input-border-color) bg-white px-3 py-2.5 text-left hover:bg-zinc-50"
      >
        <div className="flex items-center gap-2">
          <PlusIcon size={14} className="text-(--color-paragraph-text-subtle)" aria-hidden="true" />
          <span className="text-[13px] text-(--color-text-base)">Create new key</span>
        </div>
        {createOpen ? (
          <CaretUpIcon
            size={14}
            className="text-(--color-paragraph-text-subtle)"
            aria-hidden="true"
          />
        ) : (
          <CaretDownIcon
            size={14}
            className="text-(--color-paragraph-text-subtle)"
            aria-hidden="true"
          />
        )}
      </button>

      {createOpen && (
        <div className="rounded-lg border border-(--input-border-color) p-4">
          <AccessKeyFormFields form={form} pinnedBucket={bucketName || undefined} />
        </div>
      )}
    </div>
  );
}
