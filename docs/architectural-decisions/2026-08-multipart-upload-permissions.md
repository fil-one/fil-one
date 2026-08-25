# ADR: Multipart-upload permissions on FTH access keys

**Status:** Accepted
**Date:** 2026-08-25

## Context

A customer in us-east-1 gets `403` from `ListMultipartUploads` and `AbortMultipartUpload`. Their key can start a multipart upload and upload parts, so a large upload that fails partway leaves parts behind that the customer can neither enumerate nor clean up.

FTH keys are built from two tables in `packages/backend/src/lib/fth/fth-orchestrator.ts`: `FTH_BASE_PERMISSIONS` maps each FilOne permission to S3 actions, and `FTH_GRANULAR_PERMISSIONS` maps the granular ones. Neither emits `s3:ListBucketMultipartUploads`, `s3:AbortMultipartUpload`, or `s3:ListMultipartUploadParts`, so no FTH key has ever carried them. The per-tenant console key (`FTH_FULL_PERMISSIONS` in `fth-tenant-setup.ts`) lacks them too, which blocks the same operations from the console.

Aurora is unaffected: its portal takes coarse access types rather than S3 action strings, and its own contract documents the multipart actions as part of Read, Write and List (`packages/aurora-portal-client/aurora-portal.swagger.json`). The Management API used by Forge has no abort or list-parts action in its contract at all.

## Decisions

### 1. Multipart actions ride along with the existing permissions

FTH keys grant the three actions through the FilOne permissions the customer already selects, with no new user-facing permission:

| FilOne permission | Added S3 action                 |
| ----------------- | ------------------------------- |
| Read              | `s3:ListMultipartUploadParts`   |
| Write             | `s3:AbortMultipartUpload`       |
| List              | `s3:ListBucketMultipartUploads` |

This is the grouping Aurora already applies, so a key with the same permissions behaves the same in either region and the permission model stays one model rather than one per vendor. Listing in-progress uploads is a bucket-listing operation, aborting one destroys data the way a `PutObject` overwrite does, and reading the parts of an upload reads object data.

Forge is unchanged. Its contract has `ListBucketMultipartUploads` but no counterpart for abort or list-parts, so a Forge key cannot be given the full set; wiring in the one available action would produce a third grouping to reason about. Forge is staging-only today, and this waits for the contract to grow.

### 2. Existing keys are left alone

Only keys created after this change carry the new actions. Nothing rewrites the permissions of keys already issued, because the customer-visible permission set they were created with has not changed and a silent widening of an existing credential's authority is not something to do on their behalf. The customer re-creates their key to pick the actions up.

### 3. The console key is minted as `filone-console-v2`

`FTH_FULL_PERMISSIONS` gains all three actions, and the per-tenant console key is created under the name `filone-console-v2` (`FTH_CONSOLE_KEY_NAME`). FTH requires access-key names to be unique within a tenant, so an existing tenant cannot have its `filone-console` key replaced in place: the new key is created alongside the old one, SSM is repointed at it, and the v1 key is deleted days later once warm Lambda containers have recycled. Both keys are valid throughout, so no console operation fails during the rotation.

The idempotency key for the create call becomes `console-key-v2-${tenantId}` in both the tenant-setup path and the rotation script. Replaying the previous key with the new payload (new name, new actions) would 409 permanently, which would strand any tenant whose setup crashed between the key creation and the `fthTenantId` write. The FTH client id is unique within the FTH deployment that every stage shares, so it identifies the target on its own: neither the stage nor the storage-user id adds anything, and the storage user is itself created idempotently per tenant.

The storage user's `userCode` stays `filone-console`. It is what `fthOrchestrator` looks the user up by, and the user itself is not being replaced.

### 4. The console-credentials cache has no TTL

`getConsoleS3Credentials` (`packages/backend/src/lib/s3-credentials.ts`) caches the SSM value for the process lifetime. A rotation therefore takes effect per Lambda container as containers recycle, which can take hours. Adding a TTL would buy faster propagation for an event that happens roughly never, at the cost of an SSM read on the expiry of every entry. Waiting is cheaper, and it is safe because the old key keeps working until `prune` deletes it.

### 5. Existing FTH tenants are rotated by an operator script

`bin/fth-console-key.ts rotate <stage>` walks every org with an `fthTenantId`, creates the v2 key against its `filone-console` storage user, and writes the credentials to `/filone/<stage>/fth-s3/access-key/<tenantId>`. `prune` deletes the v1 key afterwards. It skips an org whose SSM-referenced key already carries the three actions, so a re-run and a tenant provisioned after this change both cost one listing call.

Between `rotate` and `prune`, each FTH tenant holds one extra access key. That counts against the tenant's key limit, and the console's usage view subtracts a fixed one system key per region, so it undercounts the customer's own keys by one until the prune.

### 6. The one-off granular-permissions backfill scripts are deleted

`bin/backfill-access-key-granular-permissions.ts` and its revert counterpart each inline a copy of the permission map. They served a one-time migration that is long done, and keeping them means keeping two more copies of a map that this change already edits in two places.

## Consequences

### Accepted costs

| Cost                                                                 | Reasoning                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Customers with existing keys must create a new key to abort uploads  | The alternative widens the authority of a credential in place, without the customer asking.                                           |
| Every FTH tenant holds two console keys between `rotate` and `prune` | FTH names must be unique, and both keys valid is what keeps the console working while containers recycle.                             |
| The usage view undercounts customer keys by one during that window   | It subtracts a fixed one key per region rather than matching by name. Correcting it for a temporary state is not worth a code change. |
| Forge keys still cannot abort or list parts                          | Its contract has no such action. Adding the one action it does have would create a third grouping to explain.                         |

### Open items

The prod rotation needs AWS credentials that can write SSM. Production logins have been read-only so far, so how that run gets write access is unresolved; the script's header states it.

Nothing in this repository proves FTH accepts these three action strings. Its action vocabulary already differs from Aurora's in places (`s3:ListObjectVersions`), and a rejected string would fail new-tenant setup, not just key creation. A staging run that creates, lists, aborts and re-lists a multipart upload against `us-east-1.fortilyx.com` confirms the strings before they reach production.

## References

- [Service orchestrator and Management API](2026-04-service-orchestrator-management-api.md) - why FTH, Aurora and Forge are behind one orchestrator interface with per-vendor permission mapping.
- [Synchronous tenant setup on first resource](2026-05-synchronous-tenant-setup-on-first-resource.md) - the tenant-setup path that mints the console key and writes it to SSM.
