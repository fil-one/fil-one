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
  const rootRoute = createRootRoute({ component: Story });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: Story,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
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
