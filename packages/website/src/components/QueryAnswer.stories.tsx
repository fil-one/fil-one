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
import { QueryAnswer } from './QueryAnswer';

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

const meta: Meta<typeof QueryAnswer> = {
  title: 'Components/QueryAnswer',
  component: QueryAnswer,
  decorators: [(Story) => withRouter(() => <Story />)],
  args: {
    bucket,
    question: 'What is the retention period?',
    isPending: false,
    isError: false,
    error: undefined,
    result: undefined,
  },
};

export default meta;
type Story = StoryObj<typeof QueryAnswer>;

/** While the query is in flight — animated skeleton lines. */
export const Loading: Story = {
  args: { isPending: true },
};

/** The query failed — surfaces the error message. */
export const Error: Story = {
  args: { isError: true, error: new globalThis.Error('Query failed') },
};

/** A grounded answer with source citations. */
export const Answer: Story = {
  args: {
    result: {
      answer: 'The default retention period is 90 days for standard objects.',
      sources: ['policies/data-retention.pdf', 'governance-whitepaper.pdf'],
    },
  },
};
