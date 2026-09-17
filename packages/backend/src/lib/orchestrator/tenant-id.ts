// The Management API tenant id for an (org, region) pair.
//
// The tenant id is client-supplied and is the idempotency key for
// PUT /tenants/{tenantId}. The contract also binds a tenant to one region for
// life and answers 409 RegionMismatch to a PUT naming a different one. A Forge
// network runs ONE Hilt serving EVERY region in that network (see
// forge/forge-orchestrator.ts), so an id keyed on the org alone would let the
// first region an org is provisioned in lock it out of every other region on
// that Hilt, permanently. Keying on (org, region) rules the collision out by
// construction.
//
// UUIDv5 rather than a readable `${orgId}/${region}`: the contract's TenantId
// schema is `format: uuid` plus a strict UUID pattern, and the value travels in
// a URL path segment, where a `/` would have to survive percent-encoding
// through every proxy between here and the orchestrator. A derived UUID keeps
// the contract, the generated client and every orchestrator implementation
// unchanged.
//
// STABILITY CONTRACT. The id is recomputed rather than stored for the length of
// the setup window: processTenantSetup derives it, PUTs the tenant, mints the
// console key, stashes SSM under it, and only then writes it to the PROFILE
// row. A crash anywhere in that window is recovered by a retry that derives the
// SAME id and lands idempotently on the SAME tenant. So neither the namespace
// nor the name format may ever change, and an S3Region string value may not be
// renamed without stranding tenants whose setup is mid-flight.
//
// Orgs provisioned before this module shipped carry their legacy id (= orgId)
// on the PROFILE row. That stored value short-circuits setup before anything
// derives, so they keep it for life; there is no migration because the contract
// has no tenant rename.

import { createHash } from 'node:crypto';
import type { S3Region } from '@filone/shared';

/**
 * FilOne's private UUIDv5 namespace for Service Orchestrator tenant ids.
 * Frozen forever — see the stability contract above. Not a secret: it is a
 * domain separator, not a key.
 */
export const FILONE_TENANT_ID_NAMESPACE = 'ae825539-e796-4468-ade9-7907a47eeed2';

/** The tenant id a Management API orchestrator provisions for this org in this region. */
export function tenantIdFor(orgId: string, region: S3Region): string {
  return uuidV5(FILONE_TENANT_ID_NAMESPACE, `${orgId}/${region}`);
}

/**
 * RFC 9562 §5.5 name-based UUID, SHA-1 variant. SHA-1 is what the spec mandates
 * for version 5 and carries no security weight here: the inputs are public
 * identifiers and nothing depends on the digest being hard to invert.
 *
 * Exported so the tests can check it against the spec's own known-answer
 * vector, which a self-consistent test of {@link tenantIdFor} cannot do.
 */
export function uuidV5(namespace: string, name: string): string {
  // The namespace hashes as its 16 raw bytes, not as the hyphenated string.
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
