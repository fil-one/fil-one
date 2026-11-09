import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api';
import { QuerySources } from './QuerySources';

const bucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 847,
  indexSize: 210_000_000,
  lastSyncedAt: '2026-06-22T11:59:00Z',
};

function withRouter(Story: () => React.JSX.Element) {
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
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof QuerySources> = {
  title: 'Components/QuerySources',
  component: QuerySources,
  decorators: [(Story) => withRouter(() => <Story />)],
  args: { bucket },
};

export default meta;
type Story = StoryObj<typeof QuerySources>;

/** A handful of source pills linking back into the object viewer. */
export const WithSources: Story = {
  args: {
    sources: ['policies/data-retention.pdf', 'governance-whitepaper.pdf', 'notes/q2-summary.md'],
  },
};

/** No sources — renders nothing. */
export const Empty: Story = {
  args: { sources: [] },
};
