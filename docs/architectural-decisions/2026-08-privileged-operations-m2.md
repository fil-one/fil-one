# ADR: Bucket lifecycle leaves the S3 API (IAM M2, FIL-1019)

**Status:** Stub. The bucket-lifecycle half is argued below and decided; the
retention-bypass half of FIL-1019 is not yet written.
**Created:** 2026-08-26
**Ships before:** [`2026-08-member-bucket-scope-m2.md`](./2026-08-member-bucket-scope-m2.md)
(FIL-1017), which depends on it

## Context

On `us-east-1` a customer's own access key can delete a bucket, and nothing in
FilOne learns that it happened. The Management API has six paths and none of
them is an event or audit surface, an S3 `ListBuckets` returns a name and a
creation date, and no contract exposes which access key acted. The same region
lets a deleted bucket name be claimed again, measured on staging on 2026-08-26
(`bin/bucket-name-reuse-probe.ts`). So a customer credential deletes a bucket
unobserved, recreates the name, and the org's record of what happened is a
listing that shows a bucket which looks original.

Where bucket lifecycle happens depends on the backend. On Aurora both
operations are Portal API calls (`createAuroraBucket` and `deleteAuroraBucket`,
reached through `createPortalClient`), so only FilOne can make them and the
region has no exposure. FIL-1019 records the same fact from the vendor side, and
`supportsBucketManagement` already excludes the region. On FTH and Forge they
are S3 data-plane operations: the console performs them with the tenant's
`filone-console` credential, and a user key carrying `s3:CreateBucket` or
`s3:DeleteBucket` performs the identical operation without FilOne seeing it.

## Decisions

### 1. Customer keys stop carrying `CreateBucket` and `DeleteBucket`

In every region, until an orchestrator can report that a bucket's lifecycle
changed and which key changed it. The `filone-console` key keeps both actions,
so the console's own bucket lifecycle is untouched. What goes away is a customer
credential creating or deleting a bucket.

The change is small and reversible: `BUCKET_PERMISSIONS`
(`packages/shared/src/api/access-keys.ts`) stops being offered,
`CreateAccessKeySchema` refuses the two values, the console drops the two
checkboxes, and `supportsBucketManagement` has nothing left to gate.
Re-enabling is the same edit backwards, with no migration either way. A denied
attempt answers with the vendor's `AccessDenied`, which is the correct S3 error
FIL-1019's third acceptance criterion asks for.

**What it costs.** Customers scripting bucket lifecycle against the S3 API lose
that, and the product ships it today in the FTH and Forge regions. Keys already
carrying the two permissions keep them until revoked, so this is only as
complete as the legacy transition that retires them (FIL-1020).

**Aurora is already built this way**, which is the argument that this asks FTH
and Forge to match a shipped region rather than inventing a policy. It also
moves the product toward the uniform-regions answer to FIL-1024's open question
of whether capabilities should differ by region at all.

### 2. Bucket lifecycle becomes an audit event

With every create and delete passing through a handler, `bucket.created` and
`bucket.deleted` become writable for the first time, carrying the acting user
and the region. FIL-1017 §5 depends on the same handler for its auto-grant and
its revocation sweep, and its §4 records that `GET /api/activity` renders bucket
creations from a live `ListBuckets` rather than from history. A real event log
is what replaces that.

## Still to write

- The retention-bypass half of FIL-1019: an explicit grant, off by default,
  conferred only by Owners, with every grant, revocation, and use audit-logged.
- The in-product and in-docs statement of the known limit: on Aurora and FTH,
  direct customer keys cannot be denied bypass at the provider.
- Console messaging for denied attempts that are not API-shaped.

## Open questions

1. **What lifts decision 1.** An orchestrator surface reporting bucket lifecycle
   with the acting `accessKeyId`, on the two backends that need one. On Forge
   that is the same Hilt work the rest of M3 needs (FIL-918's permission
   read-back); on FTH it is a vendor ask. Aurora needs nothing, having never had
   the exposure. It is the same ask that closes the `ListBuckets` question in
   FIL-1017 §7, which is the argument for putting them in one message.
2. **Forge's name policy is untested.** `eu-central-3` has the S3 data-plane
   exposure and its answer to a recreated bucket name is unknown, so it may
   carry both halves of the `us-east-1` hazard or only one.
