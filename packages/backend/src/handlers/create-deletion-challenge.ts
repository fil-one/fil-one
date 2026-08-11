import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type {
  DeletionChallengeResponse,
  DeletionRateLimitedResponse,
  ErrorResponse,
} from '@filone/shared';
import { ApiErrorCode } from '@filone/shared';
import { invokeAccountDeletionWorker } from '../lib/account-deletion-invoke.js';
import { createDeletionChallenge } from '../lib/deletion-challenge.js';
import { claimDeletionRerun, readDeletionRecord } from '../lib/deletion-record.js';
import { sendDeletionCodeEmail } from '../lib/deletion-email.js';
import { isOrgAdmin } from '../lib/org-membership.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfaIfEnrolled } from '../middleware/require-mfa.js';

/**
 * Issue the email verification challenge for account deletion (FIL-112). No
 * subscription guard — grace/canceled users must still be able to delete.
 */
export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, userId, email } = getUserInfo(event);
  if (!email) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'No email on the authenticated session' })
      .build();
  }

  // Same admin gate as the confirm endpoint — a non-admin must not be able to
  // mint a valid org-deletion code for themselves, nor burn the org's send budget.
  if (!(await isOrgAdmin(orgId, userId))) {
    return new ResponseBuilder()
      .status(403)
      .body<ErrorResponse>({ message: 'Only an organization admin can delete the account' })
      .build();
  }

  // Already confirmed — idempotent success, no new code issued or emailed.
  //
  // Re-invoke the (idempotent) teardown worker on the way out, throttled. The
  // window this covers is NARROW: the never-fenced one. Once
  // `applyDeletionGuards` has landed, middleware/auth.ts answers 410 for every
  // member session, so no user can reach this route at all — a teardown that
  // stalled AFTER fencing is the deletion orchestrator's job (FIL-112), never
  // this route's. What it does rescue is a deletion that was never scheduled at
  // all: a failed worker invoke,
  // or a crash between consuming the challenge code and invoking. The confirm
  // handler needs a challenge code and this endpoint refuses to mint another
  // while a DELETION record exists, so nothing else reruns it.
  //
  // This reruns a teardown; it does not unwedge an org. `deleting = true`
  // stays on while a DELETION record exists, so an org whose teardown keeps
  // failing stays fenced against access-key and RAG-key creation, RAG toggling
  // and tenant re-activation — which is the intent while a deletion is in
  // flight. The supported unwedge is `clearOrgDeletionGuard`, driven by the
  // deletion orchestrator for orgs carrying the flag with NO deletion record
  // (jobs/account-deletion-orchestrator.ts).
  if (await readDeletionRecord(orgId)) {
    await rerunTeardown(orgId);
    return new ResponseBuilder()
      .status(200)
      .body<DeletionChallengeResponse>({ outcome: 'deletion_in_progress' })
      .build();
  }

  const challenge = await createDeletionChallenge(orgId, userId);
  if (challenge.outcome === 'rate_limited') {
    return new ResponseBuilder()
      .status(429)
      .body<DeletionRateLimitedResponse>({
        message: 'Too many verification codes requested. Please wait before retrying.',
        code: ApiErrorCode.DELETION_RATE_LIMITED,
        resendAvailableAt: challenge.resendAvailableAt,
      })
      .build();
  }

  const orgProfile = await getOrgProfile(orgId);
  await sendDeletionCodeEmail({
    to: email,
    orgName: orgProfile?.name?.S ?? 'your organization',
    code: challenge.code,
  });

  return new ResponseBuilder()
    .status(200)
    .body<DeletionChallengeResponse>({
      outcome: 'challenge_created',
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
    })
    .build();
}

/**
 * Best-effort, throttled rerun of the teardown worker. Never fails the
 * response: `deletion_in_progress` is a documented SUCCESS outcome (it is typed
 * as one on {@link DeletionChallengeResponse}, and the website renders any 500
 * as a generic server error rather than "account deletion is already in
 * progress"), so a client that cannot reach Lambda must still be told the truth
 * about its account. The failure is logged instead, and the orchestrator reruns
 * teardowns that need it.
 *
 * Throttled because it short-circuits ahead of the code endpoint's own 5/hr
 * limiter: without a cooldown of its own, every click Event-invokes another
 * 900s / 1024MB worker.
 *
 * The claim is taken BEFORE the invoke, so a failed invoke — or an SDK-internal
 * retry of the claim write, whose second attempt sees its own `lastAttemptAt`
 * and reads as "cooldown live" — burns the 5-minute window with no worker
 * scheduled. That is the deliberate trade: claiming only after a SUCCESSFUL
 * invoke would let concurrent clicks fan out invokes unthrottled, which is what
 * the cooldown exists to prevent. It self-heals — the user may retry after the
 * cooldown, and the orchestrator reruns teardowns that stalled regardless.
 */
async function rerunTeardown(orgId: string): Promise<void> {
  try {
    if (!(await claimDeletionRerun(orgId))) return;
    await invokeAccountDeletionWorker(orgId);
  } catch (err) {
    console.error('[create-deletion-challenge] Teardown rerun failed', { orgId, error: err });
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(requireMfaIfEnrolled())
  .use(errorHandlerMiddleware());
