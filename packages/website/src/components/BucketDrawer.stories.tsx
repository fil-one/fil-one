import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region } from '@filone/shared';

import type { BucketRagEngineResponse } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api';
import {
  QUESTION,
  engineEmpty,
  engineError,
  engineFlat,
  engineResponse,
  engineSyncing,
  forgeBucket,
} from '../lib/rag-engine-fixtures.js';
import { installRagEngineMockFetch } from '../lib/rag-engine-mock-api.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { BucketDrawer } from './BucketDrawer';

const bucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 847,
  indexSize: 210_000_000,
  lastSyncedAt: '2026-06-22T11:59:00Z',
};

function withProviders(Story: () => React.JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The footer is permission-gated, so without a role in the cache the story
  // would show a drawer that has lost its Stop indexing action.
  seedPermissions(client);
  const rootRoute = createRootRoute({ component: Story });
  const objectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([objectsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta: Meta<typeof BucketDrawer> = {
  title: 'Components/BucketDrawer',
  component: BucketDrawer,
  decorators: [(Story) => withProviders(() => <Story />)],
  args: { bucket, onClose: () => {}, onStopIndexing: () => {} },
};

export default meta;
type Story = StoryObj<typeof BucketDrawer>;

/** The query playground slide-over for an enabled bucket. */
export const Default: Story = {
  render: (args) => {
    const [open, setOpen] = useState(true);
    if (!open) return <p className="p-8 text-sm text-zinc-500">Drawer closed.</p>;
    return <BucketDrawer {...args} onClose={() => setOpen(false)} />;
  },
};

// ---------------------------------------------------------------------------
// Forge buckets: Bucket Intelligence on the Forge engine (Lance dataset)
// ---------------------------------------------------------------------------

/**
 * A Forge-region story backed by a stand-in for the engine routes, so Index
 * now, the progress bar, search modes, version history and cited answers all
 * work when clicked.
 */
function forgeStory(engine: BucketRagEngineResponse, bucketOverride?: Partial<RagBucket>): Story {
  return {
    args: { bucket: { ...forgeBucket, ...bucketOverride } },
    beforeEach: () => installRagEngineMockFetch({ engine }),
    render: (args) => <BucketDrawer {...args} />,
  };
}

/** Indexed Forge bucket: search controls, Index now and the Lance dataset panel. */
export const ForgeIndexed: Story = forgeStory(engineResponse);

/** A hybrid question answered with three citations and the retrieval trace; source 2 selected. */
export const ForgeAnswered: Story = {
  ...forgeStory(engineResponse),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.type(await body.findByLabelText('Ask a question'), QUESTION);
    await userEvent.click(body.getByTestId('bucket-drawer-ask-submit'));
    const markers = await body.findAllByTestId('citation-marker', {}, { timeout: 4000 });
    await expect(markers).toHaveLength(3);
    await userEvent.click(markers[1]!);
    await expect(body.getByTestId('query-trace')).toHaveTextContent('Hybrid');
  },
};

/** The same question asked of version 11, before the retention policy changed. */
export const ForgeTimeTravel: Story = {
  ...forgeStory(engineResponse),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByTestId('search-mode-vector'));
    await userEvent.selectOptions(await body.findByLabelText('Dataset version'), '11');
    await userEvent.type(body.getByLabelText('Ask a question'), QUESTION);
    await userEvent.click(body.getByTestId('bucket-drawer-ask-submit'));
    await waitFor(() => expect(body.getByTestId('trace-version')).toHaveTextContent('v11'), {
      timeout: 4000,
    });
  },
};

/** A run in flight: progress advances every poll until it commits version 15. */
export const ForgeSyncing: Story = forgeStory(engineSyncing, { syncState: 'syncing' });

/** Enabled but never indexed: Index now is the primary action. */
export const ForgeNotIndexed: Story = forgeStory(engineEmpty, {
  filesIndexed: 0,
  indexSize: 0,
  lastSyncedAt: undefined,
});

/** A small dataset below the vector-index threshold searches by flat scan. */
export const ForgeFlatSearch: Story = forgeStory(engineFlat, { filesIndexed: 3 });

/** The last run failed; the previous version is still searchable. */
export const ForgeSyncError: Story = forgeStory(engineError, { syncState: 'error' });
