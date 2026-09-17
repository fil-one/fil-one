import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { OrgRole } from '@filone/shared';

import { MembersToolbar } from './MembersToolbar';
import { EMPTY_MEMBER_FILTERS, type MemberFilters } from '../lib/member-table.js';

const ALL_FOUR_ROLES = [OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly];

/** Live state, so the story exercises the count switching to a fraction. */
function Harness({ roles, totalCount }: { roles: OrgRole[]; totalCount: number }) {
  const [filters, setFilters] = useState<MemberFilters>(EMPTY_MEMBER_FILTERS);
  const filtering = filters.query.trim() !== '' || filters.role !== 'all';

  return (
    <MembersToolbar
      filters={filters}
      onChange={setFilters}
      roles={roles}
      matchCount={filtering ? 2 : totalCount}
      totalCount={totalCount}
    />
  );
}

const meta: Meta<typeof MembersToolbar> = {
  title: 'Components/MembersToolbar',
  component: MembersToolbar,
};

export default meta;
type Story = StoryObj<typeof MembersToolbar>;

export const Default: Story = {
  render: () => <Harness roles={ALL_FOUR_ROLES} totalCount={12} />,
};

/** One role in the roster is no choice, so the filter stays out. */
export const SingleRole: Story = {
  render: () => <Harness roles={[OrgRole.Member]} totalCount={9} />,
};

export const Filtering: Story = {
  render: () => (
    <MembersToolbar
      filters={{ query: 'ada', role: OrgRole.Admin }}
      onChange={() => {}}
      roles={ALL_FOUR_ROLES}
      matchCount={1}
      totalCount={12}
    />
  ),
};

export const OneMember: Story = {
  render: () => <Harness roles={[OrgRole.Owner]} totalCount={1} />,
};
