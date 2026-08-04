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
  const name = `E2E_${role.toUpperCase()}_USER_ID`;
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required E2E credential env var: ${name}. See README.md for details.`);
  }
  return value;
}
