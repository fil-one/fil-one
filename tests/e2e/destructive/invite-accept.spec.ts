import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE, requireEmail, requireUserId } from './roles.util.ts';
import {
  deleteInvitation,
  deleteMembership,
  readOrgName,
  resolvePersonalOrgId,
  runCleanup,
  seedInvitation,
  type SeededInvitation,
} from './invite.util.ts';

// Redeeming an invitation, and what a second membership turns on.
//
// The invitation is written straight to OrgTable rather than created through the
// form, because the token exists only in the email: the console never sees it,
// so a test that drives the form has nothing to open. `invite.util.ts` mints one
// the same way `POST /api/org/invitations` does and keeps the same two rows.
//
// The trial account joins the unpaid account's organization. Two accounts rather
// than one because accepting is gated on the session's verified address matching
// the invitation, and the pair is chosen so the roster assertions below stay
// true while members.spec.ts and transfer.spec.ts seed their own memberships
// elsewhere: they are made about who is in a roster, never about how many.
//
// Cross-run note: these specs mutate shared staging state, and the suite runs
// with one worker in CI (`workers: isCI ? 1 : undefined`). A local run with
// parallel workers races them against each other.

const HOST = 'unpaid';
const INVITEE = 'trial';

test.describe('trial user joins a second organization', () => {
  test.use({ storageState: STORAGE_STATE[INVITEE] });
  test.describe.configure({ mode: 'serial' });

  const hostUserId = requireUserId(HOST);
  const inviteeUserId = requireUserId(INVITEE);

  let hostOrgId: string;
  let hostOrgName: string;
  let personalOrgName: string;
  let invitation: SeededInvitation;

  test.beforeAll(async () => {
    hostOrgId = await resolvePersonalOrgId(hostUserId);
    const personalOrgId = await resolvePersonalOrgId(inviteeUserId);
    [hostOrgName, personalOrgName] = await Promise.all([
      readOrgName(hostOrgId),
      readOrgName(personalOrgId),
    ]);

    // Issued by the host organization's Owner: the accept transaction carries a
    // ConditionCheck that the inviter still holds a role admitting this role.
    invitation = await seedInvitation({
      orgId: hostOrgId,
      email: requireEmail(INVITEE),
      role: 'member',
      invitedBy: hostUserId,
    });
  });

  test.afterAll(async () => {
    await runCleanup([
      // The single-membership invariant: every E2E account ends the run in its
      // own organization and no other.
      {
        label: 'accepted membership',
        run: () => deleteMembership({ orgId: hostOrgId, userId: inviteeUserId }),
      },
      // Accepting deletes the token row and leaves the canonical row marked
      // `accepted`; both keys are dropped here whichever state the test reached.
      {
        label: 'invitation rows',
        run: () =>
          deleteInvitation({
            orgId: hostOrgId,
            inviteId: invitation.inviteId,
            tokenHash: invitation.tokenHash,
          }),
      },
    ]);
  });

  test('trial user accepts an invitation and switches between organizations', async ({ page }) => {
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/api/invitations/accept') &&
        response.request().method() === 'POST',
    );

    // The token rides the fragment, which never leaves the browser — the route
    // reads and strips it before anything else on the page runs.
    await page.goto(`/invite/accept#token=${encodeURIComponent(invitation.token)}`);

    const response = await accepted;
    if (!response.ok()) {
      throw new Error(
        `POST /api/invitations/accept returned ${response.status()} for the ${INVITEE} account ` +
          `joining org ${hostOrgId}. Response body: ${await response.text()}`,
      );
    }

    await expect(page.getByTestId('accept-success')).toBeVisible();

    // Continuing stashes the org and loads the console's root, which is what
    // keeps the org this tab was in out of the org it just joined. A full load
    // rather than a navigation, so the URL landing on the dashboard is what says
    // the new document is the one being asserted about.
    await page.locator('#accept-continue-button').click();
    await page.waitForURL((url) => url.pathname === '/dashboard');
    await expect(page.getByTestId('user-profile')).toContainText(hostOrgName);

    await page.goto('/members');
    await expect(memberRow(page, hostUserId)).toBeVisible();
    await expect(memberRow(page, inviteeUserId)).toHaveAttribute('data-member-role', 'member');

    // The switcher exists only from the second membership onwards, which this
    // acceptance is what produced.
    await page.getByTestId('user-profile').click();
    const switcher = page.getByTestId('org-switcher');
    await expect(switcher).toBeVisible();
    // The active org carries `aria-current`; the other button is the org to
    // switch to, picked by that state rather than by the name it renders.
    await switcher.locator('button:not([aria-current])').click();

    // Switching loads the console's root too, so the same signal applies.
    await page.waitForURL((url) => url.pathname === '/dashboard');
    await expect(page.getByTestId('user-profile')).toContainText(personalOrgName);

    // The rosters are different lists, not the same one re-rendered: the org the
    // invitee came from has nobody else in it.
    await page.goto('/members');
    await expect(memberRow(page, inviteeUserId)).toBeVisible();
    await expect(memberRow(page, hostUserId)).toHaveCount(0);
  });
});

function memberRow(page: Page, userId: string) {
  return page.locator(`[data-testid="member-row"][data-member-id="${userId}"]`);
}
