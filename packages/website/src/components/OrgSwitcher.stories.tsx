import type { Meta, StoryObj } from '@storybook/react-vite';
import { SignOutIcon } from '@phosphor-icons/react/dist/ssr';
import { OrgRole } from '@filone/shared';

import { OrgSwitcher } from './OrgSwitcher';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const ORG_C = '33333333-3333-3333-3333-333333333333';

const meta: Meta<typeof OrgSwitcher> = {
  title: 'Components/OrgSwitcher',
  component: OrgSwitcher,
  decorators: [
    // The switcher lives in the identity button's dropdown, which is where its
    // width, background, and border come from. `Log out` is rendered with it
    // because the switcher's trailing rule is the divider between the two — on
    // its own it reads as a stray line under the last org.
    (Story) => (
      <div className="w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
        <Story />
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          <SignOutIcon size={18} className="shrink-0 text-zinc-400" />
          Log out
        </button>
      </div>
    ),
  ],
  args: {
    activeOrgId: ORG_A,
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
      { orgId: ORG_B, orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
    ],
  },
};

export default meta;
type Story = StoryObj<typeof OrgSwitcher>;

/** Two memberships: the active org is marked, the other is one click away. */
export const TwoOrgs: Story = {};

/** Longer names truncate rather than widening the menu. */
export const ManyOrgs: Story = {
  args: {
    activeOrgId: ORG_C,
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
      {
        orgId: ORG_B,
        orgName: 'Globex Manufacturing Holdings',
        slug: 'globex',
        role: OrgRole.Admin,
      },
      { orgId: ORG_C, orgName: 'Initech', slug: 'initech', role: OrgRole.ReadOnly },
    ],
  },
};

/** One membership renders nothing, which is every account today. */
export const SoleMembership: Story = {
  args: {
    memberships: [{ orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner }],
  },
};

/** An org whose profile row would not read is still choosable. */
export const UnnamedOrg: Story = {
  args: {
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
      { orgId: ORG_B, orgName: '', slug: 'org-b', role: OrgRole.Member },
    ],
  },
};

/**
 * Inside the mobile user menu, where the panel is a `role="menu"` and the org
 * rows are its radio items.
 */
export const InsideAMenu: Story = {
  args: { inMenu: true },
  // Only the `role="menu"` context: the panel chrome comes from the decorator
  // on `meta`, and a second styled panel here nests one card inside another.
  decorators: [
    (Story) => (
      <div role="menu">
        <Story />
      </div>
    ),
  ],
};
