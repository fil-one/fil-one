import type { Meta, StoryObj } from '@storybook/react-vite';
import { S3Region } from '@filone/shared';

import { SyncStatusBadge } from './SyncStatusBadge';
import { type RagBucket } from '../lib/rag-bucket-api.js';

const baseBucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 0,
  indexSize: 0,
};

const meta: Meta<typeof SyncStatusBadge> = {
  title: 'Components/SyncStatusBadge',
  component: SyncStatusBadge,
};

export default meta;
type Story = StoryObj<typeof SyncStatusBadge>;

/** A reconciliation is in flight. */
export const Syncing: Story = {
  args: { bucket: { ...baseBucket, syncState: 'syncing' } },
};

/** The last sync failed; the reason shows in the visible text's tooltip. */
export const Failed: Story = {
  args: { bucket: { ...baseBucket, syncState: 'error', lastSyncError: 'Connection timeout' } },
};

/** Steady/idle (or never-synced) — the badge renders nothing. */
export const Idle: Story = {
  args: { bucket: { ...baseBucket, syncState: 'idle' } },
};
