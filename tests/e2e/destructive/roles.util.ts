import fs from 'node:fs';

export const STORAGE_STATE = {
  paid: '.auth/paid.json',
  unpaid: '.auth/unpaid.json',
  trial: '.auth/trial.json',
} as const;

export type Role = keyof typeof STORAGE_STATE;

// Where auth.setup.ts records the role's user id when no E2E_<ROLE>_USER_ID names
// it: a fresh stack (floci in CI) only has the id once the role has logged in.
export function userIdFile(role: Role): string {
  return `.auth/${role}.user-id`;
}

// The role's FilOne user id, needed to address its BillingTable record. Throws
// so setup files that only need the user id (e.g. buckets.setup.ts) fail loudly
// on their own.
export function requireUserId(role: Role): string {
  const fromEnv = process.env[`E2E_${role.toUpperCase()}_USER_ID`];
  if (fromEnv) return fromEnv;
  if (fs.existsSync(userIdFile(role))) return fs.readFileSync(userIdFile(role), 'utf8');
  throw new Error(
    `Neither E2E_${role.toUpperCase()}_USER_ID nor ${userIdFile(role)} names the ${role} user; ` +
      `run the setup project first. See README.md for details.`,
  );
}

// The role's Auth0 sub, which finds its user id on a stack where none is configured.
export function requireAuth0Id(role: Role): string {
  return requireCredential(`E2E_${role.toUpperCase()}_AUTH0_ID`);
}

// The role's address, which the org specs need for the two things an invitation
// is matched by: who it was sent to, and whose allowlist row grants the beta.
export function requireEmail(role: Role): string {
  return requireCredential(`E2E_${role.toUpperCase()}_EMAIL`);
}

// The role's password, for the one flow that has to authenticate again mid-test:
// the ownership transfer's step-up sends the caller back through Auth0.
export function requirePassword(role: Role): string {
  return requireCredential(`E2E_${role.toUpperCase()}_PASSWORD`);
}

function requireCredential(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required E2E credential env var: ${name}. See README.md for details.`);
  }
  return value;
}
