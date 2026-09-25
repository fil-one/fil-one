import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UserPlusIcon } from '@phosphor-icons/react/dist/ssr';
import type { Permission } from '@filone/shared';

import { Button } from '../components/Button';
import { PageLayout } from '../components/PageLayout.js';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { listInvitations, listMembers } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useMemberActionScope } from '../lib/use-member-scope.js';
import { usePermissions } from '../lib/use-permissions.js';
import { MembersRoster } from './MembersPage.js';
import { MembersInvitations } from './MembersInvitations.js';

/** Which tab, in a URL, for links that mean a particular one. */
export type OrganizationTabId = 'members' | 'invitations';

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
 * Who is in an organization, and the invitations still out to more.
 *
 * Members and Invitations are two views of the same question and belong beside
 * each other, and Members is the default because it is the tab every role can
 * open and the one most visits are for.
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
];

/**
 * Which tabs this role gets, and which of them is open.
 *
 * The selection is held as an id rather than an index because the list is
 * filtered by role: index 1 is Invitations for an Owner and does not exist for
 * a Member, and the list can shrink under a live `/me` refetch after a demotion.
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
    // who loses `members.manage` mid-session should land on Members, not on a
    // missing Invitations tab.
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
  const [inviteRequested, setInviteRequested] = useState(false);
  // Which tab is showing, driven here rather than by the tab group: the Invite
  // member button has to bring the caller to Invitations, since that panel owns
  // the dialog and only the selected panel is mounted.
  const { tabs, selectedIndex, selectTabAt, hasInvitationsTab, openInvitations } =
    useOrganizationTabs(tab, !isPending);

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
      title="Members"
      headingId="members-heading"
      description="People with access to this organization."
      action={
        // `mayInvite` covers the beta flag as well as the permission, so an org
        // outside the beta is not offered a dialog its first submit would be
        // refused.
        scope.mayInvite && hasInvitationsTab ? (
          <Button
            variant="primary"
            size="sm"
            icon={UserPlusIcon}
            data-testid="org-invite-button"
            onClick={requestInvite}
          >
            Add member
          </Button>
        ) : undefined
      }
    >
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
