import validator from 'validator';

/** Minimum length for an organization name (after trimming). */
export const ORG_NAME_MIN_LENGTH = 2;

/** Maximum length for an organization name (after trimming). */
export const ORG_NAME_MAX_LENGTH = 100;

export interface OrgNameValidationResult {
  valid: boolean;
  sanitized: string;
  error?: string;
}

/**
 * Validates and sanitizes an organization name.
 *
 * - Trims whitespace
 * - Escapes HTML entities to prevent XSS
 * - Enforces min/max length
 */
export function validateOrgName(raw: unknown): OrgNameValidationResult {
  if (typeof raw !== 'string') {
    return { valid: false, sanitized: '', error: 'Organization name must be a string.' };
  }

  const trimmed = validator.trim(raw);

  if (!validator.isLength(trimmed, { min: ORG_NAME_MIN_LENGTH })) {
    return {
      valid: false,
      sanitized: trimmed,
      error: `Organization name must be at least ${ORG_NAME_MIN_LENGTH} characters.`,
    };
  }

  if (!validator.isLength(trimmed, { max: ORG_NAME_MAX_LENGTH })) {
    return {
      valid: false,
      sanitized: trimmed,
      error: `Organization name must be at most ${ORG_NAME_MAX_LENGTH} characters.`,
    };
  }

  const sanitized = validator.escape(trimmed);

  return { valid: true, sanitized };
}
