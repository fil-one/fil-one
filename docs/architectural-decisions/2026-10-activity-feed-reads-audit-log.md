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
   storage system made the bucket records the bucket as created. A storage call
   that times out, or outlives the request deadline, writes no completion: the
   storage system may still have done the work, and an intent with no completion
   is how the log records an ending it never saw.
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
5. **The feed's read is bounded.** It runs on the dashboard for every role, so it
   reads each event type it shows on the `byType` index, in parallel, at most three
   pages of 100 rows per type, under the request deadline. Reading the org
   partition would examine every membership and policy row too, and for a reader
   whose filter matches little, the whole 90 days on each dashboard load.

## Consequences

- Every feed row is also a row on the audit page, and the feed no longer calls the
  storage system.
- The feed starts empty for buckets and keys created before this shipped, and holds
  90 days.
- The audit log records bucket changes made through the console. A bucket created
  or deleted with the S3 API directly, such as from the `aws` CLI, appears on the
  Buckets page but not in the feed or on the audit page.
- Below Admin, a bucket another member created and shared with the reader does not
  appear, and neither does a revocation another member made to the reader's key.
- "Their own" means the events the reader acted on, whatever their role at the
  time. An Admin demoted to Member keeps seeing the bucket and key changes they
  made as Admin, including to other members' keys, because that is their own
  history. Narrowing it to what the reader can reach today would need a storage
  call per row.
- A bucket created or deleted by a request that timed out never appears in the
  feed, which shows completions only; the audit page shows its intent.
- Key events written before the `byType` index existed are not in the feed, the gap
  [the audit log ADR](2026-08-audit-log-v1-m2.md#what-the-index-cannot-reach)
  describes. It closes as the TTL removes those events.
- A reader whose matches are spread thin may see fewer than five rows: once a type's
  page budget runs out, the feed leaves out older events it cannot order against
  that type's unread ones.
- `get-activity` reports `AuditQueryDuration` under `route=activity`. The
  `GetActivityDuration`, `GetActivityPhaseDuration` and per-region
  `ListBucketsDuration` metrics are no longer emitted.
