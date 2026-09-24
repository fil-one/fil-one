import fs from 'node:fs/promises';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { maybeSkipPasskeyEnrollment } from '../destructive/passkey.util.ts';
import { activateSubscription } from '../destructive/billing-reset.util.ts';
import { resolvePersonalOrgId, seedMembership } from '../destructive/invite.util.ts';
import { REGION, STORAGE_STATE, credentials, type PolicyUser } from './policy.util.ts';

// Logs in the Owner, the Admin, the Member and the ReadOnly user, gives the
// Owner's org an active subscription, and seats the other three in it. The seat is seeded rather than
// invited, as members.spec.ts does; the Member's Hilt principal is created
// lazily, the first time they mint a key.

for (const user of ['owner', 'admin', 'member', 'readonly'] as PolicyUser[]) {
  setup(`authenticate the policy ${user}`, async ({ page }) => {
    const { email, password } = credentials(user);
    await page.goto('/');
    await page.locator('#username').fill(email);
    await page.locator('button[data-action-button-primary="true"]').click();
    await page.locator('#password').fill(password);
    await page.locator('button[data-action-button-primary="true"]').click();
    await maybeSkipPasskeyEnrollment(page);
    await expect(page).toHaveURL(/\/dashboard$/);

    if (user === 'owner') {
      // The suite creates and deletes buckets, so refuse a region that does not
      // serve the `iam` access model before anything is created. The read
      // names no real bucket and writes nothing.
      const probe = await page.request.get(`/api/buckets/pol-probe/policy?region=${REGION}`);
      expect((await probe.json()).message, `${REGION} is not an iam region`).not.toBe(
        'Bucket policies are not available in this region',
      );
      // An org's billing row is written by its first claim of the trial, which
      // GET /api/billing makes; the seat step below then activates it.
      expect((await page.request.get('/api/billing')).status()).toBe(200);
    }

    await fs.mkdir(path.dirname(STORAGE_STATE[user]), { recursive: true });
    await page.context().storageState({ path: STORAGE_STATE[user] });
  });
}

setup('seat the admin, the member and the readonly user in the owner org', async () => {
  const owner = credentials('owner');
  const orgId = await resolvePersonalOrgId(owner.userId);
  // `paid` only picks the subscription state activateSubscription writes.
  await activateSubscription('paid', owner.userId);
  for (const [user, role] of [
    ['admin', 'admin'],
    ['member', 'member'],
    ['readonly', 'readonly'],
  ] as const) {
    await seedMembership({
      orgId,
      userId: credentials(user).userId,
      role,
      invitedBy: owner.userId,
    });
  }
});
