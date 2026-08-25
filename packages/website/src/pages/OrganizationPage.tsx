import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/ssr';
import type { Permission } from '@filone/shared';

import { Button } from '../components/Button';
import { EditOrganizationDialog } from '../components/EditOrganizationDialog';
import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { Spinner } from '../components/Spinner';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { usePermissions } from '../lib/use-permissions.js';
import { BillingDetails } from './BillingPage.js';
import { MembersRoster } from './MembersPage.js';
import { MembersInvitations } from './MembersInvitations.js';

interface OrganizationTab {
  label: string;
  testId: string;
  /** Omitted, every role reaches it. */
  permission?: Permission;
  render: () => React.ReactNode;
}

/**
 * What an organization is and who is in it, in one place.
 *
 * Members, invitations and billing were three top-level entries and the org's
 * name lived in Settings beside the caller's own name and email, so there was
 * nowhere to answer "what is this organization". They are tabs of one page now,
 * and Settings means the caller's own account (FIL-1094).
 */
const ORGANIZATION_TABS: OrganizationTab[] = [
  {
    label: 'Members',
    testId: 'org-tab-members',
    permission: 'members.read',
    render: () => <MembersRoster />,
  },
  {
    label: 'Billing',
    testId: 'org-tab-billing',
    // Owner and Admin hold `billing.view`; for everybody else the tab is not
    // offered at all. `RequirePermission` still wraps the panel, because a tab
    // nobody can see is not a guard against a request nobody should make.
    permission: 'billing.view',
    render: () => (
      <RequirePermission
        permission="billing.view"
        pending={
          <div className="flex items-center justify-center p-16">
            <Spinner ariaLabel="Loading billing" />
          </div>
        }
        fallback={
          <p className="text-sm text-zinc-600">
            Billing is managed by this organization&rsquo;s owners and admins.
          </p>
        }
      >
        <BillingDetails />
      </RequirePermission>
    ),
  },
  {
    label: 'Invitations',
    testId: 'org-tab-invitations',
    // The list endpoint is `members.manage` rather than `members.read`, so for
    // anybody else this tab is a request the server refuses.
    permission: 'members.manage',
    render: () => <MembersInvitations />,
  },
];

export function OrganizationPage() {
  const { has, isPending } = usePermissions();
  const [editing, setEditing] = useState(false);
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  // Filtered the way `SidebarNav` filters its entries, and fail-closed for the
  // same reason: `has` answers false while `/me` is in flight, so a tab stays
  // out rather than appearing and then vanishing for a role that cannot reach
  // it. Hiding is not the guard — each panel still gates its own request.
  const tabs = isPending
    ? []
    : ORGANIZATION_TABS.filter((tab) => !tab.permission || has(tab.permission));

  return (
    <PageLayout
      title="Organization"
      headingId="organization-heading"
      // Named rather than "this organization": the active org is stashed per
      // tab, so two browser tabs can sit in different ones, and this is the
      // page that removes people and hands over ownership.
      description={`Manage ${me?.orgName || 'this organization'} and who has access to it.`}
      // Only for a role that may actually rename: everybody else is not offered
      // a button whose dialog the server would refuse.
      action={
        <RequirePermission permission="org.rename">
          <Button
            variant="ghost"
            size="sm"
            icon={PencilSimpleIcon}
            onClick={() => setEditing(true)}
          >
            Edit organization
          </Button>
        </RequirePermission>
      }
    >
      <EditOrganizationDialog
        open={editing}
        onClose={() => setEditing(false)}
        orgName={me?.orgName ?? ''}
      />

      {tabs.length > 0 && (
        <Tabs>
          <TabList>
            {tabs.map((tab) => (
              <Tab key={tab.label} testId={tab.testId}>
                {tab.label}
              </Tab>
            ))}
          </TabList>
          <TabPanels>
            {tabs.map((tab) => (
              <TabPanel key={tab.label}>{tab.render()}</TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      )}
    </PageLayout>
  );
}
