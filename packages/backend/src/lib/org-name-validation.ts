import validator from 'validator';

/**
 * Escapes HTML entities in an org name to prevent XSS.
 * Call this after zod schema validation (OrgNameSchema / ConfirmOrgSchema).
 */
export function sanitizeOrgName(name: string): string {
  return validator.escape(name);
}
