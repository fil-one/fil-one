# Org Conversion Runbook

Moving organization membership from `UserInfoTable` into `OrgTable`, and the
legacy `admin` role to `owner` (IAM M1, FIL-1013). One manual run per stage,
between two merges: the write path that makes new signups born-converted is
already deployed, and the enforcement PR that reads the new rows merges only
after this run is verified.

- Script: `bin/convert-orgs-to-orgtable.ts`
- Revert: `bin/revert-org-conversion.ts`
- Design: `docs/architectural-decisions/2026-08-organizations-roles-m1.md` §7

Per org, one `OrgTable` transaction writes `ORG#{orgId}/MEMBER#{userId}`
(`role: owner`, `joinedAt`, `source: conversion`), the inverse item
`USER#{userId}/MEMBERSHIP#{orgId}`, and — for an org that does not already have
one — `ORG#{orgId}/META` with `ownerCount: 1`. The legacy `UserInfoTable`
`ORG#{orgId}/MEMBER#{userId}` row is deleted after that transaction succeeds.
Orgs from the earliest accounts have no membership row anywhere and are repaired
from `ORG#{orgId}/PROFILE.createdBy`. `joinedAt` comes from the legacy row, or
from `PROFILE.createdAt` when the legacy row carries none; where neither exists
the conversion writes `1970-01-01T00:00:00.000Z` and the org's log line marks it
`(none recorded)`. That epoch timestamp in a converted row means the join date
was never recorded, not that anyone joined in 1970.

Every item is written with `attribute_not_exists(pk)`, and the classification is
derived from live data on each run. An interrupted run is resumed by running it
again: orgs it finished classify as already converted and are skipped, and a
signup that lands mid-run keeps the rows its own transaction wrote.

## Preconditions

1. **The write path is deployed to the target stage.** `createNewUserAndOrg`
   must already write `OrgTable` membership, the inverse item, and
   `ownerCount: 1` for new signups (the `iam-m1/02-orgtable-and-write-path`
   PR). Merges to `main` auto-deploy, so confirm the stage is running a commit
   that contains it. Converting before that PR deploys leaves every account
   created in the gap needing a second pass.
2. **Enforcement is not merged.** `authorize()` and the removal of the
   absent-row Owner fallback must still be unmerged. Membership reads treat an
   absent `OrgTable` row as Owner until this run is verified; merging
   enforcement first locks out every unconverted account.
3. Run from the repository root.
4. Have the stage's AWS credentials in your environment (`AWS_PROFILE`). The
   script talks to DynamoDB directly with them; nothing is routed through
   `sst shell`, which cannot evaluate providers against production.

**Run one script at a time.** The conversion and the revert move the same rows
in opposite directions, so an `--execute` run of either takes a lock row
(`CONVERSION#LOCK` / `LOCK`) in `OrgTable` and holds it for the whole write
phase. A second run stops and names the one already running. If a run is killed
outright, drop the lock it left behind:

```sh
./bin/convert-orgs-to-orgtable.ts --stage production --force-unlock
```

## Naming the stage

`--stage <name>` is required and has no default. The script reads the physical
table names out of `sst state export --stage <name>`, then asserts they carry
`filone-<stage>-` before it reads anything — the flag alone is not trusted.
Staging is AWS account 654654381893, production 811430801166.

## Dry run

Dry run is the default; the script writes only with `--execute`.

```sh
./bin/convert-orgs-to-orgtable.ts --stage production 2>&1 | tee convert-dry-run.log
```

The report names the stage and both table names, then prints the plan (counts
below are illustrative):

```
DRY-RUN — Converting org membership into OrgTable (stage="production", region=us-east-2)
  UserInfoTable: filone-production-UserInfoTableTable
  OrgTable:      filone-production-OrgTableTable

Matched in UserInfoTable: 4128 rows — 812 org profiles, 786 legacy MEMBER# rows, 809 user profiles, 3 DELETION records
Matched in OrgTable: 74 MEMBER# rows, 74 MEMBERSHIP# inverse items, 74 META rows

Orgs scanned: 812
  Convert (legacy MEMBER# row -> OrgTable):           712
  Repair (no membership row; from PROFILE.createdBy): 24
  Already converted (skipped):                        74
    of which a legacy MEMBER# row remains to delete:  2
  Being deleted (skipped):                            3
  Anomalies (manual disposition):                     2

Anomalies — dispose of these before executing:
  [profile-without-createdby] ORG#8f3c…  no MEMBER# row anywhere and PROFILE carries no createdBy to repair from
  [unknown-user] ORG#1a2b…  MEMBER#c4d5… has no USER#c4d5…/PROFILE row

Writes 736 orgs (1472 OrgTable items, of which 736 META counters) and deletes 714 legacy MEMBER# rows.

  [dry-run] CONVERT ORG#0a1b… MEMBER#7f8e… admin->owner joinedAt=2026-02-11T09:12:44.301Z source=conversion META=new
  [dry-run] REPAIR ORG#0c2d… MEMBER#3e4f… granted owner from PROFILE.createdBy joinedAt=2025-11-02T12:00:00.000Z source=conversion META=new
  [dry-run] SKIPPED ORG#5a6b… being deleted — PROFILE.deleting=true with a DELETION record
  …
```

**Orgs being deleted are skipped, in both modes.** An org whose
`ORG#{orgId}/PROFILE` carries `deleting: true`, or that has an
`ORG#{orgId}/DELETION` record, belongs to account deletion: the teardown worker
resolves its members from both tables and deletes their rows itself. Converting
one races that teardown, and writing a membership into an org being deleted puts
back the row teardown exists to remove. The skip comes before every other
classification, so a half-torn-down org is never reported as an anomaly for the
row shapes teardown left behind. `--verify` counts these orgs and names them
rather than flagging them as unconverted.

Every line names the user the membership goes to, including the repair cohort —
that membership is invented from `PROFILE.createdBy`, and the log is the only
record of who received it.

**Do not execute until the anomaly list is empty or every entry has been
dispositioned.** Nothing on that list is repaired automatically: each one means
the data says something the conversion was not designed to decide.

| Anomaly                     | What it means                                                               | Disposition                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `profile-without-createdby` | No membership row anywhere and no creator recorded — nobody to make Owner.  | Identify the account's user from `SUB#`/`USER#` rows or support history, then write the row by hand.          |
| `unknown-user`              | The membership (or `createdBy`) names a user with no `USER#…/PROFILE` row.  | Usually a deleted user. Decide whether the org is dead; if so, remove its rows rather than convert.           |
| `unexpected-role`           | The legacy row carries something other than `admin`.                        | Read the row. Converting it to Owner is a decision about that account's authority, so make it by hand.        |
| `multiple-member-rows`      | More than one legacy member row, which the pre-M1 write path cannot create. | Inspect. `ownerCount: 1` would be wrong for this org, so it needs a hand-written owner set.                   |
| `missing-org-profile`       | Membership rows for an org with no `ORG#…/PROFILE`.                         | Usually deleted-account residue. Confirm, then delete the leftovers instead of converting them.               |
| `foreign-membership`        | `OrgTable` already holds a membership naming a different user.              | Someone else owns the org now. Reconcile by hand; the script will not overwrite a live membership.            |
| `membership-removed`        | `META` exists with neither a membership nor a legacy row.                   | The org was already handled and its member removed since. Do not repair: that puts back a deleted membership. |

Re-run the dry run after each disposition until the list is empty.

**Anomalies keep their legacy rows.** Dispositioning one usually means writing
or deleting rows by hand, not making the script convert it. An org left as an
anomaly still holds its `UserInfoTable` `MEMBER#` row afterwards, by design —
deleting it would destroy the only record of what the org held.

That row is also why an anomaly fails `--verify`. Enforcement reads `OrgTable`
and nothing else, so an anomaly org's users have no membership the moment it
deploys, whatever `UserInfoTable` still holds. An anomaly that has been looked
at is recorded by naming its org on the verify run:

```sh
./bin/convert-orgs-to-orgtable.ts --stage production --verify \
  --accept-anomalies ORG#8f3c…,ORG#1a2b…
```

Each id is a separate decision about one account, so the list is enumerated by
hand — there is no "accept all". Both the `ORG#…` form the report prints and
the bare org id are accepted. Every acceptance is echoed under the check, with
the reason the org was an anomaly, so the PASS recorded on the enforcement PR
says which accounts were signed off and by which classification. An id that no
longer matches an anomaly is echoed as such rather than silently dropped.

The cheapest disposition is often to make the anomaly stop being one: repairing
the org by hand (writing the `OrgTable` membership the conversion declined to
invent) removes it from the list, and the next `--verify` passes without the
flag.

## Execute

```sh
./bin/convert-orgs-to-orgtable.ts --stage production --execute 2>&1 | tee convert.log
```

There is no PITR or backup on these tables, so the log is the only record of
what changed — capture both streams (`2>&1`) and keep `convert.log`.

The run prints the same plan first, then one line per org after its write, then
a tally. Each per-org line carries the outcome that actually happened:
`CONVERTED`, `REPAIRED`, `RACED`, `SKIPPED`, `CONFLICT`, `RETRY`, or `FAILED`.

```
Converted (from legacy MEMBER# rows):        712
Repaired (from PROFILE.createdBy):           24
Already converted before this run:           74
Raced (a concurrent write got there first):  0
Legacy MEMBER# rows deleted:                 714
Conflicts — transaction (manual review):     0
Conflicts — stale legacy row kept:           0
Skipped (being deleted):                    3
Anomalies (untouched):                       2

Convert + Repair (736) = Converted + Repaired + Raced + transaction conflicts (736).
Stale legacy rows in the plan (2) = deleted (2) + stale-row conflicts (0).
```

`Already converted` repeats the plan's count — those orgs are skipped, except
for the handful whose legacy row an earlier run had not deleted yet. `Raced`
counts orgs whose transaction was cancelled and whose membership then read back
as present, so someone else wrote it while this run was in flight.

Two conflict counters, because they mean different things:

- **Transaction** — the conversion's transaction was cancelled and no membership
  exists afterwards. The org is in neither state; investigate each one.
- **Stale legacy row kept** — a previously converted org's `OrgTable` membership
  disappeared between the scan and the delete, so its legacy row was left alone.

The script exits non-zero when either occurs. A cancellation caused by
throttling or a transaction conflict is retried with backoff and then stops the
run; it is never counted as a conflict for manual review.

## Verify

```sh
./bin/convert-orgs-to-orgtable.ts --stage production --verify \
  --accept-anomalies ORG#8f3c…,ORG#1a2b… 2>&1 | tee convert-verify.log
```

`--verify` re-reads both tables, re-derives the same classification the
conversion uses, and prints one line per check. It writes nothing and exits
non-zero on any `FAIL`.

```
PASS  No org is still convertible
        0 orgs would convert from a legacy MEMBER# row
PASS  No org is still repairable
        0 orgs would be repaired from PROFILE.createdBy
PASS  No converted org still holds its legacy row
        0 converted orgs have a legacy MEMBER# row left to delete
PASS  Every remaining legacy MEMBER# row belongs to an anomaly
        5 legacy MEMBER# rows remain, on 2 live orgs; 0 of those orgs are not anomalies
          ORG#8f3c… MEMBER#a1b2… — unexpected-role
          ORG#1a2b… MEMBER#c4d5… — unknown-user
PASS  Membership rows and inverse items agree
        810 MEMBER# rows, 810 MEMBERSHIP# inverse items
PASS  Every org with a membership has its META counter
        812 META rows for 810 memberships; 0 memberships have none
PASS  Every META without a membership is a removed membership
        2 orgs hold META with no membership; 0 are not classified as membership-removed
PASS  Orgs being deleted are skipped
        3 orgs are being deleted; the conversion left them alone
          ORG#5a6b… — PROFILE.deleting=true with a DELETION record
PASS  Every anomaly has been dispositioned
        2 anomalies of 812 orgs; 810 converted; 2 accepted, 0 undispositioned
        accepted by --accept-anomalies (2):
          ORG#8f3c… [unexpected-role] MEMBER#a1b2… carries role="member", expected "admin"
          ORG#1a2b… [unknown-user] MEMBER#c4d5… has no USER#c4d5…/PROFILE row

VERIFY: PASS
```

**The gate for the enforcement PR is `VERIFY: PASS` with zero unaccepted
anomalies**, not a legacy-row count of zero. Anomaly classes keep their legacy
rows on purpose, and the run above passes because both anomalies were named on
`--accept-anomalies`. Without that flag the same stage reports:

```
FAIL  Every anomaly has been dispositioned
        2 anomalies of 812 orgs; 810 converted; 0 accepted, 2 undispositioned
          ORG#8f3c… [unexpected-role] MEMBER#a1b2… carries role="member", expected "admin"
          ORG#1a2b… [unknown-user] MEMBER#c4d5… has no USER#c4d5…/PROFILE row

VERIFY: FAIL (1 checks)
```

Spot-check one org from `convert.log` if you want the raw rows. The run banner
prints the physical `OrgTable` name; query it directly:

```sh
aws dynamodb query --region us-east-2 \
  --table-name "<OrgTable name from the run banner>" \
  --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"ORG#<orgId>"}}'
```

The query returns `MEMBER#{userId}` with `role: owner`, `source: conversion`,
and `META` with `ownerCount: 1`.

## Post-run

Record the `--verify` output — stage, date, the report, and the
`--accept-anomalies` list it was run with — on the enforcement PR. That PR
removes the absent-row Owner fallback, and a PASS is what says the fallback has
nothing left to catch. Do the same for staging before production, so both
stages are converted before enforcement merges.

**Enforcement merges as two PRs together.** #600 puts `authorize()` and the
membership gate in front of every route and removes the fallback; #601 adds the
in-handler permission checks that four of those routes need to distinguish a
Member from an Admin. #600 alone leaves those four routes gated on membership
but not on role, so deploy the pair — merge #601 immediately behind #600, or
merge #600 only once #601 is approved and ready to follow.

## Revert

Reach for the revert when the conversion has to be undone before enforcement
merges — the fallback is still in place, so reverted accounts keep working.
After enforcement merges, reverting membership without also reverting that PR
locks accounts out.

```sh
./bin/revert-org-conversion.ts --stage production 2>&1 | tee revert-dry-run.log
./bin/revert-org-conversion.ts --stage production --execute 2>&1 | tee revert.log
```

The revert acts only on `OrgTable` membership rows that still carry
`source: 'conversion'` **and** `role: owner`. Rows written by signup
(`source: 'signup'`), and conversion rows whose role has been changed since, are
left alone — a stage that has been taking new signups reverts only what the
conversion created and nobody has touched. The dry run reads the stored role and
reports those rows as `SKIPPED` up front, so its counts are the counts the
execute run produces.

The conversion undoes a revert: run its dry run afterwards and the reverted orgs
come back as `Convert`, then `--execute` converts them again. The two scripts
are a round trip.

Two asymmetries to know before running it:

- `ORG#{orgId}/META` rows stay. They carry no provenance attribute, so a
  conversion-written META cannot be told from one written at signup, and
  `ownerCount: 1` is true for an org of one either way. The conversion knows
  this and writes no META for an org that already has one, which is what lets a
  reverted org convert again.
- The orgs repaired from `PROFILE.createdBy` never had a legacy row, and the
  stored membership does not record which ones those were, so the revert writes
  them a `UserInfoTable` row they never had. Nothing reads that row, and
  re-running the conversion repairs them the same way.
