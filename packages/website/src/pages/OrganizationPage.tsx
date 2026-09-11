import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PencilSimpleIcon, UserPlusIcon } from '@phosphor-icons/react/dist/ssr';
import type { Permission } from '@filone/shared';

import { Button } from '../components/Button';
import { EditOrganizationDialog } from '../components/EditOrganizationDialog';
import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { Spinner } from '../components/Spinner';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { getMe } from '../lib/api.js';
import { listInvitations, listMembers } from '../lib/members-api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { useMemberActionScope } from '../lib/use-member-scope.js';
import { usePermissions } from '../lib/use-permissions.js';
import { BillingDetails } from './BillingPage.js';
import { MembersRoster } from './MembersPage.js';
import { MembersInvitations } from './MembersInvitations.js';
import { OrganizationAuditTab } from './OrganizationAuditTab.js';

/**
 * Which tab, in a URL. `/billing` redirects here for an org whose billing is a
 * tab, and the shell's Upgrade banner and Stripe's portal both aim at that
 * path, so the redirect has to be able to name its destination.
 */
export type OrganizationTabId = 'members' | 'invitations' | 'audit' | 'billing';

interface OrganizationTab {
  id: OrganizationTabId;
  label: string;
  testId: string;
  /** Omitted, every role reaches it. */
  permission?: Permission;
  /**
   * Which list this tab counts, when it counts one. On the tab rather than in
   * the panel: the number belongs with the label somebody reads before choosing
   * a tab, not inside the one they have already opened.
   */
  countOf?: 'members' | 'invitations';
  render: (ctx: TabContext) => React.ReactNode;
}

/** What the page hands its panels. Only the Invitations panel reads it today. */
interface TabContext {
  /** The header's Invite member button, asking the Invitations panel to open. */
  inviteRequested: boolean;
  onInviteRequestHandled: () => void;
}

/**
 * What an organization is and who is in it, in one place.
 *
 * Members, invitations and billing were three top-level entries and the org's
 * name lived in Settings beside the caller's own name and email, so there was
 * nowhere to answer "what is this organization". They are tabs of one page now,
 * and Settings means the caller's own account (FIL-1094).
 *
 * Ordered people first, money last: Members and Invitations are two views of the
 * same question and belong beside each other, and Members is the default because
 * it is the tab every role can open and the one most visits are for. The audit
 * log sits after them because it is what those two tabs did, recorded.
 */
const ORGANIZATION_TABS: OrganizationTab[] = [
  {
    id: 'members',
    label: 'Members',
    testId: 'org-tab-members',
    permission: 'members.read',
    countOf: 'members',
    render: () => <MembersRoster />,
  },
  {
    id: 'invitations',
    label: 'Invitations',
    testId: 'org-tab-invitations',
    countOf: 'invitations',
    // The list endpoint is `members.manage` rather than `members.read`, so for
    // anybody else this tab is a request the server refuses.
    permission: 'members.manage',
    render: (ctx) => (
      <MembersInvitations
        inviteRequested={ctx.inviteRequested}
        onInviteRequestHandled={ctx.onInviteRequestHandled}
      />
    ),
  },
  {
    id: 'audit',
    label: 'Audit log',
    testId: 'org-tab-audit',
    // Owner and Admin. The PRD's "an auditor joins as ReadOnly" flow would need
    // this open to ReadOnly, and the review thread narrowed it instead: an
    // external auditor holds an Admin seat, or is sent a CSV by someone who does.
    permission: 'audit.view',
    render: () => <OrganizationAuditTab />,
  },
  {
    id: 'billing',
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
];

/**
 * Which tabs this role gets, and which of them is open.
 *
 * The selection is held as an id rather than an index because the list is
 * filtered by role: index 2 is Billing for an Owner and does not exist for a
 * Member, and the list can shrink under a live `/me` refetch after a demotion.
 * An index would then point at a different tab than the one the caller chose.
 */
function useOrganizationTabs(initialTab: OrganizationTabId | undefined, ready: boolean) {
  const { has } = usePermissions();
  const [selectedTabId, setSelectedTabId] = useState<OrganizationTabId>(initialTab ?? 'members');

  // Filtered the way `SidebarNav` filters its entries, and fail-closed for the
  // same reason: `has` answers false while `/me` is in flight, so a tab stays
  // out rather than appearing and then vanishing for a role that cannot reach
  // it. Hiding is not the guard — each panel still gates its own request.
  const tabs = ready ? ORGANIZATION_TABS.filter((t) => !t.permission || has(t.permission)) : [];

  return {
    tabs,
    // Falls back to the first tab rather than the last one that fits: a caller
    // who loses `billing.view` mid-session should land on Members, not on
    // whatever now sits at Billing's old index.
    selectedIndex: Math.max(0, indexOfTab(tabs, selectedTabId)),
    selectTabAt: (index: number) => setSelectedTabId(tabs[index]!.id),
    // The Add member button has nowhere to send the caller without this tab,
    // and the dialog it opens lives in that panel.
    hasInvitationsTab: indexOfTab(tabs, 'invitations') >= 0,
    openInvitations: () => setSelectedTabId('invitations'),
  };
}

function indexOfTab(tabs: OrganizationTab[], id: OrganizationTabId): number {
  return tabs.findIndex((tab) => tab.id === id);
}

export function OrganizationPage({ tab }: { tab?: OrganizationTabId } = {}) {
  const { has, isPending } = usePermissions();
  const scope = useMemberActionScope();
  const [editing, setEditing] = useState(false);
  const [inviteRequested, setInviteRequested] = useState(false);
  // Which tab is showing, driven here rather than by the tab group: the Invite
  // member button has to bring the caller to Invitations, since that panel owns
  // the dialog and only the selected panel is mounted.
  const { tabs, selectedIndex, selectTabAt, hasInvitationsTab, openInvitations } =
    useOrganizationTabs(tab, !isPending);
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  // Same query keys the panels use, so these share their cache rather than
  // adding requests. Each is asked only by a caller whose role may read it.
  const roster = useQuery({
    queryKey: queryKeys.members,
    queryFn: listMembers,
    enabled: !isPending && has('members.read'),
  });
  const pending = useQuery({
    queryKey: queryKeys.invitations,
    queryFn: listInvitations,
    enabled: !isPending && has('members.manage'),
  });

  const counts = {
    members: roster.data?.members.length,
    invitations: pending.data?.invitations.length,
  };

  const tabContext = {
    inviteRequested,
    onInviteRequestHandled: () => setInviteRequested(false),
  };

  function requestInvite() {
    if (hasInvitationsTab) openInvitations();
    setInviteRequested(true);
  }

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
        <div className="flex items-center gap-2">
          {/* "Edit", not "Edit organization": it sits under the Organization
              title, which is the thing it edits. */}
          <RequirePermission permission="org.rename">
            <Button
              variant="ghost"
              size="sm"
              icon={PencilSimpleIcon}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          </RequirePermission>

          {/* The page's one filled action, and `sm` like the button beside it so
              the pair lines up. Named "Add member" rather than "Add": this page
              holds members, invitations and billing, and beside an "Edit" that
              means the organization, a bare "Add" reads as adding one of those.

              `mayInvite` covers the beta flag as well as the permission, so an
              org outside the beta is not offered a dialog its first submit would
              be refused. */}
          {scope.mayInvite && hasInvitationsTab && (
            <Button
              variant="primary"
              size="sm"
              icon={UserPlusIcon}
              data-testid="org-invite-button"
              onClick={requestInvite}
            >
              Add member
            </Button>
          )}
        </div>
      }
    >
      <EditOrganizationDialog
        open={editing}
        onClose={() => setEditing(false)}
        orgName={me?.orgName ?? ''}
      />

      {tabs.length > 0 && (
        <Tabs selectedIndex={selectedIndex} onChange={selectTabAt}>
          <TabList>
            {tabs.map((tab) => (
              <Tab
                key={tab.label}
                testId={tab.testId}
                count={tab.countOf ? counts[tab.countOf] : undefined}
              >
                {tab.label}
              </Tab>
            ))}
          </TabList>
          <TabPanels>
            {tabs.map((tab) => (
              <TabPanel key={tab.label}>{tab.render(tabContext)}</TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      )}
    </PageLayout>
  );
}
