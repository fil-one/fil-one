/**
 * Suggests an organization name based on the user's email address.
 *
 * This function is intentionally isolated so it can be easily changed or removed.
 * It is best-effort only — the suggested name is never blocking.
 */

export const PUBLIC_EMAIL_DOMAINS = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  // Yahoo
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.fr',
  'ymail.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // AOL
  'aol.com',
  // Proton
  'proton.me',
  'protonmail.com',
  'pm.me',
  // Other Western providers
  'zoho.com',
  'mail.com',
  'gmx.com',
  'gmx.net',
  'fastmail.com',
  'tutanota.com',
  'tutamail.com',
  'tuta.io',
  'hey.com',
  // Russian providers
  'mail.ru',
  'yandex.com',
  // Chinese providers
  'qq.com',
  '163.com',
  '126.com',
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
