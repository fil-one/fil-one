import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { S3Region } from '@filone/shared';

import { ColdStorageAnnouncementDialog } from './ColdStorageAnnouncement';
import { ColdStorageMeta } from './BucketColdStorage';
import { ColdStorageStatus } from './ColdStorageStatus';
import { FreezeBucketDialog } from './FreezeBucketDialog';
import { GetDataBackDialog } from './GetDataBackDialog';
import { ExtendRestoreDialog } from './ExtendRestoreDialog';
import { DeleteFrozenCopyDialog } from './DeleteFrozenCopyDialog';
import { freezeBucket, setLargeBucket } from '../lib/cold-storage-prototype.js';

/**
 * The cold storage prototype (FIL-1608), one story per screen and state. The
 * dialogs price the bucket at 70 TB, as the prototype does for its stand-in
 * archive, so the figures match the user flow's YouTuber.
 */
const meta: Meta = {
  title: 'Prototypes/Cold storage',
};

export default meta;
type Story = StoryObj;

const BUCKET = 'raw-footage-archive';
const REGION = S3Region.EuWest1;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const term = { frozenAt: now - 10 * DAY, termEndsAt: now + 80 * DAY, bytes: 70e12 };

/** Shown once, on the first visit after launch. */
export const Announcement: Story = {
  render: () => <ColdStorageAnnouncementDialog open onClose={() => {}} onViewBuckets={() => {}} />,
};

/** Makes the story's bucket the 70 TB stand-in, so the dialogs price it. */
function LargeBucket({ children }: { children: React.ReactNode }) {
  useState(() => setLargeBucket(BUCKET, REGION));
  return children;
}

export const FreezeReview: Story = {
  render: () => (
    <LargeBucket>
      <FreezeBucketDialog target={{ bucketName: BUCKET, region: REGION }} onClose={() => {}} />
    </LargeBucket>
  ),
};

/** The dialogs read the bucket's state from the prototype store, so these freeze it first. */
function FrozenFirst({ children }: { children: React.ReactNode }) {
  useState(() => {
    setLargeBucket(BUCKET, REGION);
    freezeBucket(BUCKET, REGION, 70e12);
  });
  return children;
}

/** Restoring a frozen bucket: one way back, a copy for 2 weeks. */
export const Restore: Story = {
  render: () => (
    <FrozenFirst>
      <GetDataBackDialog target={{ bucketName: BUCKET, region: REGION }} onClose={() => {}} />
    </FrozenFirst>
  ),
};

/** The grey line under a cold bucket's heading, for every state. */
export const BucketMetaLine: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <ColdStorageMeta state={{ status: 'frozen', ...term }} />
      <ColdStorageMeta
        state={{
          status: 'frozen',
          frozenAt: now - 120 * DAY,
          termEndsAt: now - 30 * DAY,
          bytes: 70e12,
        }}
      />
      <ColdStorageMeta state={{ status: 'warming', ...term, readyAt: now + 55 * 60 * 1000 }} />
      <ColdStorageMeta
        state={{ status: 'warm', ...term, warmUntil: now + 13 * DAY, extensions: 0 }}
      />
      <ColdStorageMeta
        state={{ status: 'warm', ...term, warmUntil: now + 13 * DAY, extensions: 2 }}
      />
    </div>
  ),
};

/** Every cold storage note, as it reads in a bucket's metadata line. Standard says nothing. */
export const StorageStatus: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <ColdStorageStatus state={{ status: 'frozen', ...term }} />
      <ColdStorageStatus state={{ status: 'warming', ...term, readyAt: now + 55 * 60 * 1000 }} />
      <ColdStorageStatus
        state={{ status: 'warm', ...term, warmUntil: now + 13 * DAY, extensions: 0 }}
      />
    </div>
  ),
};

/** Extending a restore is a purchase, so it asks first. */
export const ExtendRestore: Story = {
  render: () => (
    <ExtendRestoreDialog
      state={{ status: 'warm', ...term, warmUntil: now + 13 * DAY, extensions: 0 }}
      bucketName={BUCKET}
      onClose={() => {}}
      onConfirm={() => {}}
    />
  ),
};

/** Deleting the frozen copy of a restored bucket, inside the minimum term. */
export const DeleteFrozenCopy: Story = {
  render: () => (
    <DeleteFrozenCopyDialog
      state={{ status: 'warm', ...term, warmUntil: now + 13 * DAY, extensions: 0 }}
      bucketName={BUCKET}
      region={REGION}
      onClose={() => {}}
    />
  ),
};
