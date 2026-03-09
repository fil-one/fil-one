# ADR: Aurora Tenant Setup Workflow

**Status:** Accepted
**Date:** 2026-03-06

## Context

When a new tenant is detected by any API route, we need to provision them in Aurora via a multi-step workflow (create tenant, then initial setup). This is triggered from Lambda-backed API routes, any of which may be the first to see a new org. Multiple requests for the same org can arrive simultaneously, creating a race condition regardless of how fast the provisioning calls are.

We need the workflow to run out of band (not blocking the API response), retry on failure, resume from the last successful step, and handle concurrent triggers for the same org safely.

## Options Considered

**AWS Step Functions** — Purpose-built for multi-step orchestration with built-in retry and state tracking. Rejected because it adds seconds of latency before execution begins, introduces architectural complexity disproportionate to a short linear workflow, and team experience with it has consistently led to abandoning the approach.

**Async Lambda invocation with DynamoDB state** — Fire a Lambda directly from the route handler. Fastest option, but offers no built-in retry or deduplication. Would require manual synchronization and still leaves the race condition unsolved without additional coordination.

**SQS FIFO queue with DLQ** — Send a message to a FIFO queue, let a consumer Lambda run the steps sequentially. FIFO deduplication solves the race condition, SQS visibility timeout gives us retries for free, and the DLQ provides a clear signal when something is stuck.

**EventBridge** — Event-driven choreography. Rejected as over-engineered for a short linear flow and harder to reason about the current state of any given tenant's setup.

## Decision

Use an **SQS FIFO queue** (`aurora-tenant-setup.fifo`) with a dead letter queue.

Route Lambdas enqueue a message with `MessageGroupId` and `MessageDeduplicationId` both set to the `orgId`.

The FIFO queue guarantees exactly-once processing per deduplication ID within a 5-minute window, so even if multiple API routes fire simultaneously for the same org, only one setup execution runs.

A consumer Lambda reads the tenant's current status from DynamoDB and resumes from whatever step is next. DynamoDB status values describe what has been completed so far: `HYPERSPACE_ORG_CREATED` → `AURORA_TENANT_CREATED` → `AURORA_TENANT_SETUP_COMPLETE`. This naming convention makes it straightforward to insert additional steps later (e.g. between `AURORA_TENANT_SETUP_COMPLETE` and a future final state).

The frontend reads the `auroraTenantReady` boolean from the `/api/me` response (derived from the DynamoDB `setupStatus` field) to show setup progress.

## Consequences

- Race conditions are handled by FIFO deduplication — only one message per org is processed in any 5-minute window.
- Retries are handled by SQS automatically; failed messages land in the DLQ according to the queue's redrive policy and trigger a CloudWatch alarm.
- Resume-from-failure is handled by the DynamoDB status field — the consumer always checks where it left off.
- No additional orchestration services are introduced; SQS and DynamoDB are already in our stack.
- Access key creation is intentionally deferred and can be added as a third step later.