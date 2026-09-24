#!/usr/bin/env node

// One-time setup for the bucket policy e2e suite (tests/e2e/policies): signs up
// the Owner and the Member it drives, on a local stage, and records their
// credentials in the gitignored .env.e2e.local that playwright.config.ts loads.
//
// Usage:
//   node bin/e2e-register-policy-users.ts signup  <consoleOrigin>
//   node bin/e2e-register-policy-users.ts verify  <verificationUrl>
//   node bin/e2e-register-policy-users.ts finish  <consoleOrigin>
//
// `signup` creates both accounts through Auth0's signup with generated
// passwords and writes the addresses and passwords. Open the verification links
// Auth0 mails with `verify` (or in any browser), then `finish` logs each account
// in once, which creates its personal organization, and writes its user id.
//
// Credentials go to the file only; nothing is printed.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const ENV_FILE = '.env.e2e.local';
const ROLES = ['OWNER', 'MEMBER'] as const;
const PRIMARY = 'button[data-action-button-primary="true"]';

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

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function signup(origin: string): Promise<void> {
  const env = readEnv();
  for (const role of ROLES) {
    const email = `srdjan+policy-${role.toLowerCase()}@fil.org`;
    const password = generatePassword();
    await withPage(async (page) => {
      await page.goto(`${origin}/login?screen_hint=signup`);
      await page.locator('#email').fill(email);
      await page.locator(PRIMARY).click();
      await page.locator('#password').fill(password);
      await page.locator(PRIMARY).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/u/signup'));
      console.log(`${role}: signup submitted, now at ${new URL(page.url()).pathname}`);
    });
    env[`E2E_POLICY_${role}_EMAIL`] = email;
    env[`E2E_POLICY_${role}_PASSWORD`] = password;
    writeEnv(env);
  }
}

async function verify(url: string): Promise<void> {
  await withPage(async (page) => {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    console.log(`verification page: ${(await page.locator('h1').first().textContent())?.trim()}`);
  });
}

async function finish(origin: string): Promise<void> {
  const env = readEnv();
  for (const role of ROLES) {
    await withPage(async (page) => {
      await page.goto(origin);
      await page.locator('#username').fill(env[`E2E_POLICY_${role}_EMAIL`]);
      await page.locator(PRIMARY).click();
      await page.locator('#password').fill(env[`E2E_POLICY_${role}_PASSWORD`]);
      await page.locator(PRIMARY).click();
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

const [command, arg] = process.argv.slice(2);
if (!arg) throw new Error('Usage: e2e-register-policy-users.ts <signup|verify|finish> <url>');
if (command === 'signup') await signup(arg);
else if (command === 'verify') await verify(arg);
else if (command === 'finish') await finish(arg);
else throw new Error(`Unknown command: ${command}`);
