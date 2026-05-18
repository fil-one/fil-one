# Migration: remove the SQS-based Aurora tenant setup pipeline

**Date:** 2026-05-13
**Status:** Pending — execute after the queue has drained.

## Context

The synchronous tenant-setup rework (FIL-323) moved Aurora tenant provisioning
inline into the bucket and access-key handlers. The SQS pipeline that drove
tenant setup before that change is now unused by all new requests. However,
the consumer Lambda is left in place during this transition so any in-flight
messages from before the deploy can drain naturally.

This document is the follow-up checklist for removing the SQS infrastructure
once it's quiet.

See: [ADR 2026-05-13-synchronous-tenant-setup-on-first-resource.md](architectural-decisions/2026-05-13-synchronous-tenant-setup-on-first-resource.md).

## Prerequisites

After the FIL-323 deploy completes, AWS replaces all Lambda instances within
minutes; no new code paths send to the queue. The remaining wait is just for
in-flight messages already in the queue to drain. Confirm all of the
following are true a few hours after the production deploy (longer if the
queue had a visible backlog at deploy time):

1. **Queue depth is zero.** Check
   `aws_sqs_approximate_number_of_messages_visible_maximum` for
   `AuroraTenantSetupQueue` in Grafana — should be flat at 0.
2. **DLQ depth is zero.** Same metric on `AuroraTenantSetupDlq`. If non-zero,
   triage and clear the DLQ before proceeding.
3. **No new sends.** Confirm `triggerTenantSetup` is not called anywhere
   (search the codebase). The only files that referenced it after FIL-323 are
   the now-deleted lines in `auth.ts` and `get-me.ts`.

## Steps

1. Delete the consumer Lambda handler and its tests:
   - `packages/backend/src/handlers/aurora-tenant-setup.ts`
   - `packages/backend/src/handlers/aurora-tenant-setup.test.ts`
2. Delete the SQS-send helper and its tests:
   - `packages/backend/src/lib/trigger-tenant-setup.ts`
   - `packages/backend/src/lib/trigger-tenant-setup.test.ts`
3. Remove the SQS resources and consumer Lambda from `sst.config.ts`:
   - `AuroraTenantSetupDlq` (lines ~99-101)
   - `AuroraTenantSetupQueue` (lines ~103-108)
   - `tenantSetupQueue` from the `allResources` array
   - The `AuroraTenantSetup` Lambda block (lines ~664-690)
   - `tenantSetupQueue.subscribe(...)` call (line ~692)
4. Remove the now-orphan import paths in `packages/backend/src/handlers/get-me.ts`
   (already done in FIL-323) and `middleware/auth.ts` (already done in FIL-323).
5. Run `pnpm --filter @filone/backend test` and `pnpm typecheck` — both must
   pass.
6. Deploy to staging, confirm the SQS resources are gone in the AWS console,
   then promote to production.

## Rollback

The SQS queue is not destructive to remove (no data loss; the queue is empty
by precondition). To roll back, revert the migration commit and redeploy —
the queue will be recreated empty.

## Out of scope

The Grafana alert on `aws_sqs_approximate_number_of_messages_visible_maximum`
for `AuroraTenantSetupQueue` should be removed in the same change. Add the
new Grafana alert on `StuckAuroraTenantSetupCount` (per the new ADR and
runbook) before deleting the SQS alert.
