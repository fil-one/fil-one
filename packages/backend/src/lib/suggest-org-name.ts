/**
 * Suggests an organization name based on the user's email address.
 *
 * This function is intentionally isolated so it can be easily changed or removed.
 * It is best-effort only — the suggested name is never blocking.
 */

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'mail.com',
  'gmx.com',
  'gmx.net',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
]);

export function suggestOrgName(email: string | undefined, userId: string): string | undefined {
  if (!email) {
    console.warn('[suggest-org-name] No email available for org name suggestion', { userId });
    return undefined;
  }

  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return undefined;

  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return undefined;
  }

  // Use the domain without TLD as the suggestion, capitalised.
  // e.g. "acme.com" → "Acme"
  const parts = domain.split('.');
  const name = parts[0];
  if (!name) return undefined;

  return name.charAt(0).toUpperCase() + name.slice(1);
}
