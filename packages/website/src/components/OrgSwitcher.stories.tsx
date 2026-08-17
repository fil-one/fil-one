import type { Meta, StoryObj } from '@storybook/react-vite';
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
    // width, background, and border come from.
    (Story) => (
      <div className="w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
        <Story />
      </div>
    ),
  ],
  args: {
    activeOrgId: ORG_A,
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', role: OrgRole.Owner },
      { orgId: ORG_B, orgName: 'Globex', role: OrgRole.Member },
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
      { orgId: ORG_A, orgName: 'Acme', role: OrgRole.Owner },
      { orgId: ORG_B, orgName: 'Globex Manufacturing Holdings', role: OrgRole.Admin },
      { orgId: ORG_C, orgName: 'Initech', role: OrgRole.ReadOnly },
    ],
  },
};

/** One membership renders nothing, which is every account today. */
export const SoleMembership: Story = {
  args: {
    memberships: [{ orgId: ORG_A, orgName: 'Acme', role: OrgRole.Owner }],
  },
};

/** An org whose profile row would not read is still choosable. */
export const UnnamedOrg: Story = {
  args: {
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', role: OrgRole.Owner },
      { orgId: ORG_B, orgName: '', role: OrgRole.Member },
    ],
  },
};
