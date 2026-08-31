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

Only keys created after this change carry the new actions. FTH has no way to widen the authority of an access key that already exists, so a customer picks the actions up by deleting their key and creating a new one.

That re-creation has to work, which is why `issueAccessKey` derives its idempotency key from a hash of the request it sends (tenant, storage user, key name, permissions, bucket scopes, expiry) rather than from the key name alone. A name-only key replays the original request whenever a customer re-creates a key under the same name with anything about it changed: a different permission set, a different list of bucket scopes, a different expiry. FTH answers a replay carrying a changed payload with a permanent `409`. Hashing the request means a changed payload is simply a different request.

### 3. The console key is minted as `filone-console-v2`

`FTH_FULL_PERMISSIONS` gains all three actions, and the per-tenant console key is created under the name `filone-console-v2` (`FTH_CONSOLE_KEY_NAME`). FTH requires access-key names to be unique within a tenant, so an existing tenant cannot have its `filone-console` key replaced in place: the new key is created alongside the old one, SSM is repointed at it, and the v1 key is deleted once the containers that cached it have recycled. Both keys are valid throughout, so no console operation fails during the rotation.

The two paths send different idempotency keys for the create. Tenant setup sends `console-key-v2-${stage}-${tenantId}-${storageUser.id}`, keeping the scoping that gives a re-provisioned org a fresh key and adding the `-v2` segment for the payload change: without it, a tenant whose setup crashed between the create and the `fthTenantId` write would replay the pre-v2 key with the new name and actions and 409 forever. The rotation script sends `console-key-v2-${tenantId}`, because a tenant's original setup key is bound to the payload of that create: replaying it with the v2 name and actions would 409 permanently and no existing tenant could be rotated at all.

`CreateAccessKeySchema` now rejects a customer key name starting with `filone-console`. Customer keys hang off the same storage user as the console key and FTH names are unique per tenant, so a customer key under that name would block the tenant's rotation, and the rotation script matching by name would delete a credential the customer is using. The reservation is case-insensitive and covers a future `-v3`. Keys created under that name before the reservation still exist: the rotation script cross-checks the DynamoDB access-key rows of the org and refuses to touch any key it finds there, reporting the tenant for a rotation by hand.

The storage user's `userCode` stays `filone-console`. It is what `fthOrchestrator` looks the user up by, and the user itself is not being replaced.

### 4. The console-credentials cache has no TTL

`getConsoleS3Credentials` (`packages/backend/src/lib/s3-credentials.ts`) caches the SSM value for the process lifetime. A rotation therefore takes effect per Lambda container as containers recycle. Adding a TTL would buy faster propagation for an event that happens roughly never, at the cost of an SSM read on the expiry of every entry.

Waiting is cheaper, and a deploy sets the deadline: every deploy replaces the running containers, so no container that started before it survives. The order is deploy the backend change, run `rotate`, let the containers that started between those two steps recycle, then `prune`. The next deploy after the rotation is what guarantees that, and the v1 key keeps working until the prune.

### 5. Existing FTH tenants are rotated by an operator script

`bin/fth-console-key.ts rotate <stage>` walks every org with an `fthTenantId`, creates the v2 key against its `filone-console` storage user, and writes the credentials to `/filone/<stage>/fth-s3/access-key/<tenantId>`. It skips an org whose SSM-referenced key already carries the three actions, so a re-run and a tenant provisioned after this change both cost one listing call.

`prune` deletes the v1 key afterwards, and only for a tenant whose SSM-referenced key exists in FTH and carries the three actions. A tenant whose rotation did not land therefore keeps its working v1 key, counts as a failure, and makes the command exit non-zero, which separates a prune with work left from one with nothing to do.

Between `rotate` and `prune`, each FTH tenant holds one extra access key. That counts against the tenant's key limit, and `aggregateRegionUsages` (`packages/backend/src/handlers/get-usage.ts`) subtracts a fixed one system key per region from the raw count, so the console's usage view undercounts the customer's own keys by one until the prune.

A tenant already at its key limit cannot hold the extra key, and FTH rejects the create. The script reports that tenant by FilOne org id and FTH client id, prints what FTH returned, and carries on with the rest; those tenants get a rotation by hand afterwards. No tenant is anywhere near the limit today.

### 6. The one-off granular-permissions backfill scripts are deleted

`bin/backfill-access-key-granular-permissions.ts` and its revert counterpart each inline a copy of the permission map. They served a one-time migration that is long done, and keeping them means keeping two more copies of a map that this change already edits in two places.

## Consequences

| Cost                                                                 | Reasoning                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Customers with existing keys must create a new key to abort uploads  | FTH cannot widen the authority of an access key that already exists.                                                                  |
| Every FTH tenant holds two console keys between `rotate` and `prune` | FTH names must be unique, and both keys valid is what keeps the console working while containers recycle.                             |
| The usage view undercounts customer keys by one during that window   | It subtracts a fixed one key per region rather than matching by name. Correcting it for a temporary state is not worth a code change. |
| Customers cannot name a key `filone-console…`                        | The name is the console key's, and a customer key under it would block the tenant's rotation.                                         |
| Forge keys still cannot abort or list parts                          | Its contract has no such action. Adding the one action it does have would create a third grouping to explain.                         |

## References

- [Service orchestrator and Management API](2026-04-service-orchestrator-management-api.md) - why FTH, Aurora and Forge are behind one orchestrator interface with per-vendor permission mapping.
- [Synchronous tenant setup on first resource](2026-05-synchronous-tenant-setup-on-first-resource.md) - the tenant-setup path that mints the console key and writes it to SSM.
