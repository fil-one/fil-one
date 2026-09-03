import { test, expect, type Page, type Response } from '@playwright/test';
import { STORAGE_STATE, requireEmail, requirePassword, requireUserId } from './roles.util.ts';
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

// Handing the organization to somebody else, including the trip through Auth0
// the server asks for.
//
// `POST /api/org/transfer` is the one org route behind a step-up
// (`requireMfaIfEnrolled`): it wants an authentication newer than five minutes,
// and answers a stale session with 401 `step_up_required`. The console then
// leaves for `/login?acr_values=…&max_age=0`, comes back to `/organization`
// with the action it stashed, and reopens this dialog for the same member — so
// the test signs in again in the middle, the way auth.setup.ts signs in at the
// start.
//
// Whether the step-up fires depends on how long ago `auth.setup.ts` ran, which
// no test can decide: a suite that reaches this spec inside five minutes gets a
// transfer that lands on the first click. Both routes are driven below and both
// assert the same end state. The one shape this cannot drive is an account with
// an authenticator enrolled at Auth0, whose step-up is an MFA challenge rather
// than a password: the E2E accounts skip passkey enrollment and enroll nothing,
// and one that did would need a seeded TOTP secret here.
//
// Cross-run note: these specs mutate shared staging state, and the suite runs
// with one worker in CI (`workers: isCI ? 1 : undefined`). A local run with
// parallel workers races them against each other.

const OWNER = 'trial';
const SUCCESSOR = 'paid';

/** The round trip is a full sign-in on top of two page loads. */
const TRANSFER_TEST_TIMEOUT_MS = 180_000;
const AUTH0_TIMEOUT_MS = 60_000;

test.describe('trial owner transfers the organization', () => {
  test.use({ storageState: STORAGE_STATE[OWNER] });
  test.describe.configure({ mode: 'serial' });

  const ownerUserId = requireUserId(OWNER);
  const successorUserId = requireUserId(SUCCESSOR);

  let orgId: string;
  let orgName: string;

  test.beforeAll(async () => {
    orgId = await resolvePersonalOrgId(ownerUserId);
    orgName = await readOrgName(orgId);

    await grantEmailBeta(requireEmail(OWNER));
    // Admin, because the seat is what this spec moves: a second Owner cannot be
    // seeded without the counter that guards the last one.
    await seedMembership({
      orgId,
      userId: successorUserId,
      role: 'admin',
      invitedBy: ownerUserId,
    });
  });

  test.afterAll(async () => {
    // The seat first, then the rows: putting the original Owner back before the
    // successor's membership goes leaves the org owned at every step. Each step
    // is isolated so a transaction cancelled by throttling or a conflict costs
    // one repair rather than every repair after it — this is the spec that
    // would otherwise leave the org with two Admins and no Owner.
    await runCleanup([
      {
        label: 'owner seat',
        run: () => setMembershipRole({ orgId, userId: ownerUserId, role: 'owner' }),
      },
      {
        label: 'successor membership',
        run: () => deleteMembership({ orgId, userId: successorUserId }),
      },
      { label: 'ownerCount', run: () => repairOwnerCount(orgId) },
      { label: 'beta grant', run: () => revokeEmailBeta(requireEmail(OWNER)) },
    ]);
  });

  test('trial owner hands the organization to another member', async ({ page }) => {
    test.setTimeout(TRANSFER_TEST_TIMEOUT_MS);

    await page.goto('/members');
    const successorRow = memberRow(page, successorUserId);
    await expect(successorRow).toHaveAttribute('data-member-role', 'admin');

    // Both of a row's verbs live in its overflow menu, whose panel Headless UI
    // portals to the document — so the trigger is found on the row and the item
    // is not.
    await successorRow.locator('button[aria-label^="Actions for "]').click();
    await page.getByTestId('member-action-transfer-ownership').click();
    await expect(page.getByTestId('transfer-dialog')).toBeVisible();

    const firstAttempt = transferResponse(page);
    await confirmTransfer(page, orgName);
    const first = await firstAttempt;

    if (first.status() === 401) {
      await reauthenticateThroughAuth0(page);
      // The step-up stash brings the caller back to the page they left, with the
      // member the transfer was about named in `?action=`.
      await page.waitForURL((url) => url.pathname === '/organization', {
        timeout: AUTH0_TIMEOUT_MS,
      });
      // Reopened rather than resubmitted: the change nobody can reverse on their
      // own is not fired off the back of a redirect.
      await expect(page.getByTestId('transfer-dialog')).toBeVisible();

      const resumedAttempt = transferResponse(page);
      await confirmTransfer(page, orgName);
      await expectTransferred(await resumedAttempt, { orgId, ownerUserId, successorUserId });
    } else {
      await expectTransferred(first, { orgId, ownerUserId, successorUserId });
    }

    // Both seats, from the server rather than from the cache the mutation
    // patched: the org keeps exactly one Owner, and the caller is an Admin.
    await page.reload();
    await expect(memberRow(page, successorUserId)).toHaveAttribute('data-member-role', 'owner');
    await expect(memberRow(page, ownerUserId)).toHaveAttribute('data-member-role', 'admin');
  });
});

function memberRow(page: Page, userId: string) {
  return page.locator(`[data-testid="member-row"][data-member-id="${userId}"]`);
}

function transferResponse(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/api/org/transfer') &&
      response.request().method() === 'POST',
  );
}

/** The dialog's confirm button stays inert until the org's name is typed out. */
async function confirmTransfer(page: Page, orgName: string): Promise<void> {
  await page.locator('#transfer-confirm-name').fill(orgName);
  await page.locator('#transfer-confirm-button').click();
}

async function expectTransferred(
  response: Response,
  {
    orgId,
    ownerUserId,
    successorUserId,
  }: Record<'orgId' | 'ownerUserId' | 'successorUserId', string>,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `POST /api/org/transfer returned ${response.status()} moving the owner seat in org ` +
        `${orgId}. Response body: ${await response.text()}`,
    );
  }
  expect((await response.json()) as Record<string, string>).toMatchObject({
    userId: successorUserId,
    previousOwnerUserId: ownerUserId,
  });
}

/**
 * Sign in again, which is what `max_age=0` asks for.
 *
 * Auth0 may present the identifier page or go straight to the password
 * depending on what the session it is refusing to reuse still tells it, so both
 * are handled — the selectors are auth.setup.ts's.
 */
async function reauthenticateThroughAuth0(page: Page): Promise<void> {
  const username = page.locator('#username');
  const password = page.locator('#password');
  const primaryButton = page.locator('button[data-action-button-primary="true"]');

  await expect(username.or(password).first()).toBeVisible({ timeout: AUTH0_TIMEOUT_MS });
  if (await username.isVisible()) {
    await username.fill(requireEmail(OWNER));
    await primaryButton.click();
  }
  await password.fill(requirePassword(OWNER));
  await primaryButton.click();

  await skipPasskeyEnrollmentIfOffered(page);
}

/**
 * Dismiss the passkey enrollment screen when Auth0 offers it.
 *
 * `passkey.util.ts` waits for `/dashboard`, which is where a sign-in from
 * scratch lands. This one comes back through the step-up, and the console
 * bounces off `/dashboard` to the page the action was stashed from — so either
 * path means the prompt never appeared.
 */
async function skipPasskeyEnrollmentIfOffered(page: Page): Promise<void> {
  const skip = page.locator('button[value="abort-passkey-enrollment"]');
  const landed = new Set(['/dashboard', '/organization']);

  await Promise.race([
    skip.waitFor({ state: 'visible' }).catch(() => {}),
    page.waitForURL((url) => landed.has(url.pathname)).catch(() => {}),
  ]);

  if (await skip.isVisible()) await skip.click();
}
