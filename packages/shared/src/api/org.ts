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
 *
 * `'manual'` is the account's own creation of an additional org — distinct from
 * `'signup'`, which is the org that came with the account, so the two are
 * distinguishable in the audit log and the member roster.
 */
export type OrgMembershipSource = 'signup' | 'conversion' | 'invitation' | 'manual';

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
 * updates about themselves. `logoUrl`, when present, is a second, independent
 * change this same call may carry — `org.rename` still gates it, same as the
 * name — and must already point at a file `POST /api/org/logo-upload-url`
 * put there, same as `CreateOrgSchema` below.
 *
 * Either field may be sent alone, and the API refuses a body with neither. A
 * logo save sends no name: a name read when the file was picked can be stale
 * by the time the upload lands, and sending it would rename the org back.
 */
export const UpdateOrgSchema = z.object({
  name: OrgNameSchema.optional(),
  logoUrl: z.string().url().optional(),
});

export type UpdateOrgRequest = z.infer<typeof UpdateOrgSchema>;

export interface UpdateOrgResponse {
  name: string;
  logoUrl?: string;
}

/**
 * `POST /api/org` — an existing account creating an additional organization
 * (distinct from the one org.ts owns via signup). `logoUrl`, when present,
 * must already point at a file the presign step below put there — this
 * schema only ever persists the string, never touches storage.
 */
export const CreateOrgSchema = z.object({
  name: OrgNameSchema,
  logoUrl: z.string().url().optional(),
});

export type CreateOrgRequest = z.infer<typeof CreateOrgSchema>;

export interface CreateOrgResponse {
  orgId: string;
  orgName: string;
  logoUrl?: string;
  role: OrgRole;
}

/**
 * How many organizations one user may own before `POST /api/org` refuses to
 * create another. Counts Owner memberships only, so being invited into other
 * orgs never uses up the allowance.
 */
export const MAX_OWNED_ORGS = 10;

/** Accepted image types for an org logo upload, and the size ceiling for one. */
export const ORG_LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ORG_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const PresignOrgLogoSchema = z.object({
  contentType: z.enum(ORG_LOGO_CONTENT_TYPES),
});

export type PresignOrgLogoRequest = z.infer<typeof PresignOrgLogoSchema>;

export interface PresignOrgLogoResponse {
  /** Where the client POSTs the file, as a multipart form. */
  uploadUrl: string;
  /**
   * The form fields the POST must carry alongside the file, including the
   * policy and signature that bind the upload to this content type and to
   * `ORG_LOGO_MAX_BYTES`. The client sends these unchanged; only `file` (last)
   * is theirs to append.
   */
  fields: Record<string, string>;
  /** The public URL to read it back from afterward, and what gets sent to `CreateOrgRequest.logoUrl`. */
  logoUrl: string;
}
