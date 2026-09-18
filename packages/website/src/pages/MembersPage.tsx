import { useState } from 'react';
import { UserPlusIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '../components/Button';
import { PageLayout } from '../components/PageLayout.js';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { listInvitations, listMembers } from '../lib/members-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useMemberActionScope } from '../lib/use-member-scope.js';
import { usePermissions } from '../lib/use-permissions.js';
import { useQuery } from '@tanstack/react-query';
import { MembersRoster } from './MembersRoster.js';
import { MembersInvitations } from './MembersInvitations.js';

/** Which tab is open, and the only one a URL ever names. */
export type MembersTabId = 'members' | 'invitations';

/**
 * The people in an organization, and the invitations still out to more.
 *
 * Its own page now, reached from the org switcher — not a tab of an
 * "Organization" page that also held Billing and the org's name (that page is
 * gone; identity and rename live in the switcher, Billing is its own page).
 * What is left is people: the roster every role can read, and Invitations for
 * the roles that can manage them, side by side as two tabs.
 *
 * The title is plain "Members" and there is no Edit here — nothing on this page
 * is about the organization itself, only about who is in it.
 */
export function MembersPage({ tab }: { tab?: MembersTabId } = {}) {
  const { has, isPending } = usePermissions();
  const scope = useMemberActionScope();
  const [inviteRequested, setInviteRequested] = useState(false);
  // Which tab is showing, driven here rather than by the tab group: the Add
  // member button has to bring the caller to Invitations, since that panel owns
  // the dialog and only the selected panel is mounted.
  const [selectedTabId, setSelectedTabId] = useState<MembersTabId>(tab ?? 'members');

  // Filtered the way `SidebarNav` filters its entries, and fail-closed for the
  // same reason: `has` answers false while `/me` is in flight, so a tab stays
  // out rather than appearing and then vanishing for a role that cannot reach
  // it. Hiding is not the guard, each panel still gates its own request.
  const showInvitations = !isPending && has('members.manage');

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
    enabled: showInvitations,
  });

  const tabContext = {
    inviteRequested,
    onInviteRequestHandled: () => setInviteRequested(false),
  };

  function requestInvite() {
    if (showInvitations) setSelectedTabId('invitations');
    setInviteRequested(true);
  }

  // Falls back to Members rather than the last tab that fit: a caller who loses
  // `members.manage` mid-session should land on Members, not on a missing
  // Invitations tab.
  const selectedIndex = showInvitations && selectedTabId === 'invitations' ? 1 : 0;

  return (
    <PageLayout
      title="Members"
      headingId="members-heading"
      description="People with access to this organization."
      action={
        // `mayInvite` covers the permission the invite endpoint asks for, so a
        // role that cannot invite is not offered a dialog its first submit would
        // be refused.
        scope.mayInvite && showInvitations ? (
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
      <Tabs
        selectedIndex={selectedIndex}
        onChange={(index) => setSelectedTabId(index === 1 ? 'invitations' : 'members')}
      >
        <TabList>
          <Tab testId="org-tab-members" count={roster.data?.members.length}>
            Members
          </Tab>
          {showInvitations && (
            <Tab testId="org-tab-invitations" count={pending.data?.invitations.length}>
              Invitations
            </Tab>
          )}
        </TabList>
        <TabPanels>
          <TabPanel>
            <MembersRoster />
          </TabPanel>
          {showInvitations && (
            <TabPanel>
              <MembersInvitations
                inviteRequested={tabContext.inviteRequested}
                onInviteRequestHandled={tabContext.onInviteRequestHandled}
              />
            </TabPanel>
          )}
        </TabPanels>
      </Tabs>
    </PageLayout>
  );
}
