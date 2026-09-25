import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { OnboardingPage } from './OnboardingPage';

/** Mounted at its real path, so `BaseLink`'s hrefs resolve. */
function withRouter(Story: () => React.JSX.Element) {
  const rootRoute = createRootRoute();
  const getStartedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/get-started',
    component: Story,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([getStartedRoute]),
    history: createMemoryHistory({ initialEntries: ['/get-started'] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof OnboardingPage> = {
  title: 'Pages/OnboardingPage',
  component: OnboardingPage,
  decorators: [(Story) => withRouter(Story)],
};

export default meta;
type Story = StoryObj<typeof OnboardingPage>;

/** A brand-new organization: neither task is done yet. */
export const Default: Story = {};

/** Both tasks already done — the actions read as "another" rather than the first. */
export const AlreadySetUp: Story = {
  args: { hasBucket: true, hasKey: true },
};
