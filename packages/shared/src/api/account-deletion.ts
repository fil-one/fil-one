import { z } from 'zod';
import type { ErrorResponse } from './coreInterfaces.js';

export const DELETION_CODE_LENGTH = 6;

/** How long a deletion verification code stays valid after being issued. */
export const DELETION_CODE_TTL_MINUTES = 15;

export const DeleteAccountSchema = z.object({
  code: z
    .string()
    .regex(
      new RegExp(`^\\d{${DELETION_CODE_LENGTH}}$`),
      `Enter the ${DELETION_CODE_LENGTH}-digit verification code`,
    ),
  /** Typed-to-confirm org name; re-validated server-side against the org profile. */
  orgName: z.string().min(1, 'Organization name is required'),
});

export type DeleteAccountRequest = z.infer<typeof DeleteAccountSchema>;

export interface DeleteAccountResponse {
  message: string;
}

export type DeletionChallengeResponse =
  | {
      outcome: 'challenge_created';
      /** ISO timestamp — when the emailed code expires. */
      expiresAt: string;
      /** ISO timestamp — earliest moment another code may be requested. */
      resendAvailableAt: string;
    }
  /** A deletion is already confirmed and running — no new code was issued. */
  | { outcome: 'deletion_in_progress' };

/**
 * 429 from the challenge endpoint. `resendAvailableAt` is the earliest moment
 * another code may be requested — the cooldown's end, or the send window's end
 * once the budget is spent.
 */
export interface DeletionRateLimitedResponse extends ErrorResponse {
  resendAvailableAt: string;
}
