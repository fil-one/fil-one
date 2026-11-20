import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';

import { AgentsPage } from './AgentsPage';

/** The page links to API keys through the router, so the story gives it one. */
function WithRouter({ children }: { children: React.ReactNode }) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => children }),
    history: createMemoryHistory(),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof AgentsPage> = {
  title: 'Pages/AgentsPage',
  component: AgentsPage,
  decorators: [
    (Story) => (
      <WithRouter>
        <Story />
      </WithRouter>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AgentsPage>;

export const Default: Story = {};
