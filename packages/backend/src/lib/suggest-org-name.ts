/**
 * Suggests an organization name based on the user's email address.
 *
 * This function is intentionally isolated so it can be easily changed or removed.
 * It is best-effort only — the suggested name is never blocking.
 */

import * as psl from 'psl';
import {
  ORG_NAME_DISALLOWED_CHARS,
  ORG_NAME_MAX_LENGTH,
  ORG_NAME_MIN_LENGTH,
} from '@filone/shared';
import { PUBLIC_EMAIL_DOMAINS } from './email-normalization.js';

export { PUBLIC_EMAIL_DOMAINS };

const DEFAULT_ORG_NAME = 'My Organization';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kebabToTitleCase(s: string): string {
  return s.split('-').map(capitalize).join(' ');
}

export function suggestOrgNameByEmail(email: string): string | undefined {
  const [localPart, rawDomain] = email.split('@');
  const domain = rawDomain?.toLowerCase();
  if (!domain || !localPart) return undefined;

  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    const raw = capitalize(localPart.toLowerCase());
    const cleaned = raw.replace(ORG_NAME_DISALLOWED_CHARS, '');
    return cleaned.length >= ORG_NAME_MIN_LENGTH ? cleaned : undefined;
  }

  // Use psl to extract the second-level domain label.
  // e.g. "eng.bigcorp.co.uk" → sld "bigcorp", "acme.com" → sld "acme"
  const parsed = psl.parse(domain);
  if ('error' in parsed || !parsed.sld) return undefined;

  return kebabToTitleCase(parsed.sld);
}

/**
 * Derive an org name to auto-assign on first signup. Prefers the user's first name
 * (from the JWT `name` claim), falling back to an email-derived suggestion.
 */
export function deriveOrgName(name?: string, email?: string): string {
  if (name) {
    const firstWord = name.trim().split(/\s+/)[0] ?? '';
    const cleaned = firstWord.replace(ORG_NAME_DISALLOWED_CHARS, '');
    if (cleaned.length >= ORG_NAME_MIN_LENGTH) {
      const base = capitalize(cleaned.toLowerCase());
      const withSuffix = `${base} Org`;
      return withSuffix.length <= ORG_NAME_MAX_LENGTH
        ? withSuffix
        : base.slice(0, ORG_NAME_MAX_LENGTH);
    }
  }
  if (email) {
    const fromEmail = suggestOrgNameByEmail(email);
    if (fromEmail) return fromEmail.slice(0, ORG_NAME_MAX_LENGTH);
  }
  return DEFAULT_ORG_NAME;
}
