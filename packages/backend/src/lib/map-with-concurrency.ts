/**
 * Map `items` through `fn`, running at most `limit` at a time.
 *
 * `Promise.all` over a bucket list would open one request per bucket at once,
 * which is how a 200-bucket tenant turns a page load into a burst the upstream
 * API rate-limits. Results come back in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError(`Concurrency limit must be at least 1, got ${limit}`);

  const results = new Array<R>(items.length);
  let next = 0;

  // Each worker pulls the next index until the list is exhausted, so one slow
  // item doesn't stall the others the way fixed-size batching would.
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
