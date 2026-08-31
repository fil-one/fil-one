export const STORAGE_STATE = {
  paid: '.auth/paid.json',
  unpaid: '.auth/unpaid.json',
  trial: '.auth/trial.json',
} as const;

export type Role = keyof typeof STORAGE_STATE;

// The role's Auth0 sub, needed to address its BillingTable record. auth.setup.ts
// validates every credential env var up front; this throws too so setup files
// that only need the user id (e.g. buckets.setup.ts) fail loudly on their own.
export function requireUserId(role: Role): string {
  return requireCredential(`E2E_${role.toUpperCase()}_USER_ID`);
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
