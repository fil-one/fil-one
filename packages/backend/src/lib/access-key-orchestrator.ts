import type { AccessKeyPermission, GranularPermission } from '@filone/shared';
import type { OrchestratorRequestOptions } from './service-orchestrator.ts';

/** A service key: its own permissions and bucket list, fixed at creation. */
export interface IssueServiceKeyOpts {
  keyName: string;
  permissions: AccessKeyPermission[];
  granularPermissions?: GranularPermission[];
  buckets?: string[];
  expiresAt?: string | null;
}

/**
 * A key bound to a principal. It carries nothing of its own: what it may do is
 * whatever the bucket policies give that principal at the time of each request.
 * Only a region serving the `iam` access model mints one.
 */
export interface IssuePrincipalKeyOpts {
  /** Unique within the principal, so two members may each hold a `laptop`. */
  keyName: string;
  principalId: string;
  expiresAt?: string | null;
  permissions?: never;
  granularPermissions?: never;
  buckets?: never;
}

/** The request's shape is the key's kind, as it is at the storage system. */
export type IssueAccessKeyOpts = IssueServiceKeyOpts | IssuePrincipalKeyOpts;

interface IssuedKeyFields {
  id: string;
  accessKeyId: string;
  accessKeySecret: string;
  createdAt: string;
}

export interface IssuedServiceKey extends IssuedKeyFields {
  type: 'service';
}

export interface IssuedPrincipalKey extends IssuedKeyFields {
  type: 'principal';
  /** The member the key belongs to. */
  principalId: string;
}

export type IssuedAccessKey = IssuedServiceKey | IssuedPrincipalKey;

/** Access keys the tenant's S3 clients sign with. */
export interface AccessKeyOrchestrator {
  issueAccessKey(
    tenantId: string,
    keyOpts: IssueAccessKeyOpts,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<IssuedAccessKey>;
  /**
   * A principal-bound key's name is unique only within its principal, so a
   * lookup for one names the principal; only an `iam` region mints such keys.
   * Without a principal, only service keys are considered.
   */
  findAccessKeyByName(
    tenantId: string,
    keyName: string,
    principalId?: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<{ id: string; accessKeyId: string; createdAt: string } | undefined>;

  /**
   * Revokes an access key. Implementations MUST be idempotent: a missing key
   * (already deleted upstream) is treated as success, not an error. Any other
   * failure should propagate so the caller can leave the DDB row intact.
   */
  deleteAccessKey(
    tenantId: string,
    keyId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void>;
}
