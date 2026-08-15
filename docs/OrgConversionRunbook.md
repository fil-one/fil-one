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
`USER#{userId}/MEMBERSHIP#{orgId}`, and `ORG#{orgId}/META` with `ownerCount: 1`.
The legacy `UserInfoTable` `ORG#{orgId}/MEMBER#{userId}` row is deleted after
that transaction succeeds. Orgs from the earliest accounts have no membership
row anywhere and are repaired from `ORG#{orgId}/PROFILE.createdBy`.

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
3. Run from the repository root — the scripts read `.sst/stage`.
4. Have the stage's AWS credentials. `sst shell --stage <name>` supplies them.

## Dry run

Dry run is the default; the script writes only with `--execute`.

```sh
pnpm exec sst shell --stage production -- node ./bin/convert-orgs-to-orgtable.ts | tee convert-dry-run.log
```

The report names the stage and both table names, then prints the plan (counts
below are illustrative):

```
DRY-RUN — Converting org membership into OrgTable (stage="production", region=us-east-2)
  UserInfoTable: filone-production-UserInfoTable
  OrgTable:      filone-production-OrgTable

Matched in UserInfoTable: 4128 rows — 812 org profiles, 786 legacy MEMBER# rows, 809 user profiles
Matched in OrgTable: 74 MEMBER# rows, 74 META rows

Orgs scanned: 812
  Convert (legacy MEMBER# row -> OrgTable):           712
  Repair (no membership row; from PROFILE.createdBy): 24
  Already converted (skipped):                        74
    of which a legacy MEMBER# row remains to delete:  2
  Anomalies (manual disposition):                     2

Anomalies — dispose of these before executing:
  [profile-without-createdby] ORG#8f3c…  no MEMBER# row anywhere and PROFILE carries no createdBy to repair from
  [unknown-user] ORG#1a2b…  MEMBER#c4d5… has no USER#c4d5…/PROFILE row

Writes 736 orgs (2208 OrgTable items) and deletes 714 legacy MEMBER# rows.

  [dry-run] ORG#0a1b… MEMBER#7f8e… admin->owner joinedAt=2026-02-11T09:12:44.301Z source=conversion
  [dry-run] ORG#0c2d… repaired from PROFILE.createdBy -> owner joinedAt=2025-11-02T12:00:00.000Z source=conversion
  …
```

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
| `membership-removed`        | `META` exists with no membership row.                                       | The org was already handled and its member removed since. Do not repair: that puts back a deleted membership. |

Re-run the dry run after each disposition until the list is empty.

## Execute

```sh
pnpm exec sst shell --stage production -- node ./bin/convert-orgs-to-orgtable.ts --execute | tee convert.log
```

There is no PITR or backup on these tables, so the per-org log is the only
record of what changed — keep `convert.log`.

The run prints the same plan first, then one line per org, then a tally:

```
Converted (from legacy MEMBER# rows):  712
Repaired (from PROFILE.createdBy):     24
Already converted before this run:     74
Raced (a concurrent write got there first): 0
Legacy MEMBER# rows deleted:           714
Conflicts (manual review):             0
Anomalies (untouched):                 2

The plan's Convert + Repair equals Converted + Repaired + Raced + Conflicts.
```

`Already converted` repeats the plan's count — those orgs are skipped, except
for the handful whose legacy row an earlier run had not deleted yet. `Raced`
counts orgs whose transaction was cancelled and whose membership then read back
as present, so someone else wrote it while this run was in flight. `Conflicts`
counts orgs where the transaction was cancelled and no membership exists
afterwards; the script exits non-zero when any occur. Investigate each before
proceeding: they are the only case where an org has been left in neither state.

## Verify

Run every check against the same stage. The first is the gate for the
enforcement PR. Both table names are printed at the top of every run — put them
in the shell:

```sh
USER_INFO_TABLE=filone-production-UserInfoTable
ORG_TABLE=filone-production-OrgTable
```

**1. No legacy membership rows remain.**

```sh
pnpm exec sst shell --stage production -- aws dynamodb scan \
  --table-name "$USER_INFO_TABLE" \
  --select COUNT \
  --filter-expression 'begins_with(pk, :o) AND begins_with(sk, :m)' \
  --expression-attribute-values '{":o":{"S":"ORG#"},":m":{"S":"MEMBER#"}}'
```

Expect `"Count": 0`. A large table pages, and the CLI prints one `Count` per
page — sum them (`… --output json | jq -s 'map(.Count) | add'`).

**2. The counts line up.** Same command against `$ORG_TABLE` with
`begins_with(sk, "MEMBER#")`, `begins_with(sk, "MEMBERSHIP#")`, and
`sk = "META"`. The three counts must be equal, and equal to
`Convert + Repair + Already converted` from the plan the execute run printed —
every org except the ones left as anomalies.

**3. A second dry run is clean.**

```sh
pnpm exec sst shell --stage production -- node ./bin/convert-orgs-to-orgtable.ts
```

Expect `Convert` and `Repair` at 0, `of which a legacy MEMBER# row remains to
delete: 0`, and `Already converted` equal to every org that is not an anomaly.

**4. Spot-check one org** from `convert.log` — all three rows, then the absence
of the legacy one:

```sh
pnpm exec sst shell --stage production -- aws dynamodb query \
  --table-name "$ORG_TABLE" \
  --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"ORG#<orgId>"}}'

pnpm exec sst shell --stage production -- aws dynamodb get-item \
  --table-name "$ORG_TABLE" \
  --key '{"pk":{"S":"USER#<userId>"},"sk":{"S":"MEMBERSHIP#<orgId>"}}'

pnpm exec sst shell --stage production -- aws dynamodb get-item \
  --table-name "$USER_INFO_TABLE" \
  --key '{"pk":{"S":"ORG#<orgId>"},"sk":{"S":"MEMBER#<userId>"}}'
```

The query returns `MEMBER#{userId}` with `role: owner`, `source: conversion`,
and `META` with `ownerCount: 1`; the inverse item carries the same role; the
last command returns nothing.

## Post-run

Record the verified zero count from check 1 — stage, date, and the number — on
the enforcement PR. That PR removes the absent-row Owner fallback, and the
count is what says the fallback has nothing left to catch. Do the same for
staging before production, so both stages are converted before enforcement
merges.

## Revert

Reach for the revert when the conversion has to be undone before enforcement
merges — the fallback is still in place, so reverted accounts keep working.
After enforcement merges, reverting membership without also reverting that PR
locks accounts out.

```sh
pnpm exec sst shell --stage production -- node ./bin/revert-org-conversion.ts | tee revert-dry-run.log
pnpm exec sst shell --stage production -- node ./bin/revert-org-conversion.ts --execute | tee revert.log
```

The revert acts only on `OrgTable` membership rows that still carry
`source: 'conversion'` **and** `role: owner`. Rows written by signup
(`source: 'signup'`), and conversion rows whose role has been changed since,
are left alone — a stage that has been taking new signups reverts only what the
conversion created and nobody has touched. Rows it declines are printed as
`SKIPPED`; a cancellation for any other reason stops the run rather than
counting as a skip.

Two asymmetries to know before running it:

- `ORG#{orgId}/META` rows stay. They carry no provenance attribute, so a
  conversion-written META cannot be told from one written at signup, and
  `ownerCount: 1` is true for an org of one either way.
- The orgs repaired from `PROFILE.createdBy` never had a legacy row, and the
  stored membership does not record which ones those were, so the revert writes
  them a `UserInfoTable` row they never had. Nothing reads that row, and
  re-running the conversion repairs them the same way.

Verify a revert by re-running the conversion dry run: the reverted orgs come
back as `Convert`, and `Already converted` drops to the signup-era count.
