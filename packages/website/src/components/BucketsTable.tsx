import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  CopyIcon,
  EyeSlashIcon,
  FolderOpenIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { Bucket, S3Region } from '@filone/shared';
import { S3_REGION, getRegionLabel, getS3Endpoint } from '@filone/shared';

import { Badge } from './Badge';
import { Button } from './Button';
import { EmptyStateCard } from './EmptyStateCard';
import { RegionFlag } from './RegionFlag';
import { Table } from './Table/Table';
import { Tooltip } from './Tooltip';
import { BucketsToolbar } from './BucketsToolbar';
import { BucketActionMenu } from './BucketActionMenu';
import { BucketStorageLine } from './BucketStorageLine';
import { useToast } from './Toast';
import { FILONE_STAGE } from '../env.js';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';
import { formatDate } from '../lib/time.js';
import { formatRetention } from '../lib/retention.js';
import {
  DEFAULT_BUCKET_SORT,
  EMPTY_BUCKET_FILTERS,
  type BucketSortKey,
  bucketRegions,
  filterBuckets,
  nextBucketSort,
  shouldShowBucketControls,
  sortBuckets,
} from '../lib/bucket-table.js';

/**
 * Columns dropped below `sm`. Six columns plus cell padding overflow a phone, and
 * horizontal scrolling would push the row's action menu off-screen. What's left
 * is the name, its secondary line (region and storage), and the actions; the
 * bucket detail page carries the rest.
 */
const SECONDARY_COLUMN = 'hidden sm:table-cell';

type BucketsTableProps = {
  buckets: Bucket[];
  onDelete: (bucketName: string) => void;
};

export function BucketsTable({ buckets, onDelete }: BucketsTableProps) {
  const [filters, setFilters] = useState(EMPTY_BUCKET_FILTERS);
  const [sort, setSort] = useState(DEFAULT_BUCKET_SORT);

  // Gated on the total, not the filtered count, so narrowing a search down to a
  // couple of rows can't pull the search field out from under the cursor.
  const showControls = shouldShowBucketControls(buckets.length);
  const regions = useMemo(() => bucketRegions(buckets), [buckets]);
  const visibleBuckets = useMemo(
    () => sortBuckets(showControls ? filterBuckets(buckets, filters) : buckets, sort),
    [buckets, filters, sort, showControls],
  );

  // Short lists are scannable as they are, so they keep plain, inert headers.
  const sortProps = (key: BucketSortKey) =>
    showControls
      ? {
          onSort: () => setSort((current) => nextBucketSort(current, key)),
          sortDirection: sort.key === key ? sort.direction : undefined,
        }
      : {};

  return (
    <>
      {showControls && (
        <BucketsToolbar
          filters={filters}
          onChange={setFilters}
          regions={regions}
          matchCount={visibleBuckets.length}
          totalCount={buckets.length}
        />
      )}

      {visibleBuckets.length === 0 ? (
        <EmptyStateCard
          icon={MagnifyingGlassIcon}
          iconColor="grey"
          title="No matching buckets"
          description="No bucket matches your search and filters."
        >
          <Button
            id="buckets-clear-filters-button"
            variant="ghost"
            onClick={() => setFilters(EMPTY_BUCKET_FILTERS)}
          >
            Clear filters
          </Button>
        </EmptyStateCard>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head {...sortProps('bucketName')}>Name</Table.Head>
              <Table.Head {...sortProps('region')} className={SECONDARY_COLUMN}>
                Region
              </Table.Head>
              <Table.Head {...sortProps('createdAt')} className={SECONDARY_COLUMN}>
                Created
              </Table.Head>
              <Table.Head className={SECONDARY_COLUMN}>Features</Table.Head>
              <Table.Head className={SECONDARY_COLUMN}>Retention</Table.Head>
              <Table.Head aria-label="Actions" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {visibleBuckets.map((bucket) => (
              <BucketRow key={bucket.bucketName} bucket={bucket} onDelete={onDelete} />
            ))}
          </Table.Body>
        </Table>
      )}
    </>
  );
}

/** Versioning and Object Lock. Object Lock requires versioning, so a locked bucket shows both. */
function BucketFeatures({ bucket }: { bucket: Bucket }) {
  // Says "None" rather than an em-dash, to match the Retention column beside it:
  // a dash next to a worded empty state reads as a rendering slip.
  if (!bucket.versioning && !bucket.objectLockEnabled) {
    return <span className="text-xs text-zinc-500">None</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {bucket.versioning && (
        <Badge color="blue" size="sm" weight="medium">
          Versioned
        </Badge>
      )}
      {bucket.objectLockEnabled && (
        <Badge color="amber" size="sm" weight="medium">
          Object Lock
        </Badge>
      )}
    </div>
  );
}

/**
 * The bucket's default retention policy, as mode and duration.
 *
 * Not a date: what a bucket holds is the policy applied to new objects, so the
 * retain-until date differs per object by upload time. That date lives on the
 * object, from GetObjectRetention, and the object detail page shows it there.
 */
function BucketRetention({ bucket }: { bucket: Bucket }) {
  const retention = formatRetention(
    bucket.defaultRetention,
    bucket.retentionDuration,
    bucket.retentionDurationType,
  );

  if (!retention) return <span className="text-xs text-zinc-500">No retention</span>;

  return (
    <Tooltip content="Applied to objects uploaded from now on" side="top">
      <span className="text-xs text-zinc-900">{retention}</span>
    </Tooltip>
  );
}

/**
 * Row actions. Delete stays in the menu, disabled with the reason, so the column
 * carries the things you can actually do instead of one button that can't run.
 */
function BucketRowActions({
  bucket,
  region,
  onDelete,
}: {
  bucket: Bucket;
  region: string;
  onDelete: (name: string) => void;
}) {
  const navigate = useNavigate();
  const { copy } = useCopyToClipboard();
  const { toast } = useToast();

  const copyValue = (label: string, value: string) => {
    void copy(value).then(() => toast.success(`${label} copied`));
  };

  return (
    <BucketActionMenu
      actions={[
        {
          label: 'Browse objects',
          icon: FolderOpenIcon,
          onSelect: () =>
            void navigate({
              to: '/buckets/$bucketName',
              params: { bucketName: bucket.bucketName },
              search: { region: region as S3Region },
            }),
        },
        {
          label: 'Copy bucket name',
          icon: CopyIcon,
          onSelect: () => copyValue('Bucket name', bucket.bucketName),
        },
        {
          label: 'Copy S3 endpoint',
          icon: LinkSimpleIcon,
          onSelect: () => copyValue('S3 endpoint', getS3Endpoint(region as S3Region, FILONE_STAGE)),
        },
        {
          label: 'Delete bucket',
          icon: TrashIcon,
          // TODO: enable bucket deletion after Aurora implements this operation
          // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
          disabled: true,
          hint: 'Not available yet',
          onSelect: () => onDelete(bucket.bucketName),
        },
      ]}
    />
  );
}

function BucketRow({ bucket, onDelete }: { bucket: Bucket; onDelete: (name: string) => void }) {
  const region = bucket.region ?? S3_REGION;

  return (
    <Table.Row data-testid="bucket-row" data-bucket-name={bucket.bucketName}>
      {/* py-4 rather than the cell default: this is the only two-line cell, so it
          sets the row height, and 12px reads tight around a stacked pair. The
          other cells stay vertically centred against it. */}
      <Table.Cell className="py-4">
        <div className="flex items-center gap-1.5 leading-tight">
          <Link
            to="/buckets/$bucketName"
            params={{ bucketName: bucket.bucketName }}
            search={{ region: bucket.region as S3Region }}
            data-testid="bucket-link"
            className="font-medium text-zinc-900 hover:text-brand-600"
          >
            {bucket.bucketName}
          </Link>
          {/* Only private buckets are marked. Every bucket is private today, so
              when public ones arrive this stays the quiet state and "public" is
              what gets called out. */}
          {!bucket.isPublic && (
            <Tooltip content="Private bucket" side="top">
              {/* An eye, not a lock: the lock glyphs are spoken for elsewhere
                  (LockIcon is Object Lock, LockSimpleIcon is Default Retention),
                  so locks mean immutability here and the eye means visibility.
                  zinc-500 because non-text graphics need 3:1 (WCAG 1.4.11) and
                  zinc-400 is 2.56:1 on white. */}
              <EyeSlashIcon
                size={15}
                role="img"
                aria-label="Private bucket"
                className="text-zinc-500"
              />
            </Tooltip>
          )}
        </div>
        {/* The secondary line reserves its height in every state, so a row whose
            storage read fails doesn't sit shorter than its neighbours. */}
        <div className="mt-1 flex min-h-4 items-center gap-1.5 text-xs text-zinc-500 tabular-nums">
          {/* Region rides here below `sm`, where its column is hidden. */}
          <span className="flex items-center gap-1.5 sm:hidden">
            <RegionFlag region={region} />
            {region}
          </span>
          <BucketStorageLine bucketName={bucket.bucketName} region={region as S3Region} />
        </div>
      </Table.Cell>
      <Table.Cell className={`text-xs ${SECONDARY_COLUMN}`}>
        <div className="flex items-center gap-2.5">
          <RegionFlag region={region} />
          <div>
            <p className="font-medium text-zinc-900">{getRegionLabel(bucket.region)}</p>
            <p className="text-zinc-500">{region}</p>
          </div>
        </div>
      </Table.Cell>
      {/* text-xs to match the region cell beside it */}
      <Table.Cell className={`text-xs text-zinc-600 ${SECONDARY_COLUMN}`}>
        {formatDate(bucket.createdAt)}
      </Table.Cell>
      <Table.Cell className={SECONDARY_COLUMN}>
        <BucketFeatures bucket={bucket} />
      </Table.Cell>
      <Table.Cell className={SECONDARY_COLUMN}>
        <BucketRetention bucket={bucket} />
      </Table.Cell>
      <Table.Cell className="text-right">
        <BucketRowActions bucket={bucket} region={region} onDelete={onDelete} />
      </Table.Cell>
    </Table.Row>
  );
}
