import type { Meta, StoryObj } from '@storybook/react-vite';
import { S3Region } from '@filone/shared';

import { BucketStatus } from './BucketStatus';
import { type RagBucket } from '../lib/rag-bucket-api.js';

const baseBucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 0,
  indexSize: 0,
};

const meta: Meta<typeof BucketStatus> = {
  title: 'Components/BucketStatus',
  component: BucketStatus,
  decorators: [
    (Story) => (
      <div className="p-8 text-xs leading-4 text-zinc-500">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BucketStatus>;

/** Indexing is off: a grey dot, so the row reads as inert rather than broken. */
export const NotIndexed: Story = {
  args: { bucket: { ...baseBucket, enabled: false } },
};

/** Enabled but no pass has completed yet: amber, never green, since there is nothing to answer. */
export const AwaitingFirstIndex: Story = {
  args: { bucket: baseBucket },
};

/** A reconciliation is in flight over an already-indexed bucket. */
export const Syncing: Story = {
  args: {
    bucket: { ...baseBucket, syncState: 'syncing', lastSyncedAt: '2026-01-01T00:00:00Z' },
  },
};

/** The last pass failed. The orchestrator retries, so this can clear on its own. */
export const Failed: Story = {
  args: {
    bucket: {
      ...baseBucket,
      syncState: 'error',
      lastSyncError: 'Connection timeout',
      lastSyncedAt: '2026-01-01T00:00:00Z',
    },
  },
};

/** Green is reserved for buckets that can genuinely answer a question. */
export const Ready: Story = {
  args: {
    bucket: {
      ...baseBucket,
      syncState: 'idle',
      lastSyncedAt: '2026-01-01T00:00:00Z',
      filesIndexed: 128,
      indexSize: 4_200_000,
    },
  },
};
