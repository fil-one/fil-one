import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';

import { ConnectionDetailsTab } from './ConnectionDetailsTab';

/** The tab links to Buckets through the router, so the story gives it one. */
function WithRouter({ children }: { children: React.ReactNode }) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => children }),
    history: createMemoryHistory(),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof ConnectionDetailsTab> = {
  title: 'Pages/ConnectionDetailsTab',
  component: ConnectionDetailsTab,
  decorators: [
    (Story) => (
      <WithRouter>
        <Story />
      </WithRouter>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ConnectionDetailsTab>;

export const Default: Story = {};
