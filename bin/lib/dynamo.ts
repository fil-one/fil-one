// DynamoDB reading shared by the bin/ scripts: paging a Scan to the end, and
// decoding the rows it returns.

import type {
  AttributeValue,
  DynamoDBClient,
  ScanCommandInput,
  TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import {
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Every item a Scan matches, paged to the end.
 *
 * A Scan returns at most 1 MB per call whatever the filter matches, so a caller
 * that reads `Items` once sees a prefix of the table and no error. The
 * `ExclusiveStartKey` is supplied here; a caller passing one of its own is
 * overridden.
 */
export async function* scanAll(
  client: DynamoDBClient,
  input: ScanCommandInput,
): AsyncGenerator<Record<string, AttributeValue>> {
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await client.send(new ScanCommand({ ...input, ExclusiveStartKey: lastKey }));
    lastKey = result.LastEvaluatedKey;
    yield* result.Items ?? [];
  } while (lastKey);
}

/**
 * A stored item as the plain object its `ProjectionExpression` asked for.
 *
 * Typed as a partial of the projection so a reader names its attributes once,
 * the same idiom as `decodeRow` in packages/backend/src/lib/org-membership.ts.
 * The cast describes what the writer intends, not what the row holds, so string
 * attributes are still read through {@link text} before use.
 */
export function decodeRow<T>(item: Record<string, AttributeValue>): Partial<T> {
  return unmarshall(item) as Partial<T>;
}

/** A decoded attribute when it really is a non-empty string; anything else reads as absent. */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * What a cancelled transaction means for the run.
 *
 * `TransactWriteItems` reports one reason per item, and only a failed condition
 * says anything about the data: it is the row's own state answering. Throttling
 * and a transaction conflict say the write did not get its turn, so it is
 * retried; anything else is a bug in the request. Filing either as a conflict
 * for manual review would put a retryable failure on an operator's list as if
 * the row needed a decision.
 */
export type CancellationDisposition = 'condition-failed' | 'retry' | 'abort';

/** DynamoDB cancellation codes that mean "try again", not "this row said no". */
const RETRYABLE_CANCELLATION_CODES = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
  'RequestLimitExceeded',
]);

export function classifyCancellation(codes: readonly string[]): CancellationDisposition {
  if (codes.includes('ConditionalCheckFailed')) return 'condition-failed';

  // 'None' is what DynamoDB reports for the items that were fine.
  const blamed = codes.filter((code) => code !== 'None' && code !== '');
  if (blamed.length > 0 && blamed.every((code) => RETRYABLE_CANCELLATION_CODES.has(code))) {
    return 'retry';
  }
  return 'abort';
}

/** Attempts for a transaction cancelled by throttling or a transaction conflict. */
const MAX_TRANSACTION_ATTEMPTS = 4;

/** First backoff between those attempts; doubled each time. */
const RETRY_BASE_MS = 200;

/**
 * Send one transaction, retrying the cancellations that mean "try again".
 *
 * Returns the cancellation codes when a condition failed — the one outcome the
 * caller has to interpret, because only it says something about the data.
 * Success returns undefined, and everything else throws: a run that cannot do
 * the work stops rather than counting the row as handled.
 */
export async function transactWithRetry(
  client: DynamoDBClient,
  items: TransactWriteItem[],
  label: string,
): Promise<string[] | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return undefined;
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) throw err;

      const codes = (err.CancellationReasons ?? []).map((reason) => reason.Code ?? '');
      const disposition = classifyCancellation(codes);
      if (disposition === 'condition-failed') return codes;

      if (disposition === 'abort' || attempt >= MAX_TRANSACTION_ATTEMPTS) {
        console.log(
          `  FAILED ${label} — transaction cancelled (${codes.join(',')}) after ${attempt} attempt(s); stopping the run`,
        );
        throw err;
      }

      const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.log(
        `  RETRY ${label} — cancelled (${codes.join(',')}), attempt ${attempt + 1} of ${MAX_TRANSACTION_ATTEMPTS} in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
}
