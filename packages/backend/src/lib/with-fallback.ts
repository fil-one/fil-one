/**
 * Work whose failure must not become the caller's failure.
 *
 * For the side channels of a request — a notification, a count for the
 * response — where the failure is real but the request is not what failed.
 * Answering with an error there would send the caller into a retry that finds
 * the work already done and does it again, or answers as a no-op. So the error
 * is logged under `source` and `fallback` stands in for the result.
 */
export async function withFallback<T>(
  run: () => Promise<T>,
  fallback: T,
  context: { source: string; orgId: string },
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(`[${context.source}] Best-effort work did not finish; the request stands`, {
      orgId: context.orgId,
      error,
    });
    return fallback;
  }
}
