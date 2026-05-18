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

## Other Scripts

| Script                      | Purpose                                      |
| --------------------------- | -------------------------------------------- |
| `tail-logs.sh`              | Tail CloudWatch logs for a Lambda function   |
| `tail-tenant-setup-logs.sh` | Tail logs for the Aurora tenant setup Lambda |
| `reset-db.ts`               | Reset the Aurora database for a stage        |
| `aurora-s3-env.ts`          | Print Aurora S3 environment variables        |
| `aurora-demo.ts`            | Demo script for Aurora S3 operations         |
