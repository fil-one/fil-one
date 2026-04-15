import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { SidebarNav } from './SidebarNav';

const meta: Meta<typeof SidebarNav> = {
  title: 'Components/SidebarNav',
  component: SidebarNav,
  decorators: [
    (Story) => {
      const rootRoute = createRootRoute({
        component: () => (
          <div style={{ height: 600, width: 240 }}>
            <Story />
          </div>
        ),
      });
      const routes = [
        '/dashboard',
        '/buckets',
        '/api-keys',
        '/billing',
        '/settings',
        '/support',
      ].map((path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: () => null,
        }),
      );
      const routeTree = rootRoute.addChildren(routes);
      const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
      });
      return <RouterProvider router={router} />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof SidebarNav>;

export const Expanded: Story = {
  args: {
    collapsed: false,
  },
};

export const Collapsed: Story = {
  args: {
    collapsed: true,
  },
};

export const Interactive: Story = {
  render: () => {
    const [collapsed, setCollapsed] = useState(false);
    return (
      <div style={{ height: 600, width: collapsed ? 80 : 240 }}>
        <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </div>
    );
  },
};
