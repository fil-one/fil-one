/** How far down an error's `cause` chain to look, as `errorHandlerMiddleware` does. */
const MAX_CAUSE_DEPTH = 10;

/**
 * Whether a storage call that threw may still have done its work: the request
 * deadline fired, for a handler that has one, or the call was aborted or timed
 * out on its own. The storage system can finish a request after the caller
 * stopped waiting, so neither `succeeded` nor `failed` is known.
 *
 * A two-phase flow in that state leaves its completion unwritten. An intent
 * with no completion is how the audit log records a flow whose ending it never
 * saw, and the audit page shows it as "started".
 */
export function isOutcomeUnknown(error: unknown, deadline?: AbortSignal): boolean {
  if (deadline?.aborted) return true;
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current.name === 'AbortError' || current.name === 'TimeoutError') return true;
    current = current.cause;
  }
  return false;
}
