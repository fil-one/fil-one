# ADR: Server-side bulk object deletion

**Status:** Accepted
**Date:** 2026-08-20

## Context

`DeleteBucket` requires an empty bucket, and [#579](https://github.com/fil-one/fil-one/pull/579) deliberately propagates `BucketNotEmpty` rather than swallowing it. So bucket deletion (FIL-204) is only usable once there is a way to empty a bucket of any size first. Emptying from the object browser does not scale: it issues one presigned DELETE per object, and the listing loads a single page, so a bucket with a non-trivial object count cannot be cleared that way.

A large bucket also holds far more objects than one Lambda invocation can delete inside its time budget, and a versioned bucket must have every version and delete marker removed, not just the current keys, or it stays non-empty and reclaims no storage. The work therefore has to be a resumable server-side job rather than a single request.

## Decisions

### 1. Deletion runs as a server-side job, not inline in the request

The create handler (`create-bulk-delete-job`) writes a job row to `BulkDeleteTable`, enqueues one message, and returns `202` with a job the client polls at `GET /api/bulk-delete-jobs/{jobId}`. The job row in DynamoDB is the single source of progress for the UI. The handler never blocks on the deletion, since a large bucket takes far longer than API Gateway's 29-second timeout allows.

`BulkDeleteTable` is separate from `UserInfoTable` because a running job rewrites its row on every listing page, and finished jobs expire on their own via TTL. The transient, high-write-rate state does not belong next to durable account data.

Authorization follows `delete-bucket`: org auth plus `AccessLevel.Write`. There is no access-key permission change, because this is a console operation rather than an S3 API one.

### 2. The job is built on the S3 data plane, not any vendor control-plane API

Aurora, FTH and Forge differ on the control plane but all expose S3, and `getS3ClientContext` is already on the `ServiceOrchestrator` interface. The worker resolves the tenant's S3 credentials for the job's region through that one method and needs no per-region knowledge, so the feature ships in every region with no per-region feature matrix.

Deletion always uses batched `DeleteObjects` (up to 1000 keys per call) in S3's quiet mode. Earlier revisions detected batch support at runtime and fell back to per-object `DeleteObject` on a `501`/`405`. That fallback is gone: an [s3compat check](https://github.com/fil-one/s3compat/pull/3) confirmed FTH, Aurora and Forge all support `DeleteObjects`, so the detection was dead weight and per-object deletion is far too slow to keep as a path. A batch-level rejection now propagates up and fails the job rather than silently dropping to a slower route.

### 3. The job id is derived from the request, for idempotency

`jobId` is `sha256(orgId, region, bucketName, prefix, scope, idempotencyKey)` (see `deriveBulkDeleteJobId`). Folding the arguments into the id means a resubmit of the same request lands on the existing row instead of starting a second deletion, while reusing an idempotency key against a different bucket, prefix or scope yields a different id and its own job instead of colliding onto an unrelated one. The create write is guarded with `attribute_not_exists(sk)`, so the second arrival is handed back the job already running rather than overwriting it.

The frontend-supplied `idempotencyKey` is kept inside the hash rather than excluded. Excluding it would link every empty-this-bucket request to one in-progress job, which is unsafe: if user A starts a deletion, user B then uploads an object, and user B requests an empty, that second request would attach to a job that has already walked past the new key and leave it behind. Including the key means two distinct user actions start separate jobs, and the second re-reads the listing from scratch.

Concurrent jobs against one bucket are then safe by construction rather than by locking. Each job owns its own DynamoDB row (unique derived id), `DeleteObjects` is idempotent so overlapping deletes do not error, and the cursor-advancing walk (decision 4) guarantees each terminates. `deletedCount` can over-count slightly across two overlapping jobs, which is cosmetic.

### 4. The worker checkpoints a listing cursor and re-drives itself

The worker deletes one listing page at a time. After each page it writes the advanced cursor to the job row, and once less than a 30-second buffer of the invocation's time budget remains it stops starting new pages, persists the cursor, and queues itself a continuation message. The next delivery resumes from that checkpoint. This follows the RAG indexer's deadline-aware pattern.

The time-budget check reads `context.getRemainingTimeInMillis()` directly rather than deriving a wall-clock deadline from `Date.now()`. `Date.now()` reads the system clock, which is NTP-adjusted and not guaranteed monotonic in Lambda, whereas `getRemainingTimeInMillis()` is the exact budget Lambda will enforce.

The persisted cursor is load-bearing beyond resume: it is what steps the walk _past_ an object that cannot be deleted. Object-lock retention makes per-object failures normal, and those failures are recorded per key and reported rather than aborting the run, so one locked object cannot strand the rest of the bucket. Without a cursor the loop would re-list from the start on every pass; with 1000 or more locked objects at the head of the listing, `IsTruncated` would stay true and the walk would never advance past them, deleting nothing on each iteration. The cursor is the `KeyMarker`/`VersionIdMarker` for the versioned scan and the continuation token for the current-only scan.

### 5. Versioning-suspended buckets need explicit null-version deletes

Under the default `AllVersions` scope, the worker resolves the bucket's versioning state once per invocation (`getBucketVersioningStatus`, which distinguishes `Enabled`/`Suspended`/`Never`). S3 tracks three states, and `Suspended` is not `Never`: a bucket that once had versioning enabled still carries a `null` version per key, and a plain (no version id) delete on such a key leaves that null version in place behind a new null-version delete marker rather than removing it.

Only a `Never` bucket gets the plain-delete treatment. On a `Suspended` bucket the worker deletes the literal `null` version explicitly. Getting this wrong meant the cursor advanced past the key while the object stayed, so the job could report completion while `DeleteBucket` still saw a non-empty bucket, which is exactly the error #579 surfaces.

### 6. Delivery is a FIFO SQS queue with a bounded DLQ

The worker is driven by a FIFO SQS queue (`BulkDeleteQueue`) rather than a direct Lambda invoke. A direct invoke leaves no trace when a link in the chain dies: if the process is killed after a checkpoint but before it hands off, nothing re-drives it and the job sits `running` forever while the UI polls a row that never moves. SQS redelivers once the visibility timeout lapses (set to 16 minutes, longer than the worker's own 900-second timeout so a redelivery never runs alongside the invocation it replaces), and after a bounded number of attempts moves the message to a dead-letter queue (`BulkDeleteDlq`).

FIFO, not standard, because the message group is the job id: SQS keeps at most one message per group in flight, so two workers can never walk the same job's cursor at once. Content-based deduplication stays off, since a job's continuation messages are byte-identical; the deduplication id is supplied explicitly as `${jobId}:${sequence}`, where `sequence` is 0 for the initial submission and the job's resume count for each hand-off. The advanced resume count is persisted _before_ the continuation is enqueued, because a reused id inside SQS's 5-minute dedup window would silently swallow the hand-off and strand the job. `BulkDeleteDlq` must also be FIFO: AWS requires a dead-letter queue to match its source queue's type, and a standard DLQ on a FIFO source fails the deploy outright (`Dead-letter queue must be same type of queue as the source`).

The worker distinguishes a retryable error from the final attempt using the message's `ApproximateReceiveCount` against `MAX_BULK_DELETE_DELIVERY_ATTEMPTS` (kept in step with the queue's `dlq.retry`). A retryable error on an earlier delivery is left to escape so the message returns to the queue and the next delivery resumes from the checkpoint. Only a non-retryable error (such as a region the org is not provisioned in), or the last delivery before the DLQ, marks the job `Failed`. Swallowing every error into a failed status would turn a transient throttle into a permanently dead job.

### 7. A DLQ watchdog terminates jobs after hard worker failures

The worker marks a job failed from its own `catch` before the last delivery rethrows. That path never runs on a hard kill: a Lambda timeout, an OOM, or the process dying outright bypasses the worker's failure handling entirely. SQS still exhausts the delivery count and drops the message into the DLQ, but the job row is left non-terminal with nothing to move it, and the client polls it forever.

`bulk-delete-dlq-watchdog` closes that gap. It subscribes to the DLQ, and for each message reads the job row and fails any job still in a non-terminal state (using `isTerminalBulkDeleteStatus`, so a job the worker already finalized as `Completed`, `CompletedWithErrors` or `Failed` is left alone). The watchdog is the only thing that guarantees a stalled job reaches a terminal status the UI can stop polling.

### 8. Observability

The DLQ is both the operator signal and the recovery trigger. A message reaching it means a deletion could not complete after every delivery, and the watchdog in decision 7 consumes it to fail the affected job, so a non-empty DLQ is the one thing worth alerting on.

No infrastructure change is needed to emit the signal. The account-wide CloudWatch Metric Stream already forwards all `AWS/SQS` metrics to Grafana Cloud (`AWS/SQS` is in the stream's include filter, the same pipeline the [account-deletion ADR](2026-08-self-serve-account-deletion.md) relies on for its own DLQ depth). What this feature needs is only a Grafana alert rule, which lives in Grafana Cloud outside this repository.

After this PR is deployed, create an alert on `aws_sqs_approximate_number_of_messages_visible_maximum` filtered to `BulkDeleteDlq`'s queue name, threshold `>= 1`. Queue names embed the stage, so this is one rule per environment or a regex over the stage suffix. The alert fires while the queue is non-empty and clears when the watchdog and any manual drain bring it back to zero. This is documented here because the repository otherwise gives no hint the monitoring exists, following the precedent of the [tenant-setup ADR](2026-05-synchronous-tenant-setup-on-first-resource.md).

### 9. The listing UI states truncation and loads one page

The object browser deliberately still loads a single listing page. Looping continuation tokens would pull tens of thousands of rows into a table that is not virtualized. Emptying a large bucket is what the job is for; the browser is for small ad-hoc multi-select deletes.

A prior bug parsed `isTruncated` and then discarded it, so a 20,000-object bucket showed its full count in the tab header above a table of 1000 rows, and "select all" claimed to select every object while reaching only the loaded ones. Truncation is now stated explicitly, and the select-all label says it covers loaded objects only.

The confirmation dialog states no object count, deliberately. The count comes from analytics and lags recent writes, and a stale number on a permanent-delete confirmation is worse than none. The count still drives the progress bar, where lag is harmless, but the progress total is only paired with `deletedCount` when the job is scoped to `Current`. Under the default `AllVersions` scope `deletedCount` includes every version and delete marker, while the analytics total counts current keys only, so pairing them could show "300 of 100" and reach 100% long before the job finishes; the bar renders indeterminate in that case.

## Consequences

### Accepted costs

| Cost                                                                    | Reasoning                                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stalled job is only failed once its message reaches the DLQ           | The watchdog cannot act before SQS exhausts the delivery count. Bounded by the visibility timeout times the retry count; the UI shows `running` until then. |
| `deletedCount` can over-count across two overlapping jobs on one bucket | Cosmetic. Correctness comes from each job owning its row and `DeleteObjects` being idempotent, not from a lock.                                             |
| Emptying reads and rewrites the job row once per 1000-object page       | The row is intentionally on its own table so this write rate does not touch `UserInfoTable`. Finished rows expire by TTL.                                   |
| The browser listing shows only the first page of a large bucket         | The table is not virtualized. Truncation is stated in the UI, and the job is the supported path for large buckets.                                          |

### Deferred risk

**The infra changes have not been deployed.** `BulkDeleteTable`, the `BulkDeleteWorker` function, the FIFO queue and DLQ, the watchdog, the S3 data-plane IAM permissions and the two routes need a real `sst deploy` to confirm, and the `sst-env.d.ts` entries were added by hand rather than generated.

The Grafana alert in decision 8 is created after deployment by an operator; until it exists, a non-empty DLQ is visible only in metrics, not alerted on.

## References

- [Self-serve account deletion](2026-08-self-serve-account-deletion.md) - the same metric-stream pipeline and DLQ-depth signal this job's monitoring reuses.
- [Aurora tenant setup workflow](2026-03-aurora-tenant-setup-workflow.md) - the FIFO-queue-with-DLQ precedent for a resumable background job.
- [Synchronous tenant setup on first resource](2026-05-synchronous-tenant-setup-on-first-resource.md) - the precedent for documenting a Grafana alert in an ADR rather than only in Grafana Cloud.
- [Observability architecture](2026-03-observability-architecture.md) - the metric-stream pipeline that carries `AWS/SQS` metrics to Grafana with no infrastructure change.
