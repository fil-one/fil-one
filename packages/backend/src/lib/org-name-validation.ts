import validator from 'validator';
import { OrgNameSchema, ORG_NAME_MAX_LENGTH } from '@filone/shared';

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
