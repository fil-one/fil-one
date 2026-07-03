import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api';
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
  args: { bucket, onClose: () => {} },
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
