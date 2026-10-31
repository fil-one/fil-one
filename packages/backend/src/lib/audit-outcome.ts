/** How far down an error's `cause` chain to look, as `errorHandlerMiddleware` does. */
const MAX_CAUSE_DEPTH = 10;

/** The names the AWS SDK and `AbortSignal` give a call cut off before it answered. */
const CUT_OFF_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/**
 * Socket failures that can strike after the request reached the storage
 * system. A refused or unresolved connection is absent: that request never
 * left, so it is a plain failure.
 */
const LOST_CONNECTION_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * Whether a storage call that threw may still have done its work: it was cut
 * off by the request deadline, for a handler that has one, aborted or timed out
 * on its own, or lost its connection after sending. The storage system can
 * finish a request after the caller stopped waiting, so neither `succeeded` nor
 * `failed` is known.
 *
 * The deadline counts only when its own reason is in the error's `cause` chain,
 * as `errorHandlerMiddleware` requires: a refusal that merely arrives after the
 * deadline fired still has a known outcome.
 *
 * A two-phase flow in that state leaves its completion unwritten. An intent
 * with no completion is how the audit log records a flow whose ending it never
 * saw, and the audit page shows it as "started".
 */
export function isOutcomeUnknown(error: unknown, deadline?: AbortSignal): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (deadline?.aborted && current === deadline.reason) return true;
    if (CUT_OFF_ERROR_NAMES.has(current.name)) return true;
    if (LOST_CONNECTION_CODES.has(getErrorCode(current))) return true;
    current = current.cause;
  }
  return false;
}

/** The Node system error code an error carries, such as `ECONNRESET`, or ''. */
function getErrorCode(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : '';
}
