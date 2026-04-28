import { z } from 'zod';
import { OrgNameSchema } from './org.js';

export interface MeResponse {
  orgId: string;
  orgName: string;
  orgConfirmed: boolean;
  emailVerified: boolean;
  suggestedOrgName?: string;
  email?: string;
  orgSetupComplete: boolean;
  name?: string;
  connectionType?: string;
  mfaEnrollments: MfaEnrollment[];
  picture?: string;
}

export interface MfaEnrollment {
  id: string;
  type: 'authenticator' | 'webauthn-roaming' | 'webauthn-platform' | 'email';
  name?: string;
  createdAt: string;
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

export interface ConfirmOrgRequest {
  orgName: string;
}

export interface ConfirmOrgResponse {
  orgId: string;
  orgName: string;
}
