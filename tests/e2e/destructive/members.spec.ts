import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE, requireEmail, requireUserId } from './roles.util.ts';
import {
  deleteMembership,
  grantEmailBeta,
  readOrgName,
  repairOwnerCount,
  resolvePersonalOrgId,
  revokeEmailBeta,
  runCleanup,
  seedMembership,
  setMembershipRole,
} from './invite.util.ts';

// What an Owner can do to the people already in the organization, and what the
// organization refuses.
//
// The second member is seeded rather than invited: an acceptance needs the
// invitee's own session, which invite-accept.spec.ts drives. Here the member is
// the material for three changes — a role change, the refusal that keeps an
// organization owned, and a removal the removed account then walks into.
//
// The beta is granted as the caller's ALLOWLIST#{email} row, so this spec and
// invitations.spec.ts — same account, same organization — hold their grants
// under different keys and neither teardown can revoke the other's.
//
// Cross-run note: these specs mutate shared staging state, and the suite runs
// with one worker in CI (`workers: isCI ? 1 : undefined`). A local run with
// parallel workers races them against each other.

const OWNER = 'paid';
const MEMBER = 'unpaid';

test.describe('paid owner manages members', () => {
  test.use({ storageState: STORAGE_STATE[OWNER] });
  test.describe.configure({ mode: 'serial' });

  const ownerUserId = requireUserId(OWNER);
  const memberUserId = requireUserId(MEMBER);

  let orgId: string;
  let orgName: string;
  let memberOwnOrgName: string;

  test.beforeAll(async () => {
    orgId = await resolvePersonalOrgId(ownerUserId);
    orgName = await readOrgName(orgId);
    memberOwnOrgName = await readOrgName(await resolvePersonalOrgId(memberUserId));

    await grantEmailBeta(requireEmail(OWNER));
    await seedMembership({
      orgId,
      userId: memberUserId,
      role: 'member',
      invitedBy: ownerUserId,
    });
  });

  test.afterAll(async () => {
    await runCleanup([
      // The seat first, for the same reason transfer.spec.ts restores its own:
      // nothing here should move the owner set, but the last-owner test only
      // holds while the guard does, and the run that catches a regression is
      // the one that leaves this account an Admin in its own org — a state no
      // product path undoes, since only an Owner may hand out Owner. The
      // counter below then recounts a set that is whole.
      {
        label: 'owner seat',
        run: () => setMembershipRole({ orgId, userId: ownerUserId, role: 'owner' }),
      },
      // Idempotent: the removal test takes these rows away itself, and a run that
      // failed before it leaves them for this.
      { label: 'seeded membership', run: () => deleteMembership({ orgId, userId: memberUserId }) },
      // The counter is the last-Owner invariant and a teardown is the wrong
      // place to assume nothing touched it.
      { label: 'ownerCount', run: () => repairOwnerCount(orgId) },
      { label: 'beta grant', run: () => revokeEmailBeta(requireEmail(OWNER)) },
    ]);
  });

  test('owner changes a member role through the picker', async ({ page }) => {
    await page.goto('/members');
    const row = memberRow(page, memberUserId);
    await expect(row).toHaveAttribute('data-member-role', 'member');

    const patched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/api/org/members/${memberUserId}`) &&
        response.request().method() === 'PATCH',
    );
    // A move that is neither a promotion to Owner nor the caller's own row
    // applies on the change event, with no confirmation in between.
    await row.locator('select').selectOption('admin');

    const response = await patched;
    if (!response.ok()) {
      throw new Error(
        `PATCH /api/org/members/${memberUserId} returned ${response.status()} in org ${orgId}. ` +
          `Response body: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { role: string; previousRole: string };
    expect(body).toMatchObject({ role: 'admin', previousRole: 'member' });

    // Reloaded, so the badge under assertion is the roster the server answers
    // with rather than the cache edit the mutation made on success.
    await page.reload();
    await expect(memberRow(page, memberUserId)).toHaveAttribute('data-member-role', 'admin');
  });

  test('the last owner cannot demote themselves', async ({ page }) => {
    await page.goto('/members');
    const ownRow = memberRow(page, ownerUserId);
    await expect(ownRow).toHaveAttribute('data-member-role', 'owner');

    const patched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/api/org/members/${ownerUserId}`) &&
        response.request().method() === 'PATCH',
    );
    // The caller's own row is confirmed first: this is the change that takes
    // away their own authority.
    await ownRow.locator('select').selectOption('admin');
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-confirm-button').click();

    const response = await patched;
    expect(response.status()).toBe(409);
    expect((await response.json()) as { code?: string }).toMatchObject({ code: 'LAST_OWNER' });

    // The refusal carries a remedy, so it stays on the page instead of being
    // toasted away while the operator is still looking at the row.
    await expect(page.getByTestId('members-last-owner')).toBeVisible();

    await page.reload();
    await expect(memberRow(page, ownerUserId)).toHaveAttribute('data-member-role', 'owner');
  });

  test('a removed member lands back in their own organization', async ({ page, browser }) => {
    // The removed account's own tab, which has to be sitting in the org it is
    // about to lose for the recovery to have anything to recover from.
    const memberContext = await browser.newContext({ storageState: STORAGE_STATE[MEMBER] });
    const memberPage = await memberContext.newPage();

    try {
      await memberPage.goto('/dashboard');
      await memberPage.getByTestId('user-profile').click();
      await memberPage.getByTestId('org-switcher').locator('button:not([aria-current])').click();
      await expect(memberPage.getByTestId('user-profile')).toContainText(orgName);
      await expect.poll(() => activeOrgStash(memberPage)).toBe(orgId);

      await page.goto('/members');
      const row = memberRow(page, memberUserId);
      const removed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith(`/api/org/members/${memberUserId}`) &&
          response.request().method() === 'DELETE',
      );
      // Remove is an item in the row's overflow menu, whose panel Headless UI
      // portals to the document — so the trigger is found on the row and the
      // item is not.
      await row.locator('button[aria-label^="Actions for "]').click();
      await page.getByTestId('member-action-remove').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.locator('#confirm-dialog-confirm-button').click();

      const response = await removed;
      if (!response.ok()) {
        throw new Error(
          `DELETE /api/org/members/${memberUserId} returned ${response.status()} in org ${orgId}. ` +
            `Response body: ${await response.text()}`,
        );
      }
      await expect(row).toHaveCount(0);

      // The removed tab's next navigation: `/me` answers under the account's own
      // org instead of refusing the header, the console notices the echo does not
      // match what it asked for, drops the stash and reloads. What it must not be
      // is a dead end — no interstitial, no 403 page, just the account's own org.
      await memberPage.goto('/buckets');
      await expect(memberPage.getByTestId('user-profile')).toContainText(memberOwnOrgName);
      await expect(memberPage.getByTestId('not-a-member')).toHaveCount(0);
      await expect(memberPage.getByTestId('nav-buckets')).toBeVisible();
      // The stash is what the recovery drops on its way to the reload, and the
      // one piece of evidence the rendered page cannot fake: `/me` answers under
      // the account's own org either way, so the sidebar reads the same before
      // the reload as after it.
      await expect.poll(() => activeOrgStash(memberPage)).toBeNull();
    } finally {
      await memberContext.close();
    }
  });
});

function memberRow(page: Page, userId: string) {
  return page.locator(`[data-testid="member-row"][data-member-id="${userId}"]`);
}

/**
 * Which organization this tab is operating in, from the per-tab stash the
 * console keeps (`filone:activeOrgId`, lib/active-org.ts). Read rather than
 * driven because it is the state a switch writes and a recovery clears.
 *
 * A read that lands mid-reload has no execution context to run in, and the
 * recovery under test is a reload — so that answers `undefined`, which is
 * neither of the values the callers assert and leaves `expect.poll` polling.
 */
function activeOrgStash(page: Page): Promise<string | null | undefined> {
  return page.evaluate(() => sessionStorage.getItem('filone:activeOrgId')).catch(() => undefined);
}
