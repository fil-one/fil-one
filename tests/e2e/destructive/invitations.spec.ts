import { test, expect } from '@playwright/test';
import { STORAGE_STATE, requireEmail, requireUserId } from './roles.util.ts';
import {
  deleteInvitationsFor,
  grantOrgBeta,
  resolvePersonalOrgId,
  revokeOrgBeta,
  runCleanup,
  uniqueInviteEmail,
} from './invite.util.ts';

// Inviting somebody and withdrawing it again, through the form an Owner uses.
//
// The organizations beta is granted here as the ORG#{orgId} row rather than the
// caller's allowlist row, so this spec's teardown cannot take the grant away
// from members.spec.ts, which runs against the same account and grants itself
// the ALLOWLIST#{email} one.
//
// The address is minted per run because the three browser projects run this same
// spec against the same staging organization, and re-inviting an address revokes
// whatever live invitation it already had — two runs sharing one address would
// each withdraw the other's row. The invitation really goes out through SendGrid
// on staging; the plus tag keeps it deliverable to a mailbox we own, and nothing
// here reads mail.
//
// The refusals — the beta gate and the pending cap — are covered by unit tests
// and are not re-driven here.

const ROLE = 'paid';

test.describe('paid user (organizations beta)', () => {
  test.use({ storageState: STORAGE_STATE[ROLE] });
  test.describe.configure({ mode: 'serial' });

  const invitedEmail = uniqueInviteEmail(requireEmail(ROLE));
  let orgId: string;

  test.beforeAll(async () => {
    orgId = await resolvePersonalOrgId(requireUserId(ROLE));
    await grantOrgBeta(orgId);
  });

  test.afterAll(async () => {
    await runCleanup([
      // Both the row the test withdrew and any row a failure left behind: the
      // pending cap counts addresses, and a leaked one is a slot nobody frees.
      { label: 'invitation rows', run: () => deleteInvitationsFor({ orgId, email: invitedEmail }) },
      { label: 'beta grant', run: () => revokeOrgBeta(orgId) },
    ]);
  });

  test('paid user invites a teammate and withdraws the invitation', async ({ page }) => {
    // Members is its own page now, reached from the org switcher; navigating
    // straight to it is what the switcher's link resolves to.
    await page.goto('/members');
    await expect(page.locator('#members-heading')).toBeVisible();

    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/api/org/invitations') &&
        response.request().method() === 'POST',
    );

    // The form lives in a dialog and nowhere else: `Modal` is a Headless UI
    // `Transition`, so none of these fields is on the page until the trigger
    // mounts them. The trigger is the Organization page's own Add member
    // button, in the header above the tabs; pressing it selects the
    // Invitations tab, which is the panel that owns the dialog.
    await page.getByTestId('org-invite-button').click();
    const dialog = page.getByTestId('invite-dialog');
    await expect(dialog).toBeVisible();

    await dialog.locator('#invite-email').fill(invitedEmail);
    // The role is a fieldset of radios, one per role the caller may hand out.
    // The input itself is `sr-only`, so the label card around it is the control
    // a person clicks and the one this drives.
    await dialog.locator('label:has(input[name="invite-role"][value="member"])').click();
    await dialog.locator('#invite-submit-button').click();

    // Read the response rather than only the rendered row: a refusal keeps the
    // form on screen with an alert, which would otherwise surface as an opaque
    // timeout on the row that never arrived.
    const response = await created;
    if (!response.ok()) {
      throw new Error(
        `POST /api/org/invitations returned ${response.status()} for "${invitedEmail}" in org ` +
          `${orgId}. Response body: ${await response.text()}`,
      );
    }

    const { invitation, emailSent } = (await response.json()) as {
      invitation: { inviteId: string; email: string; role: string };
      emailSent: boolean;
    };
    expect(invitation.role).toBe('member');
    // The row is committed before the send, so `emailSent: false` is a live
    // invitation nobody was told about — a real SendGrid failure on the stage,
    // not a flake to retry through.
    expect(emailSent, `SendGrid did not accept the invitation for ${invitedEmail}`).toBe(true);

    const row = page.locator(
      `[data-testid="invitation-row"][data-invite-id="${invitation.inviteId}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row).toContainText(invitedEmail);
    await expect(page.getByTestId('invite-undelivered')).toHaveCount(0);

    const revoked = page.waitForResponse(
      (response_) =>
        new URL(response_.url()).pathname.endsWith(`/api/org/invitations/${invitation.inviteId}`) &&
        response_.request().method() === 'DELETE',
    );
    await row.locator('button[aria-label^="Revoke invitation for "]').click();
    const revokeResponse = await revoked;
    if (!revokeResponse.ok()) {
      throw new Error(
        `DELETE /api/org/invitations/${invitation.inviteId} returned ${revokeResponse.status()}. ` +
          `Response body: ${await revokeResponse.text()}`,
      );
    }

    await expect(row).toHaveCount(0);

    // Only pending invitations reach the list, so a reload is what says the
    // withdrawal is the server's answer rather than the cache edit that follows
    // a successful revoke.
    await page.reload();
    await expect(page.locator('#members-heading')).toBeVisible();
    // A reload comes back on the default tab, and the row lives in the
    // Invitations panel: without selecting it, "no such row" is true of every
    // run and says nothing about the withdrawal.
    await page.getByTestId('org-tab-invitations').click();
    await expect(page.getByTestId('invitations-section')).toBeVisible();
    await expect(
      page.locator(`[data-testid="invitation-row"][data-invite-id="${invitation.inviteId}"]`),
    ).toHaveCount(0);
  });
});
