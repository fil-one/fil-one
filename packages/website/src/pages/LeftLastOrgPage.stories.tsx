import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { LeftLastOrgPage } from './LeftLastOrgPage';

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute(),
});

const meta: Meta<typeof LeftLastOrgPage> = {
  title: 'Pages/LeftLastOrgPage',
  component: LeftLastOrgPage,
  parameters: { fullBleed: true, layout: 'fullscreen' },
  decorators: [(Story) => <RouterProvider router={router} defaultComponent={() => <Story />} />],
  args: {
    email: 'jane@acme.com',
  },
};

export default meta;
type Story = StoryObj<typeof LeftLastOrgPage>;

export const Default: Story = {};

/** Reached before `/me` resolves, so there is no address to name yet. */
export const NoEmailYet: Story = {
  args: { email: undefined },
};
