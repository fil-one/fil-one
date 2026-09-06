import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { UserMenu } from './UserMenu';

const meta: Meta<typeof UserMenu> = {
  title: 'Components/UserMenu',
  component: UserMenu,
  parameters: {
    // Opens the panel with `anchor="top start"`, upward from the footer;
    // extra room keeps Storybook's own canvas from clipping it.
    layout: 'padded',
  },
  args: {
    src: undefined,
    initial: 'A',
    displayName: 'Ada Lovelace',
    collapsed: false,
  },
  decorators: [
    // `Settings`/`Support`/`Documentation` render through `BaseLink`, which
    // needs a mounted router — same memory-router stand-in `SidebarNav`'s own
    // stories use.
    (Story) => {
      const rootRoute = createRootRoute({
        component: () => (
          <div className="w-60">
            <Story />
          </div>
        ),
      });
      const routes = ['/settings', '/support'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      );
      const router = createRouter({
        routeTree: rootRoute.addChildren(routes),
        history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
      });
      return <RouterProvider router={router} />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof UserMenu>;

/** Closed, as it sits at the foot of the sidebar. */
export const Closed: Story = {};

/** A profile picture in place of the generated initial. */
export const WithAvatar: Story = {
  args: { src: 'https://avatars.githubusercontent.com/u/1?v=4' },
};

/** Collapsed sidebar: the name and chevron drop, leaving only the avatar. */
export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: [
    (Story) => (
      <div className="w-14">
        <Story />
      </div>
    ),
  ],
};
