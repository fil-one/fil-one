import validator from 'validator';
import { OrgNameSchema, ConfirmOrgSchema, ORG_NAME_MAX_LENGTH } from '@filone/shared';

/**
 * Extends OrgNameSchema with an HTML-escape transform and a post-escape length check.
 * Escaping can expand the string (e.g. '&' → '&amp;'), so we validate the stored
 * value's length after sanitization rather than before.
 */
export const SanitizedOrgNameSchema = OrgNameSchema.transform((name) =>
  validator.escape(name),
).refine(
  (escaped) => escaped.length <= ORG_NAME_MAX_LENGTH,
  `Organization name must be at most ${ORG_NAME_MAX_LENGTH} characters`,
);

/** Backend-specific confirm-org schema: validates then sanitizes the org name. */
export const ConfirmOrgBackendSchema = ConfirmOrgSchema.transform((data) => ({
  ...data,
  orgName: validator.escape(data.orgName),
})).refine(
  (data) => data.orgName.length <= ORG_NAME_MAX_LENGTH,
  `Organization name must be at most ${ORG_NAME_MAX_LENGTH} characters`,
);
