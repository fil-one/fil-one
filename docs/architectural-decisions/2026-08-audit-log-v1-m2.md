# ADR: Audit log v1 (IAM M2, FIL-1022)

**Status:** Proposed
**Created:** 2026-08-26
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) [§6](./2026-08-organizations-roles-m1.md#6-audit-write-path)

## Context

M1 shipped the audit log and nothing can read it. This design is the read side:
viewing, filtering, and exporting the events of the past 90 days.

An Owner or Admin opens the org's history, filters it by date range, event type,
and the member who acted, and exports the filtered set as a CSV. Retention is 90
days, matching the TTL M1 stamped and FIL-1022's third acceptance criterion,
against a Definition of Done that says one year; the Definition of Done is
corrected rather than the TTL. Scope is the control plane, the events FilOne
mediates: organizations, membership, invitations, keys, and the policy and grant
events FIL-1017 and FIL-1019 add.

## What the code gives us

**A date range is already the sort key.** `AuditKeys.eventSk` builds
`{iso8601}#{eventId}` (`lib/audit.ts`), so a window over an org's history is a
`Query` on `ORG#{orgId}` with a `BETWEEN` on the sort key. Newest-first is
`ScanIndexForward: false`. No index is involved and none is needed for the
dimension the viewer leads with.

**The event vocabulary is a closed union in shared.** `AUDIT_EVENT_TYPES`
(`packages/shared/src/audit.ts`) holds ten types today. FIL-1017 adds
`bucket_policy.created`, `bucket_policy.updated`, `bucket_policy.deleted`,
`bucket_policy.members_changed`, `bucket.created`, and `bucket.deleted`, and
keeps `member.scope_changed` for the `'all' | 'specific'` marker. FIL-1019 adds
`permission_grant.granted`, `permission_grant.revoked`, and
`retention_override.signed`. The envelope lives in shared because the viewer
renders these records field by field.

**An actor's id is an internal UUID.** For `kind: 'user'`, `AuditActor.id` is the
`crypto.randomUUID()` minted at first login (`middleware/auth.ts:404`) and stored
on `SUB#{sub}/IDENTITY`. It is not the Auth0 `sub` and not an email address, and
it resolves to nothing a person recognizes. `actor.email` carries a verified
address captured at write time, put there so the viewer can name a member who has
since been removed.

**A subject names a fragment on purpose.** `AuditSubject` is `kind:id`, and the
`key:` form carries only `auditKeyIdSuffix`: four trailing characters of an S3
access key id, or a RAG key's display prefix. `PROHIBITED_AUDIT_CONTENT` forbids
the log holding a full access key id, so the subject records the same fragment the
details do.

**Two of the ten types are written twice.** `key.created` and `key.deleted` write
an `intent` before the vendor call and a `completion` after it, sharing a
`correlationId`. A crash between the halves leaves a dangling intent, which is the
condition the two-phase shape exists to make visible.

**The permission exists and nothing checks it.** `audit.view` sits in
`packages/shared/src/permissions.ts:52`, granted to Owner and Admin.

**Every handler holds `dynamodb:*` on the audit table.** Handlers reach it through
the blanket `allResources` link, which includes `DeleteItem`. The declaration in
`sst.config.ts` already records this as the one table where a handler's grant
contradicts the append-only claim.

**The console's API client parses JSON and centralizes every error.**
`apiRequest()` (`packages/website/src/lib/api.ts:70`) sets a JSON content type on
every call and interprets 401 step-up, 403, and the 410 account-deleted redirect
in one place. Auth is HttpOnly cookies at `SameSite=Lax`, sent with
`credentials: 'include'`.

**Nothing in the repo writes a CSV.** This is the first one.

**The deletion teardown does not touch `AuditTable`.** `deletion-scrub.ts`
destroys rows in `UserInfoTable`, `OrgTable`, `BillingTable`, and
`RagIndexerTable`, and the vector indexes. An org's audit history outlives the
org by up to 90 days.

**The codebase has no GSI.** M1 considered the first one and refused it.

## Decisions

Eight decisions carry the design:

1. **The viewer queries the org partition and gets its date range from the sort
   key.** No index for the primary dimension.
2. **One GSI on event type**, used when exactly one type is selected. This is the
   codebase's first index, and [§2](#2-the-event-type-index) states why M1's
   objection does not reach it.
3. **The actor filter matches `actor.id` alone.** The console picks a member by
   name and sends the id.
4. **Export is a synchronous CSV response with a hard row cap.** No job table, no
   queue, no bucket.
5. **Export is its own permission and its own route**, declared in the route
   manifest rather than branched in a handler.
6. **The audit grant narrows to `PutItem` and `Query`**, with the
   account-deletion worker the one credential that keeps `DeleteItem`.
7. **Account deletion destroys the org's audit partition.**
8. **The activity feed and the audit log stay separate**, with a stated boundary
   between them.

## What the index cannot reach

DynamoDB backfills a new index only from items that already carry its key
attributes. An event written without `gsi1pk` stays invisible to the index
forever, whenever the index is created.

Events are already being written. The organizations beta gates one thing,
creating an invitation, and the two flows that produce most of the log sit
outside it: `org.created` lands on every signup, and `key.created` and
`key.deleted` land on every access key a customer mints or revokes. The write
path has been in production since it merged, so the log already holds events the
index will never see.

Those events stay unindexed rather than being repaired. A `bin/` script over live
data is the alternative, and what it buys is single-type visibility for a few
weeks of events that an unfiltered query already returns and that the TTL removes
within the quarter. It costs a migration PR, a manual run against each stage, and
the rule that nothing depending on migrated data merges until the counts verify.

The log therefore disagrees with itself for one quarter. A query filtered to a
single event type answers from the index and omits everything written before the
index existed; the same query with no type filter reads the base table and
returns it. Ninety days after the index deploys the difference is gone, and the
viewer says nothing about it in the meantime.

## 1. Reading an org's history

`GET /api/audit` takes a date range, zero or more event types, an optional actor
id, and an opaque cursor. It answers with a page of events, newest first, and the
window it actually read.

The range bounds are ISO-8601 UTC instants, lower bound inclusive and upper bound
exclusive. The sort key is a lexicographic ISO string, so a date-only bound has to
be expanded to a full instant before it reaches DynamoDB; the console does that
expansion when it turns a user's picked dates into a request. Stored timestamps
are UTC and are never localized on the way in or out. The viewer renders local
time with the offset shown, and the CSV emits `createdAt` exactly as stored.

A request reaching past 90 days is clamped to the retention window, and the
response carries the effective window so the console can say that older events
have been removed under the retention policy. Silently returning a quarter to
someone who asked for half a year reads as data loss.

An expired row is dropped at read. DynamoDB deletes items on its own schedule
once their TTL passes and keeps serving them until it gets to them, which can be
48 hours later. The promise made to the customer is 90 days, so both the query
and the export exclude a row whose `ttl` has gone by rather than showing an
auditor events the policy says are already gone.

Page size is 50 and the default window is the full 90 days. An auditor opening the
log wants to see it rather than discover a narrower default after searching for a
change they know happened.

**The handler pages, and the console never sees a partial one.** DynamoDB caps a
Query at 1MB of items read and applies a `FilterExpression` afterwards, so one
Query can match nothing and still return a `LastEvaluatedKey`. AWS's guidance is
to keep issuing requests with that key until a response carries none, and the
read path does exactly that: it loops until it has filled the requested page or
the window is exhausted, and answers only then. A response holds a full page or
the last events in the window, and a cursor comes back only when the page filled
first.

Draining the loop inside the request costs, at worst, reading the whole 90-day
window, which is the price of the unfiltered query and a handful of pages at the
volumes [§2](#2-the-event-type-index) describes. Above the threshold named there,
that stops being true, which is a second reason to revisit it.

## 2. The event-type index

`gsi1pk = ORG#{orgId}#TYPE#{type}`, `gsi1sk = {createdAt}#{eventId}`, projection
`ALL`. Both attributes are written by `commitAudited` and `appendAuditEvent` at
construction, beside `pk` and `sk`.

The partition key stays org-scoped, so a type-filtered query can never read across
orgs. The sort key reuses the base format, so a type filter still gets its date
range from a `BETWEEN` rather than from a scan. The projection is `ALL` because the
item is a few hundred bytes and the point of the index is that one query answers
the request; `KEYS_ONLY` would turn every page into a batch of follow-up reads
against the base table and save almost nothing on write cost at this volume.

The index is used when exactly one type is selected. Zero types or several fall
back to the base partition query with a `FilterExpression`, because DynamoDB
cannot intersect two indexes and a multi-type query would be one index read plus a
filter for the rest. The actor filter is a `FilterExpression` on either path.

**Why the M1 objection does not reach this.** M1 refused a GSI for the
user-to-orgs lookup because every GSI read is eventually consistent and two of
that read's callers made one-way decisions on the answer: a membership the index
had not yet reflected meant a phantom trial or a deleted login. A viewer rendering
90 days of history has no such caller. An event that appears a few hundred
milliseconds late is a row that arrives on the next page or the next refresh, and
nothing downstream acts on its absence.

**What it costs.** The index doubles storage for the table and adds index
maintenance to a write that is already inside the fail-closed `commitAudited`
transaction. That transaction blocks a membership change when the audit write
fails, which M1 accepted deliberately. The index makes the write marginally more
likely to fail, and at control-plane volumes that margin is small enough to take.
It would not be at data-plane volumes, which is a further reason to keep request
logging out of this table.

**Revisit at roughly 100,000 events in a single org's 90-day partition.** Below
that, a full partition read is a handful of pages and the filters cost nothing.
Above it, the base-table fallback for multi-type queries is what degrades first,
and the answer is a second index or a shard suffix in `AuditKeys` rather than a
redesign.

### Alternatives

**No index at all**, filtering type in the same `FilterExpression` as the actor.
Cheapest to build and adequate at today's volumes. Rejected because event type is
the filter an investigator reaches for first, and it is the one dimension with
low enough cardinality to index usefully. Deferring it also costs more than
building it. Every day without the attributes is another day of events a later
index cannot see, and the quarter in which the log disagrees with itself starts
from whenever the index ships.

**An index per dimension**, type and actor both. Rejected because a query can use
only one index and would filter the other dimension regardless, so a second index
would speed up actor-only queries and cost a write on every event.
Actor-only queries are also the rarer case: an investigation usually starts from
what happened rather than from who.

## 3. Filtering by actor

The API filters on `actor.id`, matched exactly. The email is never part of the
match.

The console shows a member picker listing names and email addresses, and sends the
`userId` behind the entry chosen. A person browsing the log neither types an id nor
sees one.

An id is the only stable handle an actor has. It survives an address change, so a
member who changes email keeps one history rather than two. It also stays distinct
when an address is reused: a member who leaves and is later re-invited at the same
address gets a new `userId`, and a filter reading emails would merge two people's
histories into one result.

`actor.email` remains on the event as the verified snapshot taken at write time,
and it is what names the actor in a row and in the CSV. It is a display value here,
read by nothing that filters.

The picker lists everyone who was ever in the org. Current members come from the
roster. Departed members come from a query on the index in
[§2](#2-the-event-type-index) for
`member.removed`, whose subject is `user:{userId}`, and their names and addresses
from a `BatchGetItem` over the `USER#{userId}/PROFILE` rows that removal leaves
untouched. Two small reads, and the membership row is still deleted outright.

The actor in a row is clickable and filters to that actor, so a departed member
is reachable the moment one of their events is on screen.

Someone who deleted their FilOne account is the one actor the picker cannot name,
because the scrub destroys the profile. Their events keep `actor.id` and the
verified address captured at write time, which is what the row and the CSV
show.

## 4. Export

`GET /api/audit/export` takes the same filters as the viewer and answers with the
CSV as its response body.

No job row, no queue, no worker, no bucket. The bulk-delete job exists because
deleting a large bucket takes longer than a request can stay open; an export of
control-plane events does not. A handler drains the same paging loop the viewer
uses, builds the file, and returns it inside the API Gateway timeout.

**Capped at 20,000 rows.** The binding constraint is Lambda's 6MB synchronous
response limit, which at roughly 300 bytes per row lands near 20,000. Exceeding the
cap returns a distinct `ApiErrorCode` telling the caller to narrow the filters. A
truncated audit export is the worst failure this feature has, so the cap fails
loudly and the handler also stops on the byte budget in case a run of large
`details` payloads reaches it first.

**The export applies the viewer's filters.** The use that matters is an
investigator taking evidence for one member or one event type, and an unfiltered
90-day dump is the wrong default for it. The parameters travel into the
`audit.exported` event ([§9](#9-what-this-records)).

**Columns.** A fixed envelope (`eventId`, `createdAt`, `type`, `actorKind`,
`actorId`, `actorEmail`, `subject`, `phase`, `outcome`, `correlationId`) plus one
`details` column holding the payload as JSON. `AuditEventDetails` carries a
different shape per type, and a wide sparse sheet unioning every field of every
type would need a new column each time an event type is added.

**Every field is escaped against formula injection.** A cell beginning `=`, `+`,
`-`, `@`, tab, or carriage return executes when the file opens in a spreadsheet,
and `orgName` and `keyName` are customer-controlled free text. An org named
`=HYPERLINK(...)` would become a live formula in an auditor's Excel. The writer
prefixes those values with a single quote, on top of RFC 4180 quoting, and a test
names the attack. The existing prohibited-content guard watches for credentials
leaving the system and has nothing to say about a payload that executes when the
file is opened.

**Delivery.** A new `apiDownload()` beside `apiRequest()` shares the error-code
handling, reads `response.blob()`, and triggers the save from an object URL. A
plain link would authenticate, since Lax cookies ride a top-level navigation, but
it cannot set `X-Org-Id` and any failure would render raw JSON in a browser tab
instead of reaching the console's error handling.

### Alternatives

**A job written to S3**, polled like a bulk delete, downloaded from a presigned
URL. It is the shape the milestone's Definition of Done implies with its reference
to a bucket for GRC and SIEM consumption. Rejected for v1 because the duration
that justifies job machinery does not exist at control-plane volumes, and because
the export object would be a second copy of the org's audit history with its own
lifecycle, its own access story, and its own teardown obligation. If export
outgrows a synchronous handler it moves to the job shape, and its durable
destination should then be a FilOne-owned bucket on one of the backends rather
than raw AWS S3.

**Continuous delivery to a customer-owned bucket** for SIEM ingestion. Out of
scope. It needs a cross-account access design and a standing delivery contract,
and shipping the download first does not block it.

## 5. Permissions and routes

A new `audit.export` permission joins `audit.view` in the registry, granted to
Owner and Admin.

| Method | Path                | Requires       |
| ------ | ------------------- | -------------- |
| `GET`  | `/api/audit`        | `audit.view`   |
| `GET`  | `/api/audit/export` | `audit.export` |

Two routes rather than one route with a `format=csv` parameter, so the manifest
states each gate declaratively. The `requires: 'in-handler'` escape hatch exists
for routes whose permission depends on the request body, as `presign` and
`set-bucket-rag-enablement` do. This permission depends only on which endpoint was
called. Separate routes also keep the row cap and the `audit.exported` write on the
route that has them.

Both queries are scoped to the org resolved from the caller's membership, never
from a request parameter.

**The auditor path is closed.** M1's open question 2 recorded that the PRD's
"auditor joins as ReadOnly" flow needs ReadOnly to read the log, against a review
thread that narrowed viewing to Admin and above. This design takes the review
thread's answer: an external auditor either holds an Admin seat or receives a CSV
from someone who does.

## 6. Narrowing the audit grant

Handlers get `dynamodb:PutItem` and `dynamodb:Query` on `AuditTable` and `Query`
on its index, replacing the `dynamodb:*` that the shared `allResources` link
grants today. `TransactWriteItems` needs the underlying `PutItem` on each item it
writes, so `commitAudited` keeps working unchanged.

The account-deletion worker is the exception. It destroys the org's audit
partition ([§10](#10-lifecycle)), so it holds `DeleteItem` and no other
credential in the system does. It already carries its own link list rather than
the blanket one, which is where the grant goes.

This is the difference between an application that cannot delete an audit entry
and an application that merely does not. The teardown worker is the one place
where deleting is the point, and it deletes whole partitions of orgs that have
asked to be erased.

## 7. The console

The viewer lives in the organization settings area.

**A row is a label, an actor, a subject, and a time.** Labels come from an
exhaustive record keyed by event type, following `ACTIVITY_ACTION_LABELS` and
`getActivityActionLabel` (`packages/shared/src/api/dashboard.ts`): the record makes
a new event type fail to compile without copy, and the runtime fallback humanizes
the verb after the last dot, so a console that does not yet know a type renders
something instead of a blank cell.

**Details expand.** A row opens to show its `details` payload as key and value
pairs, rendered generically rather than by a per-type template. Without it the
viewer can say that a role changed but not what it changed to, and the reader
would have to export a CSV to answer the obvious question.

**User subjects resolve against the same roster the picker uses.** `user:{userId}`
is an opaque UUID, so the console renders a name from the current members and the
departed ones behind them ([§3](#3-filtering-by-actor)), and falls back to the raw
id only for an account
that has been deleted. Denormalizing an email onto the subject at write time was
the alternative; it changes the envelope for every user-targeted event type and
inherits the same staleness `actor.email` already has.

**Key subjects stay fragments.** `key:{suffix}` is deliberate and matches what the
console shows elsewhere, so nobody should later widen it into a full access key id.

**`retention_override.signed` is labelled as a signing.** The event records that
a URL was signed, and the URL is redeemed at the vendor where its use cannot be
logged. One event covers a URL nobody redeems and a URL redeemed four times, so a
label reading as a deletion would offer the log as a record of what happened to
an object, which for this event type it is not.

**Both `key.created` halves render as rows.** An intent and its completion appear
as two lines sharing a correlation id. The dangling intent left by a crash between
a vendor call and its local write is the most operationally interesting row the log
can hold, and collapsing each pair into one line would hide it.

## 8. The activity feed stays what it is

`GET /api/activity` remains a synthesized convenience feed for the dashboard,
readable by every role and assembled from live state. Its bucket entries come from
a `ListBuckets` call rather than from history (FIL-1017). The audit log is the
org's recorded history, readable by Owner and Admin, and written in the same
transaction as the mutation it describes.

The two will show overlapping events once FIL-1017 lands `bucket.created` and
`bucket.deleted`, and they can disagree. A bucket created and then deleted appears
twice in the audit log and not at all in the activity feed, because the feed reads
what exists now. That difference is the subject of an eventual support ticket, and
it is a property of the two designs rather than a bug in either.

## 9. What this records

`audit.exported` joins the event union: single-phase, written after the CSV is
assembled and before the response returns, carrying the filter parameters and the
row count.

It is the first event type written on a read path, so `GET /api/audit/export`
mutates where no other `GET` does. It is also the highest-signal action in the log,
because it is the one that takes the org's security history out of the system.

The event means that an export was produced for this actor with these filters. It
does not mean the bytes arrived: a client that disconnects mid-transfer leaves a
record of an export nobody received. Treating response delivery as an external side
effect and giving the type the two-phase shape would close that gap. Nothing acts
on the distinction, so the type stays single-phase.

## 10. Lifecycle

Account deletion destroys the org's audit partition. `deletion-scrub.ts` gains
`AuditTable` beside the four tables it already tears down, and the worker gains
the `DeleteItem` grant that [§6](#6-narrowing-the-audit-grant) withholds from
everything else.

Today the partition is untouched and an org's history survives the org by up to 90
days. The self-serve deletion design exists to make deletion true, and a full
record of who belonged to an org and what they did is a hole in that.

The deletion design usually keeps a row and empties it; an audit event is
destroyed instead. Its personal data is `actor.email` and the addresses on the
invitation payloads, and both sit in the row body, so emptying them means
rewriting stored events. That contradicts append-only further than removing them
does. The same design already destroys outright wherever a scrub would be a
rewrite or a structural no-op, which is how it treats credential rows and
`RagIndexerTable`.

## 11. Observability

The read path emits query duration, pages read, and rows returned as EMF; the
export path emits duration and row count. No SLO yet.

The number worth watching is pages read against rows returned. Latency degrades
late and obviously; a filtered query burning many pages to produce few rows is what
says an org has crossed the threshold in [§2](#2-the-event-type-index), and it says
so before anyone
complains.

## Open questions

1. **What an append-only claim covers.** After this design, no product route can
   modify or remove an entry, and the only credential that can delete one is the
   account-deletion worker, which removes a whole partition when an org is torn
   down and can do nothing finer ([§6](#6-narrowing-the-audit-grant)). Writes are
   create-only and transactional, point-in-time recovery is on for staging and
   production, and rows expire at 90 days by TTL. There is no tamper-evidence: M1
   left Merkle roots, KMS signing, and proof endpoints behind, and AWS
   account-level access sits outside the boundary. Whether a security reviewer
   accepts that as append-only is unanswered, and answering it before a review is
   cheaper than during one.
2. **Whether 90 days survives contact with a customer.** The Definition of Done
   asked for a year and this design says 90. A customer promised a year in a
   security review will find the gap, and the fix at that point is raising the
   TTL.
3. **What the viewer does when an org has more history than the index expects.**
   [§2](#2-the-event-type-index) names 100,000 events in a partition as the point
   to revisit and nothing measures it. The metric in
   [§11](#11-observability) is what would turn that number from a guess into
   an observation.

## Out of Scope

Data-plane access logging: object reads and writes, and SigV4 request records.
Its volume is four or five orders of magnitude higher, and an audit write failure
blocks the mutation that triggered it, so a table carrying request logs would take
membership changes down with it.

Continuous export for SIEM ingestion, and any cross-account delivery.
[§4](#4-export) records
what would change if export outgrows a synchronous handler.

Tamper-evidence in every form: hash chains, signing, proof endpoints, and any
cryptographic immutability claim.

Retention beyond 90 days, and any archive that would hold events after the TTL
removes them.

## References

- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)
  [§6](./2026-08-organizations-roles-m1.md#6-audit-write-path), the write path this reads.
- FIL-1017, which adds the `bucket_policy.*` events, defines `bucket.created`
  and `bucket.deleted`, and puts policy ids on `member.invited` and
  `invite.accepted`.
- FIL-1019, which adds `permission_grant.granted`, `permission_grant.revoked`,
  and `retention_override.signed`.
- `packages/shared/src/audit.ts`, the envelope and the retention constant.
- `packages/backend/src/lib/audit.ts`, the key builders and the two write
  guarantees.
