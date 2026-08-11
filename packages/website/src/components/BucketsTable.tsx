import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { EyeSlashIcon, MagnifyingGlassIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import type { Bucket, S3Region } from '@filone/shared';
import { S3_REGION, getRegionLabel } from '@filone/shared';

import { Badge } from './Badge';
import { Button } from './Button';
import { EmptyStateCard } from './EmptyStateCard';
import { IconButton } from './IconButton';
import { RegionFlag } from './RegionFlag';
import { Table } from './Table/Table';
import { Tooltip } from './Tooltip';
import { BucketsToolbar } from './BucketsToolbar';
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
              <Table.Head {...sortProps('region')}>Region</Table.Head>
              <Table.Head {...sortProps('createdAt')}>Created</Table.Head>
              <Table.Head>Features</Table.Head>
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

/**
 * Versioning and Object Lock badges. Object Lock requires versioning, so a
 * locked bucket always shows both; the retention policy rides in the lock
 * badge's tooltip rather than earning a third badge.
 */
function BucketFeatures({ bucket }: { bucket: Bucket }) {
  const retention = formatRetention(
    bucket.defaultRetention,
    bucket.retentionDuration,
    bucket.retentionDurationType,
  );

  if (!bucket.versioning && !bucket.objectLockEnabled) {
    return <span className="text-xs text-zinc-500">&mdash;</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {bucket.versioning && (
        <Badge color="blue" size="sm" weight="medium">
          Versioned
        </Badge>
      )}
      {bucket.objectLockEnabled && (
        <Tooltip
          content={retention ? `Object Lock · default retention ${retention}` : 'Object Lock'}
          side="top"
        >
          <Badge color="amber" size="sm" weight="medium">
            Object Lock
          </Badge>
        </Tooltip>
      )}
    </div>
  );
}

function BucketRow({ bucket, onDelete }: { bucket: Bucket; onDelete: (name: string) => void }) {
  const region = bucket.region ?? S3_REGION;

  return (
    <Table.Row data-testid="bucket-row" data-bucket-name={bucket.bucketName}>
      <Table.Cell>
        <div className="flex items-center gap-1.5">
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
                size={13}
                role="img"
                aria-label="Private bucket"
                className="text-zinc-500"
              />
            </Tooltip>
          )}
        </div>
      </Table.Cell>
      <Table.Cell className="text-xs">
        <div className="flex items-center gap-2.5">
          <RegionFlag region={region} />
          <div>
            <p className="font-medium text-zinc-900">{getRegionLabel(bucket.region)}</p>
            <p className="text-zinc-500">{region}</p>
          </div>
        </div>
      </Table.Cell>
      {/* text-xs to match the region cell beside it */}
      <Table.Cell className="text-xs text-zinc-600">{formatDate(bucket.createdAt)}</Table.Cell>
      <Table.Cell>
        <BucketFeatures bucket={bucket} />
      </Table.Cell>
      <Table.Cell className="text-right">
        <Tooltip
          content="Deleting buckets is not available yet"
          side="left"
          className="align-middle"
        >
          <IconButton
            icon={TrashIcon}
            aria-label={`Delete bucket ${bucket.bucketName}`}
            onClick={() => onDelete(bucket.bucketName)}
            // TODO: enable bucket deletion after Aurora implements this operation
            // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
            disabled
          />
        </Tooltip>
      </Table.Cell>
    </Table.Row>
  );
}
