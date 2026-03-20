/**
 * Suggests an organization name based on the user's email address.
 *
 * This function is intentionally isolated so it can be easily changed or removed.
 * It is best-effort only — the suggested name is never blocking.
 */

import * as psl from 'psl';

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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kebabToTitleCase(s: string): string {
  return s.split('-').map(capitalize).join(' ');
}

export function suggestOrgName(email: string): string | undefined {
  const [localPart, rawDomain] = email.split('@');
  const domain = rawDomain?.toLowerCase();
  if (!domain || !localPart) return undefined;

  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return capitalize(localPart.toLowerCase());
  }

  // Use psl to extract the second-level domain label.
  // e.g. "eng.bigcorp.co.uk" → sld "bigcorp", "acme.com" → sld "acme"
  const parsed = psl.parse(domain);
  if ('error' in parsed || !parsed.sld) return undefined;

  return kebabToTitleCase(parsed.sld);
}
