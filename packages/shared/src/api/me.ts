import { z } from 'zod';
import type { OrgRole } from './org.ts';
import type { Permission } from '../permissions.ts';

/** One row of `MeResponse.memberships` — an org the caller belongs to. */
export interface OrgMembershipSummary {
  orgId: string;
  orgName: string;
  /** URL-safe identifier for this org, unique across the platform — what routes are scoped by. */
  slug: string;
  role: OrgRole;
  /** Uploaded logo, if any. Absent falls back to a generated monogram, same as `MeResponse.picture` does for the user. */
  logoUrl?: string;
  /** When this membership began. Absent for a row that predates the field. */
  joinedAt?: string;
}

export interface MeResponse {
  orgId: string;
  orgName: string;
  /** URL-safe identifier for the active org — what routes are scoped by. */
  slug: string;
  /** The active org's uploaded logo, if any. Falls back to a generated monogram. */
  logoUrl?: string;
  emailVerified: boolean;
  email?: string;
  name?: string;
  connectionType?: string;
  mfaEnrollments: MfaEnrollment[];
  passkeys?: PasskeyEnrollment[];
  picture?: string;
  /**
   * Whether the user may access the RAG feature. Computed server-side from the
   * verified email via the shared gate predicate (Foundation domain OR runtime
   * allowlist) so the frontend stays consistent without a second lookup.
   */
  ragAccess: boolean;
  /** The caller's FilOne user id — the subject of every membership row. */
  userId?: string;
  /** The caller's role in {@link MeResponse.orgId}. */
  role?: OrgRole;
  /**
   * The permissions {@link MeResponse.role} carries, computed server-side like
   * {@link MeResponse.ragAccess} so the console gates rendering off the same
   * table the server enforces. The server remains the enforcement point; the UI
   * only hides what would be refused.
   */
  permissions?: readonly Permission[];
  /** Every org the caller belongs to, for the org switcher. */
  memberships?: OrgMembershipSummary[];
  /**
   * Whether anyone has ever named this organization, as opposed to accepting the
   * name derived for them at signup. False only for an organization created
   * after this field shipped and never renamed since, which is what sends a new
   * account through the naming step.
   *
   * Absent on the stored row reads as true, so every organization that predates
   * the field is left alone rather than sent back through onboarding. Optional
   * here for the same reason: a payload that omits it is a confirmed org, and
   * only an explicit `false` sends the caller through the naming step.
   */
  nameConfirmed?: boolean;
  /**
   * Whether the organizations beta is switched on for this caller — their own
   * allowlist row, or {@link MeResponse.orgId}'s. Computed server-side like
   * {@link MeResponse.ragAccess}, from the same predicate the invitation
   * endpoint refuses on, so the console hides a members surface the server
   * would then refuse to populate rather than discovering the refusal.
   *
   * It answers for the active org only. Switching orgs re-reads `/me`, which is
   * what makes the answer follow the org rather than the session.
   */
  orgsBeta: boolean;
}

export interface MfaEnrollment {
  id: string;
  type: 'authenticator' | 'webauthn-roaming' | 'webauthn-platform';
  name?: string;
  createdAt?: string;
}

export const PASSKEY_PER_USER_LIMIT = 20;

export interface PasskeyEnrollment {
  id: string;
  name?: string;
  createdAt?: string;
}

export const PROFILE_NAME_MAX_LENGTH = 200;

/**
 * `PATCH /api/me/profile` — the caller's own account, and nothing else. The
 * organization's name left this body for `PATCH /api/org`: renaming the org is
 * `org.rename`, which most members do not hold, and a route that mixes a
 * self-service field with a privileged one has no single requirement to
 * declare.
 */
export const UpdateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name cannot be empty')
      .max(PROFILE_NAME_MAX_LENGTH, `Name must be at most ${PROFILE_NAME_MAX_LENGTH} characters`)
      .optional(),
    email: z.string().trim().email('Please provide a valid email address').optional(),
  })
  .refine((data) => data.name || data.email, {
    message: 'At least one field is required.',
  });

export type UpdateProfileRequest = z.infer<typeof UpdateProfileSchema>;

export interface UpdateProfileResponse {
  name?: string;
  email?: string;
}

export interface RegenerateRecoveryCodeResponse {
  recoveryCode: string;
  message: string;
}

export interface StepUpRequiredResponse {
  error: 'step_up_required';
}
