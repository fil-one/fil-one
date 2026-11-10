import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { S3Region, type ListObjectVersionsResponse, type S3ObjectVersion } from '@filone/shared';

import { BucketDetailsDrawer } from './BucketDetailsDrawer';
import { ColdStorageAnnouncementDialog } from './ColdStorageAnnouncement';
import { ConfirmDialog } from './ConfirmDialog';
import { ColdStorageBadge, FileStorageBadge, FolderStorageBadge } from './ColdStorageStatus';
import { FreezeBucketDialog } from './FreezeBucketDialog';
import { KeepInStandardDialog } from './KeepInStandardDialog';
import { RestoreFilesDialog } from './RestoreFilesDialog';
import { RestoreProgress } from './RestoreProgress';
import { describeColdDelete } from '../lib/cold-storage-prototype.js';
import { queryKeys } from '../lib/query-client.js';

/**
 * The cold storage prototype (FIL-1608), one story per screen and state.
 * Freezing is per file: a bucket holds freeze policies, and each file is
 * Standard, scheduled, frozen, restoring, restored or unfrozen.
 */
const meta: Meta = {
  title: 'Prototypes/Cold storage',
};

export default meta;
type Story = StoryObj;

const BUCKET = 'client-projects';
const REGION = S3Region.EuWest1;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const term = { frozenAt: now - 10 * DAY, termEndsAt: now + 80 * DAY };

function file(key: string, sizeBytes: number): S3ObjectVersion {
  return {
    key,
    sizeBytes,
    lastModified: '2026-01-10T09:00:00Z',
    versionId: '',
    isLatest: true,
    isDeleteMarker: false,
  };
}

const FRAMES = [file('2025/acme/final-cut.mov', 412e9), file('2025/acme/b-roll.mov', 96e9)];

/** Shown once, on the first visit after launch. */
export const Announcement: Story = {
  render: () => <ColdStorageAnnouncementDialog open onClose={() => {}} onViewBuckets={() => {}} />,
};

/**
 * The freeze review before the bucket page has listed the files, as from the
 * Buckets table: the small-file term states the rule without a count.
 */
export const FreezeReview: Story = {
  render: () => (
    <FreezeBucketDialog target={{ bucketName: BUCKET, region: REGION }} onClose={() => {}} />
  ),
};

// The listing goes into the preview's client, seeded before the first render
// and never stale, since no server answers a refetch.
function FreezeReviewWithListing({ versions }: { versions: S3ObjectVersion[] }) {
  const queryClient = useQueryClient();
  useState(() => {
    const key = queryKeys.objects(BUCKET, REGION);
    queryClient.setQueryDefaults(key, { staleTime: Infinity });
    queryClient.setQueryData<ListObjectVersionsResponse>(key, { versions, isTruncated: false });
  });
  return <FreezeBucketDialog target={{ bucketName: BUCKET, region: REGION }} onClose={() => {}} />;
}

const SMALL_FILES = Array.from({ length: 214 }, (_, i) => file(`2025/acme/stills/${i}.jpg`, 90e3));

/** The freeze review from a bucket page, counting the files too small to freeze. */
export const FreezeReviewSmallFiles: Story = {
  render: () => <FreezeReviewWithListing versions={[...FRAMES, ...SMALL_FILES]} />,
};

/** No file is under 128 KB, so the small-file term doesn't show. */
export const FreezeReviewNoSmallFiles: Story = {
  render: () => <FreezeReviewWithListing versions={FRAMES} />,
};

/** Freezing one file picked in the table. */
export const FreezeFile: Story = {
  render: () => (
    <FreezeBucketDialog
      target={{ bucketName: BUCKET, region: REGION, keys: ['2025/acme/final-cut.mov'] }}
      onClose={() => {}}
    />
  ),
};

/** Restoring from a selection, with the folder and the whole bucket as wider choices. */
export const Restore: Story = {
  render: () => (
    <RestoreFilesDialog
      target={{
        bucketName: BUCKET,
        region: REGION,
        scopes: [
          { id: 'selection', label: 'final-cut.mov', versions: FRAMES.slice(0, 1) },
          { id: 'folder', label: 'Everything in 2025/acme/', versions: FRAMES },
          {
            id: 'bucket',
            label: 'The whole bucket',
            versions: [...FRAMES, file('2024/zeta/master.mov', 380e9)],
          },
        ],
      }}
      onClose={() => {}}
    />
  ),
};

/** Keeping a restored file in Standard for good, inside its minimum term. */
export const KeepInStandard: Story = {
  render: () => (
    <KeepInStandardDialog
      target={{
        bucketName: BUCKET,
        region: REGION,
        keys: ['2025/acme/final-cut.mov'],
        inTermCount: 1,
      }}
      onClose={() => {}}
    />
  ),
};

/** Every file state as the Storage column shows it. Standard is plain text. */
export const FileStates: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <FileStorageBadge state={{ status: 'standard', belowMinimum: false }} now={now} />
      <FileStorageBadge
        state={{ status: 'scheduled', freezesAt: now + 6 * 60 * 60 * 1000 }}
        now={now}
      />
      <FileStorageBadge state={{ status: 'frozen', ...term }} now={now} />
      <FileStorageBadge
        state={{
          status: 'restoring',
          ...term,
          readyAt: now + 55 * 60 * 1000,
          expiresAt: now + 14 * DAY,
        }}
        now={now}
      />
      <FileStorageBadge
        state={{ status: 'restored', ...term, expiresAt: now + 13 * DAY }}
        now={now}
      />
      <FileStorageBadge state={{ status: 'kept' }} now={now} />
    </div>
  ),
};

/** Every folder state as the Storage column shows it. A folder with no rule shows a dash. */
export const FolderStates: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <FolderStorageBadge state={{ status: 'standard' }} />
      <FolderStorageBadge state={{ status: 'scheduled', freezesAt: now + 6 * 60 * 60 * 1000 }} />
      <FolderStorageBadge state={{ status: 'frozen', restoredCount: 2 }} />
      <FolderStorageBadge state={{ status: 'partly-frozen' }} />
    </div>
  ),
};

/**
 * On the bucket page the pill also restores: with a mouse it turns into
 * Restore on hover; on a touch screen a Restore button sits beside it.
 */
export const BucketBadgeRestore: Story = {
  render: () => {
    const base = { prefixes: [], fileCount: 0, firstRunAt: now - DAY, activeRestores: 0 };
    return (
      <div className="flex flex-col items-start gap-3">
        <ColdStorageBadge
          summary={{ ...base, scope: 'bucket', scheduled: false }}
          onRestore={() => {}}
        />
        <ColdStorageBadge
          summary={{ ...base, scope: 'folders', prefixes: ['2025/'], scheduled: false }}
          onRestore={() => {}}
        />
      </div>
    );
  },
};

/** A bucket's pill in the Buckets table and on its page, by what its policy covers. */
export const BucketStates: Story = {
  render: () => {
    const base = { prefixes: [], fileCount: 0, firstRunAt: now + DAY, activeRestores: 0 };
    return (
      <div className="flex flex-col items-start gap-3">
        <ColdStorageBadge summary={{ ...base, scope: 'bucket', scheduled: true }} />
        <ColdStorageBadge summary={{ ...base, scope: 'bucket', scheduled: false }} />
        <ColdStorageBadge
          summary={{ ...base, scope: 'folders', prefixes: ['2025/'], scheduled: false }}
        />
      </div>
    );
  },
};

/** Bucket details, opened from the info button beside the bucket's name. */
export const BucketDetails: Story = {
  render: () => (
    <BucketDetailsDrawer
      bucket={{ bucketName: BUCKET, region: REGION, isPublic: false, versioning: true }}
      region={REGION}
      bytesUsed={66e12}
      objectCount={1_534}
      onClose={() => {}}
    />
  ),
};

/** Deleting a restored file inside its minimum term: the copy goes too, and the term still bills. */
export const DeleteRestoredFile: Story = {
  render: () => (
    <ConfirmDialog
      open
      onClose={() => {}}
      onConfirm={() => Promise.resolve()}
      title="Delete object"
      description="This object will be permanently deleted. This action cannot be undone."
      notice={describeColdDelete([{ status: 'restored', ...term, expiresAt: now + 13 * DAY }], now)}
      confirmLabel="Delete"
    />
  ),
};

/** A folder restore part-way through, counted above the file list. */
export const RestoreInProgress: Story = {
  render: () => (
    <RestoreProgress
      jobs={[
        {
          job: { id: 'any-job', label: 'Everything in 2025/acme/', keys: [], startedAt: now },
          progress: { ready: 12, total: 40 },
        },
      ]}
    />
  ),
};
