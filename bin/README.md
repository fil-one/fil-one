# bin/ — Developer Scripts

## Resource Cleanup

Every SST deploy creates AWS resources (Lambda functions, API Gateways, IAM roles, etc.) scoped to a "stage" (e.g. `pr-175`, `staging`, `desktop-username`). PR stages accumulate quickly and need periodic cleanup to stay under AWS account quotas.

**IAM roles are a common bottleneck.** The account limit is 1000 roles. Each stage creates ~33 roles, and the AWS Resource Groups Tagging API does not return IAM roles, so they are invisible to tag-based queries. The scripts below handle this by scanning IAM roles directly via the IAM API.

### find-stale-stages.sh

Discovers all SST stages in the account and checks whether their corresponding PR is still open.

```bash
bin/find-stale-stages.sh
```

Output looks like:

```
KEEP    staging (protected)
KEEP    pr-184 (PR #184 is OPEN)
STALE  pr-121 (PR #121 is MERGED)
STALE  pr-149 (PR #149 is MERGED)
UNKNOWN bajtos (not a PR stage — may be a dev stage)
```

Sources:

- Regional resources: Resource Groups Tagging API (`sst:stage` tag)
- IAM roles: direct scan of roles matching known SST name prefixes (`filone-*`, `hyperspace-*`, `pr-*`, etc.) and their `sst:stage` tags

### remove-stale-stage.sh

Deletes all AWS resources belonging to a stage.

```bash
# Remove a single stage
bin/remove-stale-stage.sh pr-149

# Remove multiple stages
for stage in pr-41 pr-55 pr-56 pr-59 pr-61 pr-62; do
  echo "=== Removing $stage ==="
  bin/remove-stale-stage.sh "$stage"
done
```

The script runs in two phases:

1. **Regional resources** (via tagging API): Lambdas, API Gateways, DynamoDB tables, CloudWatch log groups/alarms, EventBridge rules/buses, SQS queues, S3 buckets
2. **IAM roles** (direct scan): finds roles by name prefix (`filone-<stage>-*`, `hyperspace-<stage>-*`, `<stage>-*`) and by tag (`sst:stage`) for roles with non-standard names (e.g. `CwToFirehoseRole-*`, `OtelFirehoseRole-*`)

### prune-lambda-versions.sh

Deletes old published Lambda versions for a stage, keeping the N most recent. Useful after many deploys to a provisioned-concurrency stage to stay under the 75 GB deployment package storage limit.

```bash
# Keep 3 most recent versions (default)
bin/prune-lambda-versions.sh staging

# Keep 5 versions
bin/prune-lambda-versions.sh pr-42 5
```

### Typical cleanup workflow

```bash
# 1. See what's stale
bin/find-stale-stages.sh

# 2. Remove stale PR stages
bin/find-stale-stages.sh 2>/dev/null | grep '^STALE' | awk '{print $2}' | while read stage; do
  echo "=== Removing $stage ==="
  bin/remove-stale-stage.sh "$stage"
done

# 3. Verify role count is back under quota
aws iam list-roles --query 'length(Roles)' --output text
```

### Environment variables

| Variable | Default                       | Description                              |
| -------- | ----------------------------- | ---------------------------------------- |
| `REGION` | `us-east-2`                   | AWS region for regional resources        |
| `REPO`   | auto-detected from git remote | GitHub `owner/repo` for PR state lookups |

## The organizations beta flag

`orgs-beta.ts` switches one organization, or one person, into the organizations
beta. The flag decides two things: whether `POST /api/org/invitations` will
create an invitation, and whether the console shows a members surface at all.

```bash
node bin/orgs-beta.ts list staging
node bin/orgs-beta.ts grant staging 4f1c2a80-9b3e-4a51-8d77-6b0c2f9a1e34   # dry run
node bin/orgs-beta.ts grant staging 4f1c2a80-9b3e-4a51-8d77-6b0c2f9a1e34 --execute
node bin/orgs-beta.ts revoke staging someone@example.com --execute
node bin/orgs-beta.ts check staging someone@example.com                    # exit 0 granted, 2 not
```

**Revoking an org with members needs `--force-members`.** The console offers the
members surface to a caller who belongs to more than one organization, or one
whose organization holds this flag. An Owner who belongs to no other org is
therefore the case that breaks: revoking their org's row leaves every member in
place and takes away the roster, the role picker, removal and transfer, while
the API keeps serving all four. So a revoke against an org with more than one
member prints the count and stops until `--force-members` says it was meant.

**Where the flag lives.** `UserInfoTable`, sort key `ORGS_BETA`, under either of
two partition keys:

| Key                            | Grants                                        |
| ------------------------------ | --------------------------------------------- |
| `ORG#{orgId}`                  | every member of that organization             |
| `ALLOWLIST#{lowercased-email}` | that person, in whichever org they are active |

The org row is the one an enterprise beta wants: FilOne learns an employee's
address only at their first login, so the members cannot be enumerated in
advance.

**Presence is the grant.** The rows carry no attributes and none are read.
Granting twice is the same as granting once, and revoking a row that was never
written is not an error.

**Either row grants.** Revoking an org does not revoke the people inside it who
hold their own allowlist row, and revoking an address does not revoke their
org's row. `list` shows both kinds, and `revoke` and `check` name the direction
they did not read, because neither can answer whether a person is in the beta:
the gate ORs the two rows and resolves the org from the request.

**Invitations already sent stay acceptable.** Accepting one reads no flag
(`accept-invitation.ts`), so a revoke removes the console path to withdrawing an
invitation rather than the invitation. `revoke` lists what is still redeemable —
the org's pending rows for an `ORG#` target, and the rows naming that address
for an `ALLOWLIST#` one — so the operator sees what they left behind.

**Reads are consistent.** `hasOrgsBetaAccess` reads both rows with
`ConsistentRead`, because granting the flag is a manual step somebody performs
and then immediately tries. What the script writes is what the next request
sees. The console is the lag that remains: it caches `GET /me` for ten minutes,
so a customer watching for the change may need to reload.

**Grants and revokes are dry runs by default.** Both print the row they would
write or delete and stop until `--execute` is passed. `--dry-run` beats
`--execute` when both are given, as it does in the migration scripts, and any
other `--` argument stops the run rather than being ignored. `list` and `check`
only read.

Targets are told apart by shape: anything containing `@` is an email, anything
else must be an organization UUID. The script refuses a target that is neither
before it touches AWS. A UUID also has to name an organization that exists:
`grant` and `check` read its `ORG#{orgId}/PROFILE` row first and exit 1 when
there is none, because `GET /me` reports `orgId` beside `userId` and both are
UUIDs — an id taken from the wrong field would otherwise be written as a grant
that reads back in `list` and grants nothing.

Like `rag-access.ts`, this talks to AWS directly with your ambient credentials
rather than through `sst shell`, which cannot evaluate pulumi providers against
production. Set `AWS_PROFILE` first.

## Resetting one region's provisioning

`reset-region-provisioning.ts` clears every account's pointer into one region,
so the next console request re-runs tenant setup from scratch. Run it after the
upstream orchestrator behind a region has been wiped or re-deployed.

```bash
node bin/reset-region-provisioning.ts --stage $USER --region eu-central-3 --dry-run
node bin/reset-region-provisioning.ts --stage staging --region eu-central-3
```

**Production is refused.** Every region there carries real customer data, and a
reset takes the region away from every account at once. Every other stage
allows every region the script knows. The check runs before the first AWS call.

**Scan, plan, confirm.** The run prints one line per account — its tenant id,
its access-key count, its RAG buckets with the S3 Vectors index behind each,
and its SSM parameters — then asks for the literal `yes` on stdin. `--dry-run`
prints the plan and exits, `--yes` applies without prompting, and a run
carrying both stays a dry run. An account that `AccountDeletionWorker` is
already tearing down is marked in its plan line and reset like any other:
clearing the attribute is what lets that teardown finish once the upstream
tenant is gone.

**A run with something to reset writes a backup.** A JSON file, `--dry-run`
included, holding the stored rows the run is about to delete: the tenant id,
the profile attributes and their prior values, the `ACCESSKEY#` rows, the RAG
rows with their index names, and the SSM parameter names. It refuses to
overwrite an existing file, and `--backup <path>` names it. A run that finds no
account provisioned in the region writes nothing.

There is no restore script yet. The file holds what one would need to re-create
the upstream tenant under the recorded tenant id and re-write the profile
attributes. Access keys cannot be restored: the file carries no secret material,
and a freshly minted key comes with a fresh secret that only the customer
creating it ever sees. The recorded `ACCESSKEY#` rows are the list of keys each
customer would have to re-create. RAG indexes would come back by re-enabling RAG
and letting the indexer sync.

**What the reset leaves in place.** The orchestrators are never called, so
upstream tenants, buckets and access keys stay where they are — the reset
assumes they are already gone. `OrgTable` holds membership only and is not
read. There is no DynamoDB PITR, so the printed plan is the only audit trail;
capture stdout with `| tee reset-region.log`.

Applying needs a role that can write UserInfoTable and RagIndexerTable, delete
SSM parameters, and call `s3vectors:GetVectorBucket` and
`s3vectors:DeleteIndex`. A read-only profile that can read the vector bucket
gets as far as the plan and the backup, then fails on the first write; one that
cannot stops before the scan.

## Other Scripts

| Script                         | Purpose                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convert-orgs-to-orgtable.ts`  | Move org membership into OrgTable, `admin` → `owner` (runbook: [docs/OrgConversionRunbook.md](../docs/OrgConversionRunbook.md))                                        |
| `revert-org-conversion.ts`     | Undo `convert-orgs-to-orgtable.ts`                                                                                                                                     |
| `backfill-billing-to-org.ts`   | Copy each BillingTable subscription row to its org key, and `--verify` the result (runbook: [docs/BillingRekeyRunbook.md](../docs/BillingRekeyRunbook.md))             |
| `revert-billing-backfill.ts`   | Undo `backfill-billing-to-org.ts` — deletes only the org rows it wrote                                                                                                 |
| `orgs-beta.ts`                 | Grant, revoke, list, and check the organizations beta flag (see above)                                                                                                 |
| `rag-access.ts`                | Enable, disable, or check RAG access for one email                                                                                                                     |
| `extend-trial.ts`              | Reset a non-production test account back to a fresh `trialing` state, across Stripe, BillingTable, Aurora, and FTH                                                     |
| `tail-logs.sh`                 | Tail CloudWatch logs for a Lambda function                                                                                                                             |
| `tail-tenant-setup-logs.sh`    | Tail logs for the Aurora tenant setup Lambda                                                                                                                           |
| `reset-db.ts`                  | Reset the Aurora database for a stage                                                                                                                                  |
| `reset-region-provisioning.ts` | Un-provision one region for every account in a non-production stage (see above)                                                                                        |
| `aurora-s3-env.ts`             | Print Aurora S3 environment variables                                                                                                                                  |
| `aurora-preview-url.ts`        | Pre-signed GetObject URL for an Aurora object, plus a billing report for the owning account (deletion state, Stripe dashboard link, subscription status, latest usage) |
| `aurora-demo.ts`               | Demo script for Aurora S3 operations                                                                                                                                   |
| `account-deletion.ts`          | Report an org's account-deletion state, and start or re-drive the teardown worker                                                                                      |
| `fth-console-key.ts`           | Re-issue the per-tenant FTH console access key as `filone-console-v2`, prune the old key, and repair a tenant whose key FTH reported creating but does not have        |
| `fth-s3-env.ts`                | Print FTH (us-east-1) S3 environment variables for one org, without `sst shell`                                                                                        |

### Shared helpers (`bin/lib/`)

| Module              | What it holds                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `args.ts`           | `--stage` (required, no default), `--execute`/`--dry-run`, usage and help                  |
| `stage.ts`          | Table names from `sst state export`, the resolved-name stage assertion, the region mapping |
| `sst-state.ts`      | One deployed table and its region from `sst state export`, for the flag scripts            |
| `dynamo.ts`         | Paging a Scan to the end, decoding rows, and retrying a cancelled transaction              |
| `run-lock.ts`       | The single lock row that keeps a migration and its revert off the same table at once       |
| `billing-rekey.ts`  | What to do with each subscription row, and the exact items that carry it out               |
| `billing-verify.ts` | The checks behind `backfill-billing-to-org.ts --verify` — the flip PR's merge gate         |
| `org-conversion.ts` | The same, for the org membership conversion                                                |
| `region-reset.ts`   | What un-provisioning one region deletes, per account, and the plan the operator reads      |
