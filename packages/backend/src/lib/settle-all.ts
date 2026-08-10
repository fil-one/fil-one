/**
 * Run every task, then throw a single AggregateError naming the ones that
 * failed (FIL-112). Used wherever a group of independent steps must ALL be
 * attempted before the caller gives up, so one vendor/region/AWS outage cannot
 * skip the rest — and, on a destructive path, cannot leave the half that never
 * ran silently undone.
 *
 * Its own leaf module so `account-deletion-start.ts` can use it from a
 * request-time handler without importing `account-deletion.ts`, which pulls in
 * the orchestrator registry and every vendor client the teardown needs.
 */
export async function settleAll(
  tasks: { name: string; run: () => Promise<void> }[],
  describeFailure: (failedNames: string) => string,
): Promise<void> {
  const results = await Promise.allSettled(
    // `Promise.resolve().then(run)` rather than `run()`: a SYNCHRONOUS throw
    // from one task would otherwise escape this `map` before `allSettled` is
    // ever reached, skipping every task after it — the exact failure mode this
    // helper exists to prevent.
    tasks.map(({ run }) => Promise.resolve().then(run)),
  );
  const failures = results
    .map((result, i) => ({ result, name: tasks[i].name }))
    .filter(
      (f): f is { result: PromiseRejectedResult; name: string } => f.result.status === 'rejected',
    );
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map((f) => f.result.reason),
    describeFailure(failures.map((f) => f.name).join(', ')),
  );
}
