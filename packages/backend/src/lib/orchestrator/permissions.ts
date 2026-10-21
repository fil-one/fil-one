// Translates FilOne access-key permissions into the Service Orchestrator
// Management API's s3:* action enum (docs/service-orchestrator-integration/
// management-openapi.yaml).

import type { AccessKeyPermission, GranularPermission } from '@filone/shared';

const ALWAYS_PERMISSIONS: readonly string[] = ['s3:ListAllMyBuckets'];

// Maps FilOne permission values onto the contract's s3:* action enum. Close
// cousin of FTH_BASE_PERMISSIONS (fth-orchestrator.ts). Hilt authorizes each
// operation the gateway serves on its own action (fil-forge/hilt#102), where
// it once authorized them as the plain bucket or object operation. Each
// permission carries the actions it covered that way, so a key keeps what it
// could do before: s3:ListBucket covered the bucket's location, ACL, CORS
// and tag reads, and s3:GetObject, s3:PutObject and s3:DeleteObject covered
// the object's tags and attributes. The versioning and object-lock reads
// have FilOne permissions of their own.
const BUCKET_CONFIGURATION_READS = [
  's3:GetBucketLocation',
  's3:GetBucketAcl',
  's3:GetBucketCORS',
  's3:GetBucketTagging',
];

const BASE_PERMISSIONS: Record<AccessKeyPermission, readonly string[]> = {
  read: [
    's3:GetObject',
    's3:ListBucket',
    's3:ListMultipartUploadParts',
    's3:GetObjectTagging',
    's3:GetObjectAttributes',
    ...BUCKET_CONFIGURATION_READS,
  ],
  write: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:PutObjectTagging'],
  list: ['s3:ListBucket', 's3:ListBucketMultipartUploads', ...BUCKET_CONFIGURATION_READS],
  delete: ['s3:DeleteObject', 's3:DeleteObjectTagging'],
  CreateBucket: ['s3:CreateBucket'],
  DeleteBucket: ['s3:DeleteBucket'],
  GetBucketVersioning: ['s3:GetBucketVersioning'],
  GetBucketObjectLockConfiguration: ['s3:GetBucketObjectLockConfiguration'],
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
