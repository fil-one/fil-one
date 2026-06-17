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

// Dots are insignificant only for Gmail-family domains.
// googlemail.com is a legacy Google domain that delivers to the same inbox as gmail.com.
const GMAIL_FAMILY_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const DOMAIN_ALIASES: Record<string, string> = {
  'googlemail.com': 'gmail.com',
};

/**
 * Returns a canonical email form used solely as a trial-entitlement key.
 * Never use this to rewrite or display the user's email.
 *
 * Rules:
 *  - Always lowercase.
 *  - For PUBLIC_EMAIL_DOMAINS: strip +suffix from the local part.
 *  - For Gmail-family domains: also strip dots from the local part.
 *  - For all other domains: lowercase only (corporate subaddressing may be real).
 */
export function normalizeEmailForEntitlement(email: string): string {
  const atIdx = email.indexOf('@');
  if (atIdx === -1) return email.toLowerCase();

  const rawLocal = email.slice(0, atIdx);
  const domain =
    DOMAIN_ALIASES[email.slice(atIdx + 1).toLowerCase()] ?? email.slice(atIdx + 1).toLowerCase();

  if (!PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return `${rawLocal.toLowerCase()}@${domain}`;
  }

  let local = rawLocal.split('+')[0] ?? rawLocal;

  if (GMAIL_FAMILY_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
  }

  return `${local.toLowerCase()}@${domain}`;
}
