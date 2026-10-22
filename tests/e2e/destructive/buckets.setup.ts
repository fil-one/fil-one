import { test as setup } from '@playwright/test';
import { STORAGE_STATE, requireUserId, type Role } from './roles.util.ts';
import { ACCOUNT_STATE_TIMEOUT_MS, setAccountState } from './account-state.util.ts';
import { ensureBucketInEachRegion } from './buckets.util.ts';

// Staging sometimes resets its storage layer and every bucket disappears, which
// breaks the upload tests in buckets.spec.ts. This project re-seeds one bucket
// per region for every role. It runs once per role (after `auth.setup.ts`, see
// the `seed-buckets` project in playwright.config.ts) instead of racing across
// the parallel browser projects.
//
// `unpaid` is seeded as `past_due`, which the subscription guard rejects with
// 403 GRACE_PERIOD_WRITE_BLOCKED, so creating a bucket as that role needs the
// account temporarily switched to the `paid` state. The role's own state is
// restored afterwards — before any spec runs — so the dashboard and upload
// tests still see `past_due`.
const SEED_PLAN: ReadonlyArray<{ role: Role; needsActiveSubscription: boolean }> = [
  { role: 'paid', needsActiveSubscription: false },
  { role: 'trial', needsActiveSubscription: false },
  { role: 'unpaid', needsActiveSubscription: true },
];

for (const { role, needsActiveSubscription } of SEED_PLAN) {
  setup.describe(`${role} user`, () => {
    setup.use({ storageState: STORAGE_STATE[role] });

    setup('seed a bucket in every region', async ({ page }) => {
      if (!needsActiveSubscription) {
        await ensureBucketInEachRegion(page, role);
        return;
      }

      // The step changes the account state twice, so it gets twice the budget
      // of a single change.
      setup.setTimeout(2 * ACCOUNT_STATE_TIMEOUT_MS);
      const userId = requireUserId(role);
      try {
        // The Lambda writes the `paid` billing row before it syncs the tenants,
        // so a failed sync leaves the row changed and the `finally` restores it.
        await setAccountState(userId, 'paid');
        await ensureBucketInEachRegion(page, role);
      } finally {
        await setAccountState(userId, role);
      }
    });
  });
}
