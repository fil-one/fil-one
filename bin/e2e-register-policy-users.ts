#!/usr/bin/env node

// One-time setup for the bucket policy e2e suite (tests/e2e/policies): signs up
// the users it drives on a stage, and records their credentials in the
// gitignored .env.e2e.local that playwright.config.ts loads.
//
// Usage:
//   node bin/e2e-register-policy-users.ts signup  <consoleOrigin> [ROLE...]
//   node bin/e2e-register-policy-users.ts verify  <verificationUrl>
//   node bin/e2e-register-policy-users.ts finish  <consoleOrigin> [ROLE...]
//
// ROLE is one of ROLES below; without one, all of them. `signup` creates the
// accounts through Auth0's signup with generated passwords and writes the
// addresses and passwords. Open the verification links
// Auth0 mails with `verify` (or in any browser), then `finish` logs each account
// in once, which creates its personal organization, and writes its user id.
//
// Credentials go to the file only; nothing is printed. E2E_POLICY_ENV_FILE
// writes them elsewhere, for a stage other than the one .env.e2e.local serves.
// E2E_POLICY_EMAIL_PREFIX sets the address: `<prefix>-<role>@fil.org`.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const ENV_FILE = process.env.E2E_POLICY_ENV_FILE ?? '.env.e2e.local';
const EMAIL_PREFIX = process.env.E2E_POLICY_EMAIL_PREFIX ?? 'srdjan+policy';
const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'READONLY', 'LEAVER'] as const;
type Role = (typeof ROLES)[number];
const PRIMARY_BUTTON_SELECTOR = 'button[data-action-button-primary="true"]';

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

function writeEnv(env: Record<string, string>): void {
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(ENV_FILE, `${body}\n`, { mode: 0o600 });
}

// Letters, digits and symbols from every class Auth0's strength policy counts.
function generatePassword(): string {
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}

async function withBrowserPage(run: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function signUpUsers(origin: string, roles: readonly Role[]): Promise<void> {
  const env = readEnv();
  for (const role of roles) {
    const email = `${EMAIL_PREFIX}-${role.toLowerCase()}@fil.org`;
    const password = generatePassword();
    await withBrowserPage(async (page) => {
      await page.goto(`${origin}/login?screen_hint=signup`);
      await page.locator('#email').fill(email);
      await page.locator(PRIMARY_BUTTON_SELECTOR).click();
      await page.locator('#password').fill(password);
      await page.locator(PRIMARY_BUTTON_SELECTOR).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/u/signup'));
      console.log(`${role}: signup submitted, now at ${new URL(page.url()).pathname}`);
    });
    env[`E2E_POLICY_${role}_EMAIL`] = email;
    env[`E2E_POLICY_${role}_PASSWORD`] = password;
    writeEnv(env);
  }
}

async function openVerificationLink(url: string): Promise<void> {
  await withBrowserPage(async (page) => {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    console.log(`verification page: ${(await page.locator('h1').first().textContent())?.trim()}`);
  });
}

async function recordUserIds(origin: string, roles: readonly Role[]): Promise<void> {
  const env = readEnv();
  for (const role of roles) {
    await withBrowserPage(async (page) => {
      await page.goto(origin);
      await page.locator('#username').fill(env[`E2E_POLICY_${role}_EMAIL`]);
      await page.locator(PRIMARY_BUTTON_SELECTOR).click();
      await page.locator('#password').fill(env[`E2E_POLICY_${role}_PASSWORD`]);
      await page.locator(PRIMARY_BUTTON_SELECTOR).click();
      const skipPasskey = page.locator('button[value="abort-passkey-enrollment"]');
      await Promise.race([
        skipPasskey.waitFor({ state: 'visible' }),
        page.waitForURL(/\/dashboard$/),
      ]);
      if (await skipPasskey.isVisible()) await skipPasskey.click();
      await page.waitForURL(/\/dashboard$/);
      // A new account is alone in its personal org, so the roster's only row is theirs.
      const res = await page.request.get(`${origin}/api/org/members`);
      if (!res.ok())
        throw new Error(
          `GET /api/org/members returned ${res.status()} for ${role}: ${await res.text()}`,
        );
      const { members } = (await res.json()) as { members: { userId: string }[] };
      if (members.length !== 1) throw new Error(`${role} is not alone in their organization`);
      env[`E2E_POLICY_${role}_USER_ID`] = members[0].userId;
      console.log(`${role}: logged in, user id recorded`);
    });
    writeEnv(env);
  }
}

const [command, arg, ...roleArgs] = process.argv.slice(2);
if (!arg) {
  throw new Error('Usage: e2e-register-policy-users.ts <signup|verify|finish> <url> [ROLE...]');
}
const unknown = roleArgs.filter((r) => !(ROLES as readonly string[]).includes(r));
if (unknown.length > 0) throw new Error(`Unknown role: ${unknown.join(', ')}`);
const roles = roleArgs.length > 0 ? (roleArgs as Role[]) : ROLES;
if (command === 'signup') await signUpUsers(arg, roles);
else if (command === 'verify') await openVerificationLink(arg);
else if (command === 'finish') await recordUserIds(arg, roles);
else throw new Error(`Unknown command: ${command}`);
