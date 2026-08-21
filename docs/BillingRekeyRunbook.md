# Billing Re-key Runbook

Moving the subscription row from `CUSTOMER#{userId}/SUBSCRIPTION` to
`ORG#{orgId}/SUBSCRIPTION` in `BillingTable` (IAM M1, FIL-1013). One manual run
per stage, between two merges: the dual-write that keeps both keys current is
already deployed, and the flip PR that removes the `CUSTOMER#` fallback merges
only after this run is verified.

- Script: `bin/backfill-billing-to-org.ts`
- Revert: `bin/revert-billing-backfill.ts`
- Design: `docs/architectural-decisions/2026-08-organizations-roles-m1.md` §5

Billing was keyed per user while every other resource was keyed per org, so the
moment an org had a second member that member had no billing row and the
subscription guard locked them out of the product. The re-key makes one org, one
subscription an invariant instead of a warning log.

Per org, one transaction writes `ORG#{orgId}/SUBSCRIPTION` — every attribute of
the legacy row, with `orgId` and `userId` written from the key rather than copied,
plus `rekeyedFrom`, `rekeyedAt`, and `rekeySourceUpdatedAt` — and asserts in the
same transaction that the legacy row's `updatedAt` is still what the copy claims
to carry.

**Nothing is deleted.** The legacy row stays after its copy. The flip PR reads
only the org key, and the `CUSTOMER#` rows go in a dated cleanup step afterwards
(below), once the flip has been running without incident.

Why the copy is conditional: Stripe webhooks mutate these rows continuously, so a
twin copied today is stale tomorrow. The condition is what makes a copy
meaningful — a run that loses it leaves that org for the next run, which re-reads
it. A re-copy asserts both halves are still what the run read: the org row is
still a copy of this source, and its `updatedAt` is still the one that lost the
comparison. A `Put` replaces the whole item, so a webhook write landing inside
that window would be erased rather than merged.

Which orgs get re-copied is decided by **which row is newer**, the legacy row's
`updatedAt` against the org row's. `rekeySourceUpdatedAt` records what the copy
was made from and is part of the audit trail, not the signal: it stays frozen
while every ordinary dual-write moves the source, so comparing the two would
re-flag every account the run already finished and `--verify` would never pass on
a live stage.

An org row that is **ahead** of its legacy row is not a problem to fix. Every
reader prefers the org row while both exist and the flip deletes the legacy one,
so the org half being newer never serves stale data. It is counted and skipped.
The reverse — a legacy row ahead of an org row the application wrote — is
reported as an anomaly, because the flip is about to delete the only row holding
that state, and reconciling it is a decision for a person.

## Preconditions

1. **The dual-write is deployed to the target stage.** Every read must already
   prefer `ORG#{orgId}` with the `CUSTOMER#` fallback, and every writer must
   already write both keys (the `iam-m1/07-billing-dual-write` PR). Merges to
   `main` auto-deploy, so confirm the stage is running a commit that contains it.
   Copying before that PR deploys produces twins that go stale the next time
   Stripe writes.
2. **The flip is not merged.** `readSubscription`'s `CUSTOMER#` fallback and the
   second write in every writer must still be there. Until this run has written
   the org rows, that fallback is the only thing serving every pre-existing
   account; merging the flip first takes their subscription away.
3. Run from the repository root.
4. Have the stage's AWS credentials in your environment (`AWS_PROFILE`). The
   script talks to DynamoDB directly with them; nothing is routed through
   `sst shell`, which cannot evaluate providers against production.

**Run one script at a time.** The backfill and the revert move the same rows in
opposite directions, so an `--execute` run of either takes a lock row
(`BILLING_REKEY#LOCK` / `LOCK`) in `BillingTable` and holds it for the whole write
phase. A second run stops and names the one already running. The org conversion
holds a separate lock in `OrgTable`, so the two migrations never queue behind each
other. If a run is killed outright, drop the lock it left behind:

```sh
./bin/backfill-billing-to-org.ts --stage production --force-unlock
```

## Naming the stage

`--stage <name>` is required and has no default. The script reads the physical
table name out of `sst state export --stage <name>`, then asserts it carries
`filone-<stage>-` before it reads anything — the flag alone is not trusted.
Staging is AWS account 654654381893, production 811430801166.

## Dry run

Dry run is the default; the script writes only with `--execute`.

```sh
./bin/backfill-billing-to-org.ts --stage production 2>&1 | tee billing-dry-run.log
```

The report names the stage and the table, then prints the plan (counts below are
illustrative):

```
DRY-RUN — Copying subscription rows to their org key (stage="production", region=us-east-2)
  BillingTable: filone-production-BillingTableTable

Matched in BillingTable: 843 SUBSCRIPTION rows — 812 legacy CUSTOMER# rows, 31 ORG# rows (0 of them copies)

Orgs scanned: 810
  Copy (CUSTOMER# row -> ORG# row):                        775
  Re-copy (the source changed since the last copy):        0
  Already copied by an earlier run (skipped):              0
  Already keyed to the org by the application (skipped):   31
  Superseded legacy rows left in place:                    2
  Anomalies (manual disposition):                          2

Legacy rows with no orgId (3) — never copied, for manual disposition:
  CUSTOMER#8f3c…
  CUSTOMER#1a2b…
  CUSTOMER#c4d5…

Anomalies — dispose of these before executing:
  [collision] ORG#7e9f…  2 legacy rows name this org with different subscriptions: CUSTOMER#a1b2… (sub_1JkL…), CUSTOMER#d3e4… (sub_9MnO…)
  [collision] ORG#2c8a…  2 legacy rows name this org with different subscriptions: CUSTOMER#f5g6… (sub_4PqR…), CUSTOMER#h7i8… (no subscriptionId)

Writes 775 org rows and deletes nothing. Every CUSTOMER# row stays until the dated cleanup step.
```

Three things in that report need reading before you execute.

**Already keyed to the org by the application.** Since the dual-write deployed, a
new signup's trial and a first payment-method setup write the org key directly.
Those rows are live billing state and are never overwritten — the script tells
them apart by the absence of `rekeyedFrom`.

**Superseded legacy rows.** Several `CUSTOMER#` rows can name one org, from a user
who re-subscribed after cancelling. When they agree on `subscriptionId` they
describe the same Stripe subscription, so the newest `updatedAt` is copied and the
rest are counted here and left in place.

**Legacy rows with no orgId.** There is no org to key them to and nothing to infer
one from. Every lifecycle job already skips them, which is why they have gone
unnoticed — the flip is what makes that permanent, so each one is dispositioned by
name at the verify step.

### Collisions halt the run

Rows that name one org and _disagree_ about the subscription are a decision this
script cannot make. The ADR resolves them in favour of the row whose
`subscriptionId` is live in Stripe, and nothing in `bin/` can ask Stripe. The run
stops in both modes — before any write, before any per-org line — and lists them:

```
HALTED: 2 orgs are claimed by legacy rows naming different subscriptions.
Check each subscriptionId in the Stripe dashboard, then name the live row per org:
  --resolve-collisions ORG#<orgId>=CUSTOMER#<userId>,…
See docs/BillingRekeyRunbook.md. Nothing was written.
```

**The operator's Stripe check, per collided org:**

1. Open each `subscriptionId` from the report in the Stripe dashboard
   (Billing → Subscriptions, or search the id directly).
2. Exactly one should be in a live state — `active`, `trialing`, `past_due`, or
   `unpaid`. That row's `CUSTOMER#` pk is the winner.
3. If **more than one is live**, stop and escalate: the org has two subscriptions
   billing the same tenant, and one has to be cancelled in Stripe before the
   re-key can name a single winner. Do not pick one here — the losing
   subscription keeps metering.
4. If **none is live** (all `canceled` or `incomplete_expired`), the newest
   `updatedAt` is the right answer; it is the row the guard has been serving.
5. Record what you found for each org — the dashboard state is not in any log the
   script writes, and it is the reasoning behind the flag.

Then name the winners. Both the prefixed forms the report prints and bare ids are
accepted, so a line can be copied out of the output:

```sh
./bin/backfill-billing-to-org.ts --stage production \
  --resolve-collisions ORG#7e9f…=CUSTOMER#a1b2…,ORG#2c8a…=CUSTOMER#f5g6… \
  2>&1 | tee billing-dry-run-resolved.log
```

Each entry is one decision about one org, so the list is enumerated by hand —
there is no "resolve all". Re-run the dry run with the flag until the anomaly list
is empty.

## Execute

```sh
./bin/backfill-billing-to-org.ts --stage production \
  --resolve-collisions ORG#7e9f…=CUSTOMER#a1b2…,ORG#2c8a…=CUSTOMER#f5g6… \
  --execute 2>&1 | tee billing-backfill.log
```

There is no PITR or backup on this table, so the log is the only record of what
changed — capture both streams (`2>&1`) and keep `billing-backfill.log`.

The run prints the same plan first, then one line per org after its write, then a
tally. Each per-org line carries the outcome that actually happened: `COPIED`,
`RE-COPIED`, `SKIPPED`, `RACED`, `RETRY`, or `FAILED`.

```
Copied (first time):                         740
Re-copied (the legacy row was newer):        33
Skipped (no longer needed a copy):           0
Raced (the rows moved; next run retries):    2
Already in sync at scan time (not planned):  91
Anomalies (untouched):                       0
Legacy CUSTOMER# rows deleted:               0 (by design)

Planned copies 775 = 773 written + 0 skipped-since + 2 raced.
```

Every org is re-read consistently and re-classified immediately before its write,
so the log line names the source `updatedAt` the write actually carried rather
than what the scan saw minutes earlier.

The closing line is an identity: every org the plan contained ends in exactly one
of written, skipped-since, or raced. Orgs already in sync when the table was
scanned were never planned, so they are reported separately rather than folded
into the skipped count.

`RACED` counts orgs whose transaction was cancelled by a condition — a Stripe
webhook moved the legacy row, or another writer created the org row first. Nothing
is wrong with those orgs; they were simply in flight. **The script exits non-zero
when any org raced. Re-run `--execute` until that count is zero**, then verify. A
cancellation caused by throttling or a transaction conflict is retried with
backoff and then stops the run; it is never counted as a race.

## Verify

```sh
./bin/backfill-billing-to-org.ts --stage production --verify \
  --accept-orgless CUSTOMER#8f3c…,CUSTOMER#1a2b…,CUSTOMER#c4d5… \
  2>&1 | tee billing-verify.log
```

`--verify` re-reads the table, re-derives the same classification the backfill
uses, and prints one line per check. It writes nothing and exits non-zero on any
`FAIL`.

```
PASS  No org still has a row to copy
        0 orgs would be copied for the first time, 0 re-copied after a source change
PASS  Every legacy row that names an org has an org twin
        812 legacy rows, of which 3 name no org; 0 orgs have a legacy row and no twin
PASS  Every org twin says what its source says
        775 copied org rows; 0 disagree with their source
PASS  Every org row’s orgId attribute matches its key
        806 org rows; 0 carry an orgId that is not their own
PASS  No org is claimed by two subscriptions
        0 orgs are anomalies of 810 scanned
PASS  Every legacy row with no orgId has been dispositioned
        3 legacy rows carry no orgId; 3 accepted, 0 undispositioned
        accepted by --accept-orgless (3):
          CUSTOMER#8f3c…
          CUSTOMER#1a2b…
          CUSTOMER#c4d5…

VERIFY: PASS
```

The faithfulness check compares the billing state — `subscriptionId`,
`stripeCustomerId`, `subscriptionStatus`, the period and trial and grace
timestamps, `updatedAt` — and names the attribute and both values when a twin
disagrees. A stale `subscriptionStatus` is the difference between a served
customer and a locked one. The cached Stripe price is deliberately not compared:
the read path refreshes it whenever the price id changes.

Rows the application wrote are exempt from that check. They have no legacy source
to be faithful to, and their legacy twin was written beside them by the same
dual-write.

**The gate for the flip PR is `VERIFY: PASS` with zero undispositioned rows.**
Without the `--accept-orgless` flag the same stage reports:

```
FAIL  Every legacy row with no orgId has been dispositioned
        3 legacy rows carry no orgId; 0 accepted, 3 undispositioned
          CUSTOMER#8f3c…
          CUSTOMER#1a2b…
          CUSTOMER#c4d5…

VERIFY: FAIL (1 checks)
```

### Dispositioning a row with no orgId

Each one is an account whose billing row predates the `orgId` attribute, or a
Stripe customer created outside the app.

**"Its metadata names no org" does not mean "nothing is behind it."** The
subscription guard serves these rows today through the userId-keyed `CUSTOMER#`
fallback, so a row with no `orgId` can be a paying account that is working right
now. The flip is what takes it away. So every disposition starts with the same
question the collision procedure asks: **does this customer have a live
subscription in the Stripe dashboard?**

Per row:

1. Read the row's `stripeCustomerId` and open the customer in Stripe.
2. If it has a **live subscription**, this is a manual fix, never an acceptance.
   Its `metadata.orgId` usually names the org: write the attribute onto the row by
   hand and the next dry run copies it normally. If the metadata names no org,
   find the org the customer belongs to and stamp it — the cheapest disposition is
   to make the row stop being one.
3. Only if the customer is **gone from Stripe, or has no live subscription**, is
   the row residue: nothing is being billed and no tenant reads it. Record what
   you saw and name it on `--accept-orgless`.
4. Never guess an org. A row copied to the wrong `ORG#` partition gives that org
   somebody else's subscription.

Spot-check one org from `billing-backfill.log` if you want the raw rows. The run
banner prints the physical `BillingTable` name; query it directly:

```sh
aws dynamodb query --region us-east-2 \
  --table-name "<BillingTable name from the run banner>" \
  --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"ORG#<orgId>"}}'
```

The query returns `SUBSCRIPTION` with `orgId`, `userId`, `rekeyedFrom`, and the
billing state, alongside whatever `USAGE_REPORT#` items the org already had in
that partition.

## Post-run

Record the `--verify` output — stage, date, the report, and the
`--accept-orgless` list it was run with — on the flip PR. That PR removes the
`CUSTOMER#` fallback, and a PASS is what says the fallback has nothing left to
catch. Do the same for staging before production, so both stages are re-keyed
before the flip merges.

## The merge gate on the flip

**The flip PR merges only after this run reports `VERIFY: PASS` on production.**
Merging to `main` auto-deploys, and the flip makes `ORG#{orgId}/SUBSCRIPTION` the
only row any read looks at. Until this backfill has written those rows, that is
every pre-existing account: the subscription guard finds nothing, and every gated
route answers `SUBSCRIPTION_INACTIVE`. The only way back is a revert deploy.

What the gate asks for, in order:

1. `--execute` reports zero raced orgs on **staging**, then on **production**.
2. `--verify` reports `VERIFY: PASS` on **staging**, then on **production**.
3. Both reports are pasted on the flip PR, with their dates.
4. Only then does the PR merge.

After the flip deploys, watch the guard's denial rate before starting the cleanup
below. A rise in `SUBSCRIPTION_INACTIVE` means the backfill missed a cohort, and
the legacy rows are still there to recover from.

## Delete the CUSTOMER# rows

The last phase, and the only destructive one. It is a **dated step run by hand**,
not a script in this stack, and it happens only after the flip has been deployed
and quiet.

Preconditions, all of them:

1. The flip is deployed to the stage, and `--verify` passed before it merged.
2. At least one full billing cycle of the lifecycle jobs has run since — the daily
   grace-period enforcer, the drift checker, and the usage-reporting orchestrator
   all scan this table, and a clean run of each on org rows alone is the evidence
   that nothing still reads a `CUSTOMER#` row.
3. No rise in `SUBSCRIPTION_INACTIVE` denials attributable to the flip.
4. The `--verify` log from the flip gate is still on hand, and the cleanup log
   below records each row **in full** before deleting it: between them they are
   the only record of what the legacy rows held, because there is no PITR or
   backup on this table.

Then delete, stage by stage, keeping the output:

```sh
BILLING_TABLE="<BillingTable name from the run banner>" \
node --input-type=module -e '
  import { DynamoDBClient, DeleteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
  const TableName = process.env.BILLING_TABLE;
  const ddb = new DynamoDBClient({ region: "us-east-2" });
  let key, deleted = 0;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName,
      FilterExpression: "sk = :sk AND begins_with(pk, :legacy)",
      ExpressionAttributeValues: { ":sk": { S: "SUBSCRIPTION" }, ":legacy": { S: "CUSTOMER#" } },
      ExclusiveStartKey: key,
    }));
    for (const item of page.Items ?? []) {
      // The whole row, not just its key: this log is the record.
      console.log("DELETE", JSON.stringify(item));
      await ddb.send(new DeleteItemCommand({
        TableName,
        Key: { pk: item.pk, sk: { S: "SUBSCRIPTION" } },
      }));
      deleted++;
    }
    key = page.LastEvaluatedKey;
  } while (key);
  console.log("Deleted", deleted, "legacy rows");
' 2>&1 | tee billing-cleanup-$(date +%Y-%m-%d).log
```

Record the date and the count in the PR that closes FIL-1013. After this step the
`--verify` mode has nothing left to compare and the revert below has nothing left
to fall back on: the re-key is final.

## Revert

Reach for the revert when the backfill has to be undone **before the flip
merges** — the `CUSTOMER#` fallback is still in every read path, so reverted
accounts keep working.

```sh
./bin/revert-billing-backfill.ts --stage production 2>&1 | tee billing-revert-dry-run.log
./bin/revert-billing-backfill.ts --stage production --execute 2>&1 | tee billing-revert.log
```

The revert deletes only org rows carrying `rekeyedFrom`, and each delete is
conditional on the row still being a copy of the source the scan read. Rows the
application wrote are never touched — they are live billing state with no legacy
row behind them, so deleting one takes that account's subscription away even with
the fallback in place. The dry run counts them separately for exactly that reason.

The backfill undoes a revert: run its dry run afterwards and the reverted orgs come
back as `Copy`, then `--execute` copies them again. The two scripts are a round
trip.

Two asymmetries to know before running it:

- **No `CUSTOMER#` row is touched, in either direction.** The backfill never
  deleted one, which is what makes the revert a delete rather than a restore.
- **A row re-copied from a different source is kept.** Its `rekeyedFrom` no longer
  matches what the scan read, so the condition declines and the run reports
  `CHANGED`. That is a row somebody's collision resolution decided; the revert
  does not get to undo the decision.

**After the flip merges, the revert is not enough on its own.** The org row is the
only row anyone reads by then, so deleting it locks the account out — reverting
billing means reverting that deploy in the same change.
