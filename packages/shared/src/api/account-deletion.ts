import { z } from 'zod';

export const DELETION_CODE_LENGTH = 6;

/** How long a deletion verification code stays valid after being issued. */
export const DELETION_CODE_TTL_MINUTES = 15;

export const DeleteAccountSchema = z.object({
  code: z
    .string()
    .regex(new RegExp(`^\\d{${DELETION_CODE_LENGTH}}$`), 'Enter the 6-digit verification code'),
  /**
   * The org name the user typed to confirm. Validated server-side against the
   * stored org profile name — the client-side gating alone is not trusted.
   */
  orgName: z.string().min(1, 'Organization name is required'),
});

export type DeleteAccountRequest = z.infer<typeof DeleteAccountSchema>;

export interface DeleteAccountResponse {
  message: string;
}

export interface DeletionChallengeResponse {
  /** ISO timestamp — when the emailed code expires. */
  expiresAt: string;
  /** ISO timestamp — earliest moment another code may be requested. */
  resendAvailableAt: string;
}
