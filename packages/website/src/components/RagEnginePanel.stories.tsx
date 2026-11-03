import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  engineEmpty,
  engineError,
  engineFlat,
  engineResponse,
  engineSyncing,
  forgeBucket,
} from '../lib/rag-engine-fixtures.js';
import { RagDatasetPanel, RagEngineSyncStrip } from './RagEnginePanel';

const meta: Meta<typeof RagEngineSyncStrip> = {
  title: 'Components/RagEnginePanel',
  component: RagEngineSyncStrip,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full rounded-xl border border-zinc-200 bg-white">
        <Story />
      </div>
    ),
  ],
  args: { canSync: true, onSync: () => {}, syncRequested: false },
};

export default meta;
type Story = StoryObj<typeof RagEngineSyncStrip>;

/** Indexed and idle: Index now is a secondary action. */
export const SyncIdle: Story = { args: { status: engineResponse.status } };

/** Never indexed: Index now is the primary action. */
export const SyncNotIndexed: Story = { args: { status: engineEmpty.status } };

/** Between the click and the engine reporting the run. */
export const SyncRequested: Story = {
  args: { status: engineResponse.status, syncRequested: true },
};

/** A run in flight, 17 of 40 objects. */
export const SyncRunning: Story = { args: { status: engineSyncing.status } };

/** Listing the source bucket, before the total is known. */
export const SyncListing: Story = {
  args: {
    status: {
      ...engineSyncing.status,
      progress: { objectsTotal: 0, objectsDone: 0, chunksWritten: 0 },
    },
  },
};

/** The last run failed. */
export const SyncFailed: Story = { args: { status: engineError.status } };

/** A read-only member sees progress but cannot start a run. */
export const SyncReadOnly: Story = { args: { status: engineSyncing.status, canSync: false } };

/** The Lance dataset: IVF_HNSW_SQ vector index plus full-text index, 1,912 rows. */
export const Dataset: StoryObj<typeof RagDatasetPanel> = {
  render: () => <RagDatasetPanel bucket={forgeBucket} dataset={engineResponse.status.dataset!} />,
};

/** A small dataset below the vector-index threshold: flat scan plus full text. */
export const DatasetFlat: StoryObj<typeof RagDatasetPanel> = {
  render: () => <RagDatasetPanel bucket={forgeBucket} dataset={engineFlat.status.dataset!} />,
};
