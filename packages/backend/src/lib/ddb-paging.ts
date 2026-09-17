import type { AttributeValue } from '@aws-sdk/client-dynamodb';

/** Where a paged read resumes, as DynamoDB hands it back. */
export type DynamoCursor = Record<string, AttributeValue> | undefined;

type DynamoPage = {
  Items?: Record<string, AttributeValue>[];
  LastEvaluatedKey?: DynamoCursor;
};

/**
 * Drain a Query or Scan and return everything it matched.
 *
 * DynamoDB caps a read at 1MB of items examined and applies a
 * `FilterExpression` afterwards, so a single call can match nothing and still
 * hand back a `LastEvaluatedKey`. A caller that stops at the first response
 * therefore silently loses rows, which is why this loop exists rather than
 * being written out at each call site.
 *
 * For reads whose whole result is wanted. A paged read that stops once it has
 * enough — the audit viewer's page — needs its own loop, because this one has
 * no way to say "stop here, and here is where to resume".
 */
export async function collectPages(
  send: (cursor: DynamoCursor) => Promise<DynamoPage>,
): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let cursor: DynamoCursor;
  do {
    const page = await send(cursor);
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}
