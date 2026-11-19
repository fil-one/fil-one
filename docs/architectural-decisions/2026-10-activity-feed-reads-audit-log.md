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
   storage system made the bucket records the bucket as created. A storage call,
   bucket or policy, that times out, is cut off by the request deadline, or loses
   its connection after sending writes no completion: the storage system may
   still have done the work, and an intent with no completion is how the log
   records an ending it never saw. A refusal that merely arrives after the
   deadline still records `failed`.
2. **The feed is a filtered view of the audit log.** It returns completions that
   succeeded for bucket events and S3 key events (`key.created`, `key.rotated`,
   `key.deleted`), newest first, within the 90-day retention window. The
   `key.deleted` a rotation writes for the replaced credential is left out, since
   the key stays live under its new one.
3. **The feed is for Owner and Admin.** It previews the audit page, so it takes
   the same permission, `audit.view`, and shows the whole org's events. Other
   roles get no Recent Activity card. Below Admin the feed could only show the
   reader's own actions, which their Buckets and API keys pages already list, and
   a ReadOnly member, who can change nothing, would always see it empty.
4. **"View all" opens the audit page.** Everyone who sees the card may open it.
5. **Buckets created outside the console are merged in.** Beside the audit read,
   the feed lists the org's buckets in every provisioned region. A bucket created
   within the window that has no matching `bucket.created` (same name and region,
   stamped no more than five minutes before the bucket) gets a row labelled
   "Created outside the console", naming nobody. A bucket made before the console
   started writing `bucket.created` (`BUCKET_CREATIONS_AUDITED_SINCE`, the deploy
   date of this change) gets a plain "Created" row instead, since the log could
   not have recorded it either way. Bucket Intelligence companion
   buckets are left out, as on the Buckets page. A region that fails to list is
   logged and skipped.
6. **The feed's read is bounded.** It runs on every dashboard load, so it reads
   each event type it shows on the `byType` index, in parallel, at most three
   pages of 100 rows per type, under the request deadline. Reading the org
   partition would examine every membership and policy row too. Every match newer
   than the point any read stopped early is returned to the handler, which merges
   the listed buckets in, cuts both at that point and then to the limit.

## Consequences

- Every feed row from the log is also a row on the audit page. Rows for buckets
  created outside the console are not, since the log never saw those creations.
- The feed still calls the storage system once per region per dashboard load, as
  the synthesized feed did, to find those buckets.
- Members and ReadOnly lose the card. Their history of their own changes stays on
  the Buckets and API keys pages.
- Key events start with this change and hold 90 days. Buckets made before it
  appear as plain "Created" rows for the rest of the window, as they did in the
  synthesized feed.
- `BUCKET_CREATIONS_AUDITED_SINCE` must not be earlier than the production
  deploy. If it is, a bucket created in the console between the two reads as
  created outside the console.
- A bucket deleted with the S3 API directly, such as from the `aws` CLI, leaves
  nothing to list, so its deletion appears neither in the feed nor on the audit
  page.
- A bucket created through the console whose `bucket.created` write failed (the
  write is best-effort) reads as created outside the console.
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
  `ListBucketsDuration` metrics are no longer emitted; the bucket listing runs as
  the `listBuckets` request step, so a deadline cut names it.
