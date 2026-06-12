import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region } from '@filone/shared';

import { UploadObjectPage } from './UploadObjectPage';

function withRouter(Story: () => React.JSX.Element) {
  const rootRoute = createRootRoute();
  const uploadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/upload',
    component: Story,
  });
  const bucketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([uploadRoute, bucketRoute]),
    history: createMemoryHistory({
      initialEntries: ['/buckets/my-bucket/upload?region=us-east-1'],
    }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof UploadObjectPage> = {
  title: 'Pages/UploadObjectPage',
  component: UploadObjectPage,
  decorators: [(Story) => withRouter(Story)],
  args: {
    bucketName: 'my-bucket',
    region: S3Region.UsEast1,
  },
};

export default meta;
type Story = StoryObj<typeof UploadObjectPage>;

export const Default: Story = {};
