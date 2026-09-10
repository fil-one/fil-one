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
import { useHasPermission } from '../lib/use-permissions.js';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';
import { formatDate } from '../lib/time.js';
import { useOrgSlug } from '../lib/use-org-path.js';
import {
  EMPTY_BUCKET_FILTERS,
  type BucketFilters,
  type BucketSort,
  type BucketSortKey,
  nextBucketSort,
} from '../lib/bucket-table.js';

/**
 * Columns dropped below `sm`. Four columns plus cell padding overflow a phone, and
 * horizontal scrolling would push the row's action menu off-screen. What's left
 * is the name, its secondary line (region and storage), and the actions; the
 * bucket detail page carries the rest.
 */
const SECONDARY_COLUMN = 'hidden sm:table-cell';

type BucketsTableProps = {
  /** Already filtered and sorted server-side; this component only renders. */
  buckets: Bucket[];
  onDelete: (bucketName: string) => void;
  showControls: boolean;
  filters: BucketFilters;
  onFiltersChange: (filters: BucketFilters) => void;
  sort: BucketSort;
  onSortChange: (sort: BucketSort) => void;
  regions: string[];
  matchCount: number;
  totalCount: number;
};

export function BucketsTable({
  buckets,
  onDelete,
  showControls,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  regions,
  matchCount,
  totalCount,
}: BucketsTableProps) {
  // Short lists are scannable as they are, so they keep plain, inert headers.
  const sortProps = (key: BucketSortKey) =>
    showControls
      ? {
          onSort: () => onSortChange(nextBucketSort(sort, key)),
          sortDirection: sort.key === key ? sort.direction : undefined,
        }
      : {};

  return (
    <>
      {showControls && (
        <BucketsToolbar
          filters={filters}
          onChange={onFiltersChange}
          regions={regions}
          matchCount={matchCount}
          totalCount={totalCount}
        />
      )}

      {buckets.length === 0 ? (
        <EmptyStateCard
          icon={MagnifyingGlassIcon}
          iconColor="grey"
          title="No matching buckets"
          description="No bucket matches your search and filters."
        >
          <Button
            id="buckets-clear-filters-button"
            variant="ghost"
            onClick={() => onFiltersChange(EMPTY_BUCKET_FILTERS)}
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
              <Table.Head>
                <span className="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {buckets.map((bucket) => (
              <BucketRow key={bucket.bucketName} bucket={bucket} onDelete={onDelete} />
            ))}
          </Table.Body>
        </Table>
      )}
    </>
  );
}

/**
 * Row actions. Delete opens the page's confirm dialog rather than acting
 * immediately, since it's destructive and the bucket must be empty first.
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
  const orgSlug = useOrgSlug();
  const { copy } = useCopyToClipboard();
  const { toast } = useToast();
  const mayDelete = useHasPermission('buckets.delete');

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
              to: '/$orgSlug/buckets/$bucketName',
              params: { orgSlug, bucketName: bucket.bucketName },
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
        // Deletion is `buckets.delete`: Owner and Admin only. The item is
        // absent for everyone else rather than disabled — a disabled Delete
        // invites a support question about a capability the member will
        // never have.
        ...(mayDelete
          ? [
              {
                label: 'Delete bucket',
                icon: TrashIcon,
                onSelect: () => onDelete(bucket.bucketName),
              },
            ]
          : []),
      ]}
    />
  );
}

function BucketRow({ bucket, onDelete }: { bucket: Bucket; onDelete: (name: string) => void }) {
  const region = bucket.region ?? S3_REGION;
  const orgSlug = useOrgSlug();

  return (
    <Table.Row data-testid="bucket-row" data-bucket-name={bucket.bucketName}>
      {/* py-4 rather than the cell default: this is the only two-line cell, so it
          sets the row height, and 12px reads tight around a stacked pair. The
          other cells stay vertically centred against it. */}
      <Table.Cell className="py-4">
        <div className="flex items-center gap-1.5 leading-tight">
          <Link
            to="/$orgSlug/buckets/$bucketName"
            params={{ orgSlug, bucketName: bucket.bucketName }}
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
            <Tooltip content="Private bucket" side="top" focusable>
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
      <Table.Cell className="text-right">
        <BucketRowActions bucket={bucket} region={region} onDelete={onDelete} />
      </Table.Cell>
    </Table.Row>
  );
}
