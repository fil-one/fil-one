# ADR: The dashboard activity feed reads the audit log

**Status:** Proposed
**Created:** 2026-10-27
**Ticket:** FIL-1623
**Supersedes:** [`2026-08-audit-log-v1-m2.md`](./2026-08-audit-log-v1-m2.md) §8, and the line on `GET /api/activity` in [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## Context

The audit log v1 ADR kept `GET /api/activity` as a feed synthesized from live
state: one "created" entry per bucket and key that exists now. It expected the two
to disagree once `bucket.created` and `bucket.deleted` landed, and accepted that.

The dashboard now links Recent Activity to the audit page with "View all". A link
from one list to a longer version of it promises the same history, and the
synthesized feed cannot keep that promise: a deleted bucket or key leaves no
entry, nothing ever reads "deleted", and its bucket entries came from a
`ListBuckets` call in every region on each dashboard load.

## Decision

1. **Bucket lifecycle is audited.** `bucket.created` and `bucket.deleted` are
   two-phase events, intent before the storage call and completion after it,
   best-effort like the bucket policy events. A create that fails after the
   storage system made the bucket records the bucket as created.
2. **The feed is a filtered view of the audit log.** It returns completions that
   succeeded for bucket events and S3 key events (`key.created`, `key.rotated`,
   `key.deleted`), newest first, within the 90-day retention window. The
   `key.deleted` a rotation writes for the replaced credential is left out, since
   the key stays live under its new one.
3. **Scope follows the reader's own pages.** Owner and Admin see the whole org's
   events. Every other role sees only the events they acted on, which is never
   wider than what their Buckets and API keys pages list.
4. **"View all" opens the audit page** where that page exists for the reader:
   Owner and Admin in orgs on the organizations beta.

## Consequences

- Every feed row is also a row on the audit page, and the feed no longer calls the
  storage system.
- The feed starts empty for buckets and keys created before this shipped, and holds
  90 days.
- Below Admin, a bucket another member created and shared with the reader does not
  appear, and neither does a revocation another member made to the reader's key.
- `get-activity` reports `AuditQueryDuration` under `route=activity`. The
  `GetActivityDuration`, `GetActivityPhaseDuration` and per-region
  `ListBucketsDuration` metrics are no longer emitted.
