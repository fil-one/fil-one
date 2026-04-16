import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STORAGE_STATE, type Role } from './roles.ts';
import { resetBillingState } from './billing-reset.ts';

const roles: ReadonlyArray<{
  name: Role;
  email: string;
  password: string;
  userId: string;
}> = [
  {
    name: 'paid',
    email: process.env.E2E_PAID_EMAIL!,
    password: process.env.E2E_PAID_PASSWORD!,
    userId: process.env.E2E_PAID_USER_ID!,
  },
  {
    name: 'unpaid',
    email: process.env.E2E_UNPAID_EMAIL!,
    password: process.env.E2E_UNPAID_PASSWORD!,
    userId: process.env.E2E_UNPAID_USER_ID!,
  },
  {
    name: 'trial',
    email: process.env.E2E_TRIAL_EMAIL!,
    password: process.env.E2E_TRIAL_PASSWORD!,
    userId: process.env.E2E_TRIAL_USER_ID!,
  },
];

for (const role of roles) {
  setup(`authenticate as ${role.name}`, async ({ page }) => {
    // Re-seed the BillingTable record so dashboard tests see deterministic
    // state. Trial periods elapse and `past_due` can advance to `canceled`
    // between scheduled runs, so the prior run's state is not safe to reuse.
    await resetBillingState(role.name, role.userId);

    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email address' }).fill(role.email);
    await page.getByRole('textbox', { name: 'Password' }).fill(role.password);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard$/);

    const storagePath = STORAGE_STATE[role.name];
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await page.context().storageState({ path: storagePath });
    await page.context().storageState({ path: STORAGE_STATE[role.name] });
  });
}
