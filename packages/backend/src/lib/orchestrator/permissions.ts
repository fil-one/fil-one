// Translates FilOne access-key permissions into the Service Orchestrator
// Management API's s3:* action enum (docs/service-orchestrator-integration/
// management-openapi.yaml).

import type { AccessKeyPermission, GranularPermission } from '@filone/shared';

const ALWAYS_PERMISSIONS: readonly string[] = ['s3:ListAllMyBuckets'];

// Maps FilOne permission values onto the contract's s3:* action enum. Close
// cousin of FTH_BASE_PERMISSIONS (fth-orchestrator.ts) but deliberately not
// shared: the Management API enum has no s3:GetBucketVersioning /
// s3:GetBucketObjectLockConfiguration actions, so those FilOne permissions
// map to nothing here — sending them would draw a 422. Flagged against the
// spec; until it grows those actions, orchestrators are expected to authorize
// bucket-config reads implicitly for tenant-scoped keys.
const BASE_PERMISSIONS: Record<AccessKeyPermission, readonly string[]> = {
  read: ['s3:GetObject', 's3:ListBucket'],
  write: ['s3:PutObject'],
  list: ['s3:ListBucket'],
  delete: ['s3:DeleteObject'],
  CreateBucket: ['s3:CreateBucket'],
  DeleteBucket: ['s3:DeleteBucket'],
  GetBucketVersioning: [],
  GetBucketObjectLockConfiguration: [],
};

const GRANULAR_PERMISSIONS: Record<GranularPermission, string> = {
  GetObjectVersion: 's3:GetObjectVersion',
  GetObjectRetention: 's3:GetObjectRetention',
  GetObjectLegalHold: 's3:GetObjectLegalHold',
  PutObjectRetention: 's3:PutObjectRetention',
  PutObjectLegalHold: 's3:PutObjectLegalHold',
  ListBucketVersions: 's3:ListBucketVersions',
  DeleteObjectVersion: 's3:DeleteObjectVersion',
};

export function buildPermissions(
  permissions: AccessKeyPermission[],
  granularPermissions?: GranularPermission[],
): string[] {
  const out = new Set<string>(ALWAYS_PERMISSIONS);
  for (const p of permissions) {
    const actions = BASE_PERMISSIONS[p];
    if (actions.length === 0) {
      console.warn(
        `Permission "${p}" has no Management API equivalent and was dropped from the access key request`,
      );
    }
    for (const action of actions) out.add(action);
  }
  for (const g of granularPermissions ?? []) {
    out.add(GRANULAR_PERMISSIONS[g]);
  }
  return [...out];
}
