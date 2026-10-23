import fs from 'node:fs/promises';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { maybeSkipPasskeyEnrollment } from '../destructive/passkey.util.ts';
import { ACCOUNT_STATE_TIMEOUT_MS, setAccountState } from '../destructive/account-state.util.ts';
import { resolvePersonalOrgId, seedMembership } from '../destructive/invite.util.ts';
import { STORAGE_STATE, getCredentials, type PolicyUser } from './policy.util.ts';

// Logs in every user, gives the Owner's org an active subscription, and seats
// the rest in it. The Leaver is a second Member that only the removal case
// uses, so taking them out of the org disturbs no other spec. The seat is seeded rather than
// invited, as members.spec.ts does; the Member's Hilt principal is created
// lazily, the first time they create a key.
// A Hilt principal is the storage-side identity bucket policies name and a user's keys act as.

for (const user of ['owner', 'admin', 'member', 'readonly', 'leaver'] as PolicyUser[]) {
  setup(`authenticate the policy ${user}`, async ({ page }) => {
    const { email, password } = getCredentials(user);
    await page.goto('/');
    await page.locator('#username').fill(email);
    await page.locator('button[data-action-button-primary="true"]').click();
    await page.locator('#password').fill(password);
    await page.locator('button[data-action-button-primary="true"]').click();
    await maybeSkipPasskeyEnrollment(page);
    await expect(page).toHaveURL(/\/dashboard$/);

    if (user === 'owner') {
      // An org's billing row is written by its first claim of the trial, which
      // GET /api/billing makes; the seat step below then activates it.
      expect((await page.request.get('/api/billing')).status()).toBe(200);
    }

    await fs.mkdir(path.dirname(STORAGE_STATE[user]), { recursive: true });
    await page.context().storageState({ path: STORAGE_STATE[user] });
  });
}

setup('seat everyone in the owner org', async () => {
  setup.setTimeout(ACCOUNT_STATE_TIMEOUT_MS);
  const owner = getCredentials('owner');
  const orgId = await resolvePersonalOrgId(owner.userId);
  await setAccountState(owner.userId, 'paid');
  for (const [user, role] of [
    ['admin', 'admin'],
    ['member', 'member'],
    ['readonly', 'readonly'],
    ['leaver', 'member'],
  ] as const) {
    await seedMembership({
      orgId,
      userId: getCredentials(user).userId,
      role,
      invitedBy: owner.userId,
    });
  }
});
