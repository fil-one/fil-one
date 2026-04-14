import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { SealingStatus } from './SealingStatus';

const rootRoute = createRootRoute();
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SealingStatus,
});
const bucketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/buckets',
  component: () => <div>Buckets page</div>,
});

const routeTree = rootRoute.addChildren([indexRoute, bucketsRoute]);

function createStoryRouter() {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

const meta: Meta<typeof SealingStatus> = {
  title: 'Components/SealingStatus',
  component: SealingStatus,
  decorators: [
    () => {
      const router = createStoryRouter();
      return <RouterProvider router={router} />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof SealingStatus>;

export const Default: Story = {};
