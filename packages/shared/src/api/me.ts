import { z } from 'zod';
import { OrgNameSchema } from './org.js';

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

export const UpdateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name cannot be empty')
      .max(PROFILE_NAME_MAX_LENGTH, `Name must be at most ${PROFILE_NAME_MAX_LENGTH} characters`)
      .optional(),
    email: z.string().trim().email('Please provide a valid email address').optional(),
    orgName: OrgNameSchema.optional(),
  })
  .refine((data) => data.name || data.email || data.orgName, {
    message: 'At least one field is required.',
  });

export type UpdateProfileRequest = z.infer<typeof UpdateProfileSchema>;

export interface UpdateProfileResponse {
  name?: string;
  email?: string;
  orgName?: string;
}

export interface RegenerateRecoveryCodeResponse {
  recoveryCode: string;
  message: string;
}

export interface StepUpRequiredResponse {
  error: 'step_up_required';
}
