import { z } from 'zod';
import type { OrgRole } from './org.ts';
import type { Permission } from '../permissions.ts';

/** One row of `MeResponse.memberships` — an org the caller belongs to. */
export interface OrgMembershipSummary {
  orgId: string;
  orgName: string;
  role: OrgRole;
}

export interface MeResponse {
  orgId: string;
  orgName: string;
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
