import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { OrgRole } from '@filone/shared';

import { OrgSwitcherMenu } from './OrgSwitcherMenu';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const meta: Meta<typeof OrgSwitcherMenu> = {
  title: 'Components/OrgSwitcherMenu',
  component: OrgSwitcherMenu,
  parameters: {
    // Opens the panel with `anchor="bottom start"`; extra room below the
    // trigger keeps Storybook's own canvas from clipping it.
    layout: 'padded',
  },
  args: {
    orgName: 'Acme',
    logoUrl: undefined,
    activeOrgId: ORG_A,
    collapsed: false,
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
      { orgId: ORG_B, orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
    ],
  },
  decorators: [
    // `Edit organization`/`Members`/`Billing` render through `BaseLink`, which
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
      const routes = ['/organization', '/members', '/billing'].map((path) =>
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
type Story = StoryObj<typeof OrgSwitcherMenu>;

/** Closed, as it sits at the top of the sidebar. */
export const Closed: Story = {};

/** A single-org account still gets the control: Create organization stays reachable. */
export const SoleMembership: Story = {
  args: {
    memberships: [{ orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner }],
  },
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
