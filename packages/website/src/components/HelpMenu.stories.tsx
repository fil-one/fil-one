import { useRef, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { HelpMenu } from './SidebarNav';

const withRouter = (Story: React.ComponentType) => {
  const rootRoute = createRootRoute({ component: () => <Story /> });
  const supportRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/support',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([supportRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
};

const meta: Meta<typeof HelpMenu> = {
  title: 'Components/HelpMenu',
  component: HelpMenu,
  decorators: [withRouter],
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof HelpMenu>;

export const Expanded: Story = {
  render: () => {
    const helpMenuRef = useRef<HTMLDivElement>(null);
    const helpButtonRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <div style={{ width: 240 }}>
        <HelpMenu
          collapsed={false}
          helpMenuOpen={open}
          helpMenuRef={helpMenuRef}
          helpButtonRef={helpButtonRef}
          onToggle={() => setOpen((o) => !o)}
        />
      </div>
    );
  },
};

export const ExpandedOpen: Story = {
  render: () => {
    const helpMenuRef = useRef<HTMLDivElement>(null);
    const helpButtonRef = useRef<HTMLButtonElement>(null);
    return (
      <div style={{ width: 240, paddingTop: 80 }}>
        <HelpMenu
          collapsed={false}
          helpMenuOpen={true}
          helpMenuRef={helpMenuRef}
          helpButtonRef={helpButtonRef}
          onToggle={() => {}}
        />
      </div>
    );
  },
};

export const Collapsed: Story = {
  render: () => {
    const helpMenuRef = useRef<HTMLDivElement>(null);
    const helpButtonRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <div style={{ width: 56 }}>
        <HelpMenu
          collapsed={true}
          helpMenuOpen={open}
          helpMenuRef={helpMenuRef}
          helpButtonRef={helpButtonRef}
          onToggle={() => setOpen((o) => !o)}
        />
      </div>
    );
  },
};

export const CollapsedOpen: Story = {
  render: () => {
    const helpMenuRef = useRef<HTMLDivElement>(null);
    const helpButtonRef = useRef<HTMLButtonElement>(null);
    return (
      <div style={{ width: 56, paddingTop: 80 }}>
        <HelpMenu
          collapsed={true}
          helpMenuOpen={true}
          helpMenuRef={helpMenuRef}
          helpButtonRef={helpButtonRef}
          onToggle={() => {}}
        />
      </div>
    );
  },
};
