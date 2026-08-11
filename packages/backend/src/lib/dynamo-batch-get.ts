import { BatchGetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import pRetry, { type Options as RetryOptions } from 'p-retry';
import { getDynamoClient } from './ddb-client.js';

const dynamo = getDynamoClient();

/** BatchGetItem hard limit; the 16 MB per-response cap surfaces as UnprocessedKeys. */
const MAX_KEYS_PER_BATCH = 100;

// UnprocessedKeys means DynamoDB is shedding load — retry with exponential
// backoff + jitter instead of hammering it in a tight loop, and give up after
// ~5 attempts. The thrown error propagates to the caller so its own retry
// (Lambda async retry / the deletion reconciler) re-drives the read.
const BATCH_GET_RETRY: RetryOptions = { retries: 4, minTimeout: 100, randomize: true };

/**
 * BatchGetItem reads in 100-key chunks, retrying only the UnprocessedKeys of
 * each chunk with capped exponential backoff. `retry` is injectable so tests
 * keep timeouts tiny.
 *
 * Items come back unordered and missing keys are simply absent, so callers
 * must index the result by pk rather than zip it against the input.
 *
 * @param opts.consistent read at strong consistency (double the RCUs). Set it
 *   where a row missing from the result is acted on irreversibly; leave it off
 *   where a stale read only costs another pass.
 */
export async function batchGet(
  tableName: string,
  keys: { pk: string; sk: string }[],
  opts: { consistent?: boolean; retry?: RetryOptions } = {},
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_BATCH) {
    let pending: Record<string, AttributeValue>[] = keys
      .slice(i, i + MAX_KEYS_PER_BATCH)
      .map((key) => marshall({ pk: key.pk, sk: key.sk }));
    await pRetry(async () => {
      const result = await dynamo.send(
        new BatchGetItemCommand({
          RequestItems: {
            [tableName]: { Keys: pending, ...(opts.consistent ? { ConsistentRead: true } : {}) },
          },
        }),
      );
      items.push(...(result.Responses?.[tableName] ?? []).map((item) => unmarshall(item)));
      const unprocessed = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
      if (unprocessed.length > 0) {
        // Narrow the next attempt to what's left, then let pRetry back off.
        pending = unprocessed;
        throw new Error(
          `BatchGetItem left ${unprocessed.length} unprocessed key(s) for ${tableName}`,
        );
      }
    }, opts.retry ?? BATCH_GET_RETRY);
  }
  return items;
}
