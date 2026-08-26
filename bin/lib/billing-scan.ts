// What the two billing re-key runs ask BillingTable for: the filter each pass
// matches, the attributes it reads back, and the consistency it reads at.
//
// Held here rather than inline in the runners for the reason ./billing-rekey.ts
// holds the write items: a scan input is a value, so what a run asks for is
// testable without a table. ./billing-rekey.ts is at the max-lines cap, so these
// live beside it rather than in it.
//
// The runners are ./backfill-billing-to-org.ts and ./revert-billing-backfill.ts;
// the procedure is docs/BillingRekeyRunbook.md.

import type { ScanCommandInput } from '@aws-sdk/client-dynamodb';

import { BillingKeys, REKEY_ATTRIBUTES } from './billing-rekey.ts';

/**
 * Every subscription row, whichever key shape it carries.
 *
 * No `ProjectionExpression`: the copy carries every attribute the source holds,
 * so the whole row is what the run needs. The filter is the sort key alone —
 * webhook idempotency rows and usage reports live under other sort keys and are
 * never matched.
 *
 * ConsistentRead: this scan is what `--verify` gates the flip on, and an
 * eventually-consistent miss reads as "no legacy row for that org" — the exact
 * shape of the failure the gate exists to catch.
 */
export function buildBackfillScanInput(tableName: string): ScanCommandInput {
  return {
    TableName: tableName,
    FilterExpression: 'sk = :subscription',
    ExpressionAttributeValues: { ':subscription': { S: BillingKeys.subscriptionSk() } },
    ConsistentRead: true,
  };
}

/**
 * Every org subscription row, carrying the key and the provenance the revert's
 * delete conditions on.
 *
 * The projection names `rekeyedFrom` rather than reading whole rows, so the scan
 * returns only what the revert decides from: a row with that attribute is a copy
 * this backfill wrote and can be deleted, a row without it is live billing state
 * the application wrote and is counted for the operator instead.
 *
 * ConsistentRead: an eventually-consistent page can omit a copy a backfill
 * committed shortly before this run took the lock. That row never reaches the
 * plan, so it is never deleted, and the run still prints `Done.` — a revert
 * reporting success over the rows it left behind. The backfill's scan reads
 * consistently for the same kind of reason.
 */
export function buildRevertScanInput(tableName: string): ScanCommandInput {
  return {
    TableName: tableName,
    FilterExpression: 'sk = :subscription AND begins_with(pk, :orgPrefix)',
    ProjectionExpression: `pk, ${REKEY_ATTRIBUTES.from}`,
    ExpressionAttributeValues: {
      ':subscription': { S: BillingKeys.subscriptionSk() },
      ':orgPrefix': { S: BillingKeys.orgPkPrefix() },
    },
    ConsistentRead: true,
  };
}
