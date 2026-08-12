import { z } from 'zod';

/**
 * Account deletion: an org admin requests a code, then confirms with it. The
 * code is emailed to the requester's session address and is the second factor
 * for users with no MFA enrollment, so it never appears in a URL or a log line.
 */

export const DELETION_CODE_LENGTH = 6;

/** How long an issued code stays spendable. The row itself outlives this. */
export const DELETION_CODE_TTL_MINUTES = 15;

export const DeletionCodeSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^\\d{${DELETION_CODE_LENGTH}}$`),
    `Verification code must be ${DELETION_CODE_LENGTH} digits`,
  );

export const DeleteAccountSchema = z.object({
  code: DeletionCodeSchema,
  // Typed-to-confirm. Not OrgNameSchema: an org whose stored name predates the
  // current format rules must still be typeable. The server compares it to the
  // actual name.
  orgName: z.string().trim().min(1, 'Organization name is required'),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountSchema>;

/**
 * `deletion_in_progress` is returned instead of issuing a code when the org has
 * already confirmed — the request is a no-op, not an error.
 */
export type RequestAccountDeletionResponse =
  | { outcome: 'challenge_created'; expiresAt: string; resendAvailableAt: string }
  | { outcome: 'deletion_in_progress' };

export interface ConfirmAccountDeletionResponse {
  message: string;
}
