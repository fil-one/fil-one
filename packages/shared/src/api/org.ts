import { z } from 'zod';

/**
 * A member's role in an organization. Ordered highest authority first; the
 * capabilities behind each value live in `ROLE_PERMISSIONS` (permissions.ts).
 *
 * `admin` predates the four-role model and is the value every pre-M1 membership
 * row carries. Those rows are converted to `owner` as they move into OrgTable —
 * every pre-conversion account is an org of one.
 */
export const OrgRole = {
  Owner: 'owner',
  Admin: 'admin',
  Member: 'member',
  ReadOnly: 'readonly',
} as const;
export type OrgRole = (typeof OrgRole)[keyof typeof OrgRole];

/** Whether a stored value (e.g. a DynamoDB attribute) is one of the four roles. */
export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (Object.values(OrgRole) as string[]).includes(value);
}

/**
 * How a member came to be in the org. SCIM provisioning extends this later.
 *
 * Declared here rather than beside the membership row because the audit
 * envelope records it too, and two unions listing the same three values drift:
 * the day SCIM adds a fourth, one of them would still be missing it.
 */
export type OrgMembershipSource = 'signup' | 'conversion' | 'invitation';

export const ORG_NAME_MIN_LENGTH = 2;
export const ORG_NAME_MAX_LENGTH = 100;
export const ORG_NAME_PATTERN = /^[A-Za-z0-9 .-]+$/;
export const ORG_NAME_DISALLOWED_CHARS = /[^A-Za-z0-9 .-]/g;

export const OrgNameSchema = z
  .string()
  .trim()
  .min(ORG_NAME_MIN_LENGTH, `Organization name must be at least ${ORG_NAME_MIN_LENGTH} characters`)
  .max(ORG_NAME_MAX_LENGTH, `Organization name must be at most ${ORG_NAME_MAX_LENGTH} characters`)
  .regex(
    ORG_NAME_PATTERN,
    'Organization name can only contain letters, numbers, spaces, hyphens, and periods',
  );

/**
 * `PATCH /api/org` — renaming the organization, which is `org.rename` and
 * therefore its own endpoint rather than a field on the profile a member
 * updates about themselves.
 */
export const UpdateOrgSchema = z.object({ name: OrgNameSchema });

export type UpdateOrgRequest = z.infer<typeof UpdateOrgSchema>;

export interface UpdateOrgResponse {
  name: string;
}
