# ADR: Audit log v1 (IAM M2, FIL-1022)

**Status:** Stub. M1 shipped the write path; the viewer, export, and retention
are undecided.
**Created:** 2026-08-26
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) §6

## Context

M1 shipped `AuditTable` and the write path: pk `ORG#{orgId}`, sk
`{iso8601}#{eventId}`, a TTL attribute stamped at append, a typed actor
(`{ kind: 'user' | 'system' | 'connection', id, email? }`), and two write
guarantees. Pure-DynamoDB mutations go through `commitAudited`, one
`TransactWriteItems` spanning the mutation and a create-only event put.
Mutations with an external side effect write an intent event before the vendor
call and a completion event after it, correlated by id.

Events exist and nobody can read them. FIL-1022 is the read side.

Other work adds to the event set as it lands. FIL-1017 §9 defines
`member.scope_changed` and puts the scope on `member.invited` and
`invite.accepted`. FIL-1019 defines `bucket.created` and `bucket.deleted`, which
become writable once bucket lifecycle passes through a handler.

## Still to write

- **The viewer.** Filter and search dimensions, and what a 90-day window looks
  like for an org with one member versus fifty.
- **CSV export.** The project's Definition of Done also asks for export to a
  bucket for GRC and SIEM consumption, which FIL-1022's own acceptance criteria
  do not mention.
- **Visibility.** FIL-1022 says Owner and Admin. M1's open question 2 records
  that the PRD's auditor-joins-as-ReadOnly path needs ReadOnly to see the log,
  and that the registry constant is a one-line change. The product answer
  decides the audience.
- **How `GET /api/activity` and the audit log relate.** M1 keeps the activity
  feed as a synthesized convenience feed and refuses to relabel it as audit.
  FIL-1017 §4 records that its bucket entries come from a live `ListBuckets`
  rather than from history. Two surfaces showing overlapping histories with
  different guarantees needs a decision about what each one is for.

## Open questions

1. **Retention is 90 days or a year, depending on where you read.** M1 shipped a
   90-day TTL, FIL-1022's third acceptance criterion says 90-day retention, and
   the project's Definition of Done says one year. The TTL is deleting rows now,
   so no org that exists today can reach a year. Decide it before the viewer
   ships, because a customer who sees 90 days of history and is promised a year
   in a security review will find the gap.
2. **What an append-only claim covers.** FIL-1022 asks for no product surface
   that can edit or delete entries, and no cryptographic-immutability claim
   anywhere. M1 left behind Merkle roots, KMS signing, and proof endpoints.
   Whether a security reviewer accepts a TTL-bearing DynamoDB table as
   append-only is a question to answer before the first review rather than
   during one.
