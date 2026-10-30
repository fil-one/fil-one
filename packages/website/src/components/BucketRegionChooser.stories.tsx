import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region } from '@filone/shared';

import { BucketRegionChooser } from './BucketRegionChooser';

function withRouter(Story: () => React.JSX.Element) {
  const rootRoute = createRootRoute({ component: Story });
  const bucketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([bucketRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof BucketRegionChooser> = {
  title: 'Components/BucketRegionChooser',
  component: BucketRegionChooser,
  decorators: [withRouter],
  args: { bucketName: 'any-bucket', unavailableRegions: [] },
};

export default meta;
type Story = StoryObj<typeof BucketRegionChooser>;

export const TwoRegions: Story = {
  args: { regions: [S3Region.UsEast1, S3Region.EuWest1] },
};

export const RegionUnavailable: Story = {
  args: { regions: [S3Region.EuWest1], unavailableRegions: [S3Region.UsEast1] },
};
