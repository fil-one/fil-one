# FTH S3 Compatibility — Launch Requirements

**To:** FTH (Fortilyx) engineering
**From:** FilOne
**Date:** 2026-07-08

## Context

FilOne runs the industry-standard [ceph/s3-tests](https://github.com/ceph/s3-tests)
compatibility suite against the FTH-backed endpoint
`https://us-east-1.s3.fil.one` before launch. The latest run
(`20260708_122448`, boto3/botocore, SigV4) passes 378 of 559 executed tests.
After excluding failures caused by our own test-key configuration, the items
below are FTH-side behaviors that block launch. Every P0/P1 item was
additionally **reproduced by hand on 2026-07-08** with minimal boto3 calls,
independent of the test suite; representative s3-tests test names are given
per item.

Priorities are tiered against our **initial compatibility run of 2026-02-19**:

- **P0/P1** — worked in the initial run and is now broken (regression);
  fix expected for launch (P0 = most severe).
- **P2** — did not work in the initial run either, or is a
  documentation/confirmation ask; fix or provide written confirmation of
  intended behavior.

---

## P0-1. Zero-byte PutObject returns HTTP 500 AND leaves a phantom object behind

- **Actual:** Any `PutObject` with an empty or absent body fails with
  `InternalError` (HTTP 500), consistently, across retries. **Worse:** the
  failed PUT still creates a phantom entry — the key subsequently appears in
  `ListObjectsV2`, causes `DeleteBucket` to fail with `BucketNotEmpty`, and
  makes conditional `PutObject` with `IfNoneMatch: *` fail with
  `PreconditionFailed` on the SDK's automatic retry (the phantom from the
  first attempt already "exists").
- **Expected:** 200 OK creating a zero-byte object (worked in February and
  April); a failed request must not leave partial state.
- **Impact:** 47 direct test failures plus the conditional-write failures
  (`test_put_object_if_match` et al.), which we verified are downstream of
  this bug — conditional writes with non-empty bodies work correctly.
  Breaks extremely common patterns (directory markers, placeholder files)
  and, via the phantom entries, listing consistency and bucket deletion.
- **Verified live 2026-07-08:** `put_object(Key='zb', Body=b'')` → 500 after
  4 retries; the failed keys then appeared in `list_objects_v2` and blocked
  `delete_bucket` (`BucketNotEmpty`); a control 1-byte PUT succeeded.
- **Tests:** `test_object_head_zero_bytes`, `test_basic_key_count`,
  `test_atomic_dual_write_1mb`, `test_put_object_if_match`.

## P1-2. SignatureDoesNotMatch for object keys containing `+`, space, or `%`

- **Actual:** Correctly SigV4-signed requests (boto3 defaults) for keys such
  as `foo+1/bar`, `quux ab/thud`, or `per%cent` fail with
  `SignatureDoesNotMatch` (HTTP 403).
- **Expected:** Standard SigV4 canonical-URI handling of URL-encoded
  characters (worked in February and April).
- **Impact:** ~17 test failures; real customer keys routinely contain these
  characters. Looks like a canonicalization regression in the gateway.
- **Verified live 2026-07-08:** `foo+1/bar`, `quux ab/thud`, `asdf+b`,
  `per%cent` all → 403 SignatureDoesNotMatch; `under_score-ok` → OK.
- **Tests:** `test_bucket_create_special_key_names`,
  `test_bucket_list_delimiter_percentage`,
  `test_bucket_list_delimiter_whitespace`.

## P1-3. BadDigest on large single-part PutObject (16 MB)

- **Actual:** A 16 MB single-part `PutObject` (correct Content-MD5 computed
  by boto3) fails with `BadDigest`; an 8 MB PUT succeeds. Also seen once on
  a multipart-sourced `CopyObject`.
- **Expected:** 200 OK (worked in February and April).
- **Impact:** 2 test failures; suggests body corruption or digest
  recomputation error above a size threshold between 8 and 16 MB —
  concerning for data integrity.
- **Verified live 2026-07-08:** 16 MB → `BadDigest` (HTTP 400); 8 MB → OK.
- **Tests:** `test_object_copy_16m`.

---

## P2-4. All SSE-KMS operations rejected

- **Actual:** Every `PutObject` / `CopyObject` / `CreateMultipartUpload`
  specifying `ServerSideEncryption: aws:kms` fails — `InvalidArgument`
  without a key id, `InvalidRequest` with one. SSE-S3 (`AES256`) works.
- **History:** did **not** work in the initial February run (P2 per policy),
  worked in April on our previous tenant, broken again now.
- **Impact:** 39 test failures. If SSE-KMS requires per-tenant KMS key
  provisioning, tell us the provisioning step and we will run it; if support
  was removed, we need written confirmation for our launch docs.
- **Verified live 2026-07-08:** as above, with an `AES256` control PUT
  succeeding on the same bucket.
- **Tests:** `test_sse_kms_method_head`, `test_copy_enc[sse-kms-*]`.

## P2-5. PutBucketLogging rejects all destinations

- **Actual:** Every `PutBucketLogging` fails with
  `InvalidArgument: Invalid bucket logging destination`, including a
  same-bucket target.
- **History:** did **not** work in the initial February run (0/6 — P2 per
  policy), worked in April (6/6), broken again now.
- **Impact:** 6 test failures. Fix, or document what a valid destination is.
- **Verified live 2026-07-08:** `put_bucket_logging` with
  `TargetBucket=<same bucket>` → `InvalidArgument` (HTTP 400).
- **Tests:** `test_put_bucket_logging`, `test_bucket_logging_owner`.

## P2-6. SigV2 signatures no longer accepted

- **Actual:** SigV2-signed requests fail with `SignatureDoesNotMatch`
  (HTTP 403).
- **History:** did **not** work in the initial February run (P2 per policy),
  worked in April, broken again now.
- **Impact:** 4 test failures; any customer tooling still issuing SigV2
  presigned URLs breaks. If SigV2 was intentionally dropped, written
  confirmation is sufficient — we will document SigV4-only. Otherwise, fix.
- **Verified live 2026-07-08:** same `put_object` succeeds with SigV4 and
  fails with SigV2 from the same client/credentials.
- **Tests:** `test_cors_presigned_get_object_v2`,
  `test_cors_presigned_put_object_v2`.

## P2-7. Document the permission action model (Delete\* actions are distinct)

- **Observation:** FTH requires distinct actions for delete operations
  (`s3:DeleteBucketTagging`, `DeleteBucketCors`, `DeleteBucketLifecycle`,
  `DeleteBucketEncryption`, `DeletePublicAccessBlock`) where AWS folds them
  into the corresponding `Put*` action.
- **Ask:** publish the complete list of supported permission action names.
  We lost several days to under-scoped keys because the accepted action set
  is undocumented. Not a code change — documentation.

## P2-8. DeleteBucket on buckets with retention-locked objects

- **Actual:** Cleanup of buckets containing objects under GOVERNANCE
  retention fails with `BucketNotEmpty` even when deleting versions with
  `BypassGovernanceRetention` (2 object-lock tests error in teardown).
- **Ask:** confirm whether governance bypass is supported on version
  deletion; if it is, fix the delete path. (Also failed in the April
  baseline — not a regression.)
- **Tests:** `test_object_lock_changing_mode_from_governance_with_bypass`,
  `test_object_lock_changing_mode_from_compliance`.

---

## Verification

We will re-run the full suite upon notice of each fix. To self-verify,
FTH can run ceph/s3-tests (`not fails_on_aws` marker, main + object-lock
passes) against a two-user tenant. We are happy to share our exact
`s3tests.conf` template, the raw pytest JSON from run `20260708_122448`.

**Positive note:** object-lock behavior (39/39), object versioning, delete
markers, checksums, and metadata handling have all improved markedly since
April — those fixes are confirmed and appreciated.
