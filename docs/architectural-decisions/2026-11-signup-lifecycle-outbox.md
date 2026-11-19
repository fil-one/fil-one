# Committed signup outcomes for Audit Broker (sc-455)

This staging-only integration records a new Organization's signup in the same
DynamoDB transaction that creates its identity, profiles and membership. A
dedicated outbox stream publishes the committed outcome to Audit Broker's
dedicated lifecycle bus. Both provisioning and capture default off. Existing
staging and production resources and signup behavior remain unchanged until
explicitly provisioned and activated.

The customer audit log cannot be the delivery source: signup deliberately
retries without the customer audit event during an audit-only failure. The
lifecycle outbox is part of the underlying mutation items, so that fallback
retains the exact lifecycle row. When capture is enabled, an outbox failure
fails the transaction instead of creating an unrecorded Organization. This is
an explicit canary tradeoff, not a change to the default signup policy.

## Contract and privacy

The source is `filone.identity`, detail type `filone.lifecycle.v1`, event type
`organization.signup`, schema version 1. The Organization ID comes from the
trusted account-creation service. The event ID is a stable SHA-256-derived
identifier for this Organization's signup. `occurred_at` is the account-creation
operation's timestamp; it is not claimed to be a server-assigned commit clock.
Only a committed transaction produces a stream INSERT. Concurrent deliveries
or a lost EventBridge response retain the same event identity and payload.

An optional email domain is derived only from the email already verified by
Auth0. Full emails, actor IDs, IP addresses, auth tokens, signed URLs, request
bodies and arbitrary metadata have no fields in this outbox. Signup precedes
provider provisioning, so this producer does not invent an Observed Tenant
mapping. Subsequent authoritative producer milestones must supply verified
provider-to-Organization correlation when available.

The publisher validates the small allowlisted contract before delivery. A
successful EventBridge HTTP request is insufficient: a failed entry remains a
failed stream sequence. DynamoDB checkpoint retries can redeliver later
successful records; broker source/event-ID deduplication handles this normal
at-least-once delivery. TTL deletions and record modifications do not emit new
outcomes. Errors and aggregate EMF metrics contain no payload or identifiers.

## Storage, permissions and failure handling

The dedicated outbox uses DynamoDB managed encryption, 180-day TTL, point-in-time
recovery and deletion protection. Application functions receive only PutItem
on that table via a narrowed writer link. They do not receive the publisher's
EventBridge authority or outbox read/delete privileges. The dedicated publisher
role can read only this stream and put only `filone.identity` /
`filone.lifecycle.v1` on the exact staging broker bus. DynamoDB ListStreams has
no resource-level authorization, so its required wildcard is confined to this
publisher role; stream record reads remain scoped.

The publisher is prebundled Python 3.12 through the normal `createFn` helper,
retaining the existing log-forwarding integration. boto3 comes from the Lambda
runtime; no new production Node dependencies are introduced. The test-only
Python dependencies are pinned and CI explicitly runs their tests.

The event source mapping reports partial failures, bisects failed batches and
retries at most ten times or for 23 hours. Exhausted batches go to a dedicated
private S3 archive containing the **privacy-limited outbox records**, not the
raw customer audit log. The archive blocks public access and non-TLS requests,
uses explicit AES-256 server-side encryption, expires records after 14 days,
and refuses forced deletion. Publisher destination permissions bind the bucket
and its owning account. Stream failure retention is independent of the outbox's
180 days. A repair must preserve the original payload and identity; do not
fabricate a newer occurrence time to bypass retention.

PublishFailures, stream IteratorAge and DestinationDeliveryFailures alarms go
to an explicitly supplied, reviewed staging SNS topic. Verify a real subscriber
receives a controlled failure before capture is enabled. The outbox contains
no delivered flag: stream checkpointing is delivery state, and a retained row
alone does not prove that the broker accepted it.

## Staging activation and acceptance

1. Review a staging-only plan with
   `FILONE_LIFECYCLE_PUBLISHER_ENABLED=true`,
   `FILONE_LIFECYCLE_CAPTURE_ENABLED` absent/false, and
   `FILONE_LIFECYCLE_ALARM_TOPIC_ARN` set to an existing reviewed staging topic.
   Provision resources with capture still off. Production, local and ephemeral
   stages reject the publisher flag. Capture without the publisher flag also
   fails configuration.
2. Record the output `lifecycleProducerRoleArn`. In the broker's staging module,
   bind this exact role to `filone.identity` with only `organization.signup`
   allowed and provision the lifecycle receiver through its Terraform Makefile.
   Check live IAM, KMS, dedicated bus/rule/Lambda binding and failure monitoring.
3. Verify the publisher role cannot put a billing source, wrong detail type or
   provider S3 event, and that unrelated identities cannot put lifecycle events.
   Verify the existing alarm topic and archive controls. No production resources
   or production producer trust should change.
4. With an agreed disposable signup fixture, enable
   `FILONE_LIFECYCLE_CAPTURE_ENABLED=true` on staging and perform an ordinary
   signup. Query the authoritative product profile and broker Organization
   timeline. Verify matching opaque Organization/event IDs and the optional
   domain; retain aggregate-only evidence. The broker's IAM-authenticated
   `scripts/lifecycle_query.py` supplies a read path after its read policy is
   deliberately attached to the acceptance operator.
5. Replay the identical outbox stream record and simulate an accepted delivery
   whose response is lost. Verify one retained broker event. Exercise an
   audit-only failure and an outbox failure using designated fixtures; the
   former must retain the lifecycle record and the latter must create no
   partial Organization. Verify failed-entry retry, alarm notification and S3
   failed-batch retention without exposing payloads.
6. Capture may be rolled back by setting its flag false. Retain the publisher
   flag/resources while reviewing/draining existing records. Removing the
   publisher flag would request deletion of protected durable resources; that
   is not the rollback procedure. No automatic historical backfill occurs.

Local tests are not this live acceptance. This change completes the initial
signup producer implementation, not sc-455: trial, first bucket/presign,
payment, flag/restriction/restoration producers, verified tenant mapping,
broader schema requirements, operator console timeline and live delivery,
encryption/replay/retention evidence remain separate required work. No raw
presigned-URL generation audit logging is reintroduced.
