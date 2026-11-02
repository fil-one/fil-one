import fs from 'node:fs/promises';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { maybeSkipPasskeyEnrollment } from '../destructive/passkey.util.ts';
import { ACCOUNT_STATE_TIMEOUT_MS, setAccountState } from '../destructive/account-state.util.ts';
import { resolvePersonalOrgId, seedMembership } from '../destructive/invite.util.ts';
import { setOrgName } from '../multi-org/org.util.ts';
import {
  ConsoleApi,
  STORAGE_STATE,
  emptyAndDeleteBucket,
  getCredentials,
  type PolicyUser,
} from './policy.util.ts';

// Logs in every user, gives the Owner's org an active subscription, and seats
// the rest in it. The Leaver is a second Member that only the removal case
// uses, so taking them out of the org disturbs no other spec. The seat is seeded rather than
// invited, as members.spec.ts does; the Member's Hilt principal is created
// lazily, the first time they create a key.
// A Hilt principal is the storage-side identity bucket policies name and a user's keys act as.

for (const user of ['owner', 'admin', 'member', 'readonly', 'leaver'] as PolicyUser[]) {
  setup(`authenticate the policy ${user}`, async ({ page }) => {
    const { email, password, userId } = getCredentials(user);
    if (user === 'owner') {
      // The Owner's personal org is their only membership, so while it is
      // unnamed the console sends them to /create-organization on every page.
      await setOrgName(await resolvePersonalOrgId(userId), {});
    }
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

// Every case deletes its buckets and keys afterwards, but a run that ends at
// the global timeout or crashes never gets there, and what it leaves stays in
// the Owner's org. Each key a principal holds makes every later policy write
// for it slower, so the leftovers are cleared here, before any case runs: the
// keys first, because emptying a bucket writes a policy, which is cheap only
// once the keys are gone. Runs of the suite never overlap (e2e-suites.yaml),
// so everything in the org is a leftover. A deletion that fails is logged and
// left for the next run rather than failing the setup, which would skip the
// suite; the sweep stops starting deletions at SWEEP_BUDGET_MS so a large
// backlog drains over several runs instead of eating the suite's time.
const SWEEP_BUDGET_MS = 10 * 60_000;

setup('clear what earlier runs left in the owner org', async () => {
  setup.setTimeout(SWEEP_BUDGET_MS + 5 * 60_000);
  const { userId: ownerId } = getCredentials('owner');
  const owner = await ConsoleApi.open('owner', await resolvePersonalOrgId(ownerId));
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  try {
    const keys = await owner.listKeyIds();
    const keyReport = await sweep(keys, 8, deadline, (id) => owner.deleteKey(id));
    console.log(`policies-setup: keys left by earlier runs: ${keys.length}; ${keyReport}`);

    const buckets = await owner.listBucketNames();
    const bucketReport = await sweep(buckets, 4, deadline, (bucket) =>
      emptyAndDeleteBucket(owner, ownerId, bucket),
    );
    console.log(`policies-setup: buckets left by earlier runs: ${buckets.length}; ${bucketReport}`);
  } finally {
    await owner.dispose();
  }
});

/**
 * Runs remove over items, `width` at a time, starting none after deadline, and
 * reports how many it removed, how many failed (logging each) and how many it
 * left for the next run.
 */
async function sweep<T>(
  items: readonly T[],
  width: number,
  deadline: number,
  remove: (item: T) => Promise<void>,
): Promise<string> {
  let next = 0;
  let removed = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length && Date.now() < deadline) {
        const item = items[next++];
        try {
          await remove(item);
          removed++;
        } catch (error) {
          failed++;
          const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
          console.warn(`policies-setup: could not remove ${String(item)}: ${reason}`);
        }
      }
    }),
  );
  return `removed ${removed}, failed ${failed}, left ${items.length - next}`;
}
