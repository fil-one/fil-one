import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MeResponse } from '@filone/shared';
import {
  STORAGE_STATE,
  requireAuth0Id,
  requireEmail,
  requirePassword,
  requireUserId,
  userIdFile,
  type Role,
} from './roles.util.ts';
import { resetBillingState } from './billing-reset.util.ts';
import { grantEmailBeta, userIdBySub } from './invite.util.ts';
import { maybeSkipPasskeyEnrollment } from './passkey.util.ts';
import { api } from '../multi-org/fixtures.ts';
import { setOrgName } from '../multi-org/org.util.ts';
import { LANDED } from '../multi-org/users.util.ts';

// A role's user id comes from E2E_<ROLE>_USER_ID on a stack whose accounts
// already exist (staging), or is looked up by E2E_<ROLE>_AUTH0_ID after the
// first login on a fresh one (floci in CI).
const ROLES = ['paid', 'unpaid', 'trial'] as const satisfies ReadonlyArray<Role>;

const missingCredentials = ROLES.flatMap((role) => {
  const prefix = `E2E_${role.toUpperCase()}_`;
  const missing = ['EMAIL', 'PASSWORD'].filter((field) => !process.env[prefix + field]);
  if (!process.env[`${prefix}USER_ID`] && !process.env[`${prefix}AUTH0_ID`]) {
    missing.push('USER_ID or AUTH0_ID');
  }
  return missing.map((field) => prefix + field);
});
if (missingCredentials.length > 0) {
  throw new Error(
    `Missing required E2E credential env vars: ${missingCredentials.join(', ')}. ` +
      `See README.md for details.`,
  );
}

for (const role of ROLES) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    const email = requireEmail(role);
    await grantEmailBeta(email);

    await page.goto('/');
    await page.locator('#username').fill(email);
    await page.locator('button[data-action-button-primary="true"]').click();
    await page.locator('#password').fill(requirePassword(role));
    await page.locator('button[data-action-button-primary="true"]').click();

    await maybeSkipPasskeyEnrollment(page);
    await expect(page).toHaveURL(LANDED);

    // On a fresh stack this first /me creates the account, and /billing claims
    // its trial; on an existing one both are no-ops.
    const me = await api(page, 'GET', '/api/me');
    expect(me.status()).toBe(200);
    const { orgId, nameConfirmed } = (await me.json()) as MeResponse;
    if (nameConfirmed === false) await setOrgName(orgId, { name: `E2E ${role} org` });
    expect((await api(page, 'GET', '/api/billing')).status()).toBe(200);

    if (!process.env[`E2E_${role.toUpperCase()}_USER_ID`]) {
      const userId = await userIdBySub(requireAuth0Id(role));
      if (!userId) throw new Error(`No account for the ${role} user after logging in.`);
      await fs.mkdir(path.dirname(userIdFile(role)), { recursive: true });
      await fs.writeFile(userIdFile(role), userId);
    }

    // Re-seed the BillingTable record so dashboard tests see deterministic
    // state. Trial periods elapse and `past_due` can advance to `canceled`
    // between scheduled runs, so the prior run's state is not safe to reuse.
    await resetBillingState(role, requireUserId(role));

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);

    const storagePath = STORAGE_STATE[role];
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await page.context().storageState({ path: storagePath });
  });
}
