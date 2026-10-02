// The two concrete arms of the service orchestrator, and the factory that picks
// between them. Separate from orchestrator.ts so the abstract core stays put as
// the `iam` arm grows: a scoped-keys region carries permissions on its keys, an
// `iam` region carries them on its bucket policies.

import { FilOneOrchestrator } from './orchestrator.ts';
import type { FilOneOrchestratorConfig } from './orchestrator.ts';
import { buildIamMethods } from './iam.ts';
import { reachableBuckets, reachesBucket } from './member-access.ts';
import { registerMemberPrincipals } from './principals.ts';
import type {
  BucketDetails,
  BucketSummary,
  IamMethods,
  IamOrchestrator,
  OrchestratorRequestOptions,
  S3ActorOptions,
  ScopedKeysOrchestrator,
  ServiceOrchestrator,
} from '../service-orchestrator.ts';

class ScopedKeysFilOneOrchestrator extends FilOneOrchestrator implements ScopedKeysOrchestrator {
  readonly accessModel = 'scoped-keys' as const;
}

class IamFilOneOrchestrator extends FilOneOrchestrator implements IamOrchestrator {
  readonly accessModel = 'iam' as const;
  // Field initializers run after the base constructor, so `client` is set.
  readonly iam: IamMethods = buildIamMethods(this.client, this.id, this);

  /**
   * Provisioning, plus the principals the tenant's policies will name — a
   * member the storage system does not know cannot be named on a bucket
   * policy, and the first policy rides on the bucket's own create.
   */
  override async ensureTenantReady(orgId: string, opts?: OrchestratorRequestOptions) {
    const tenantId = await super.ensureTenantReady(orgId, opts);
    if (tenantId) await registerMemberPrincipals(this.iam, this.id, orgId, tenantId);
    return tenantId;
  }

  /**
   * The tenant's buckets, or one member's when the caller names a member.
   *
   * The console filters because the data plane does not: every principal holds
   * `s3:ListAllMyBuckets`, so the gateway answers with the tenant's whole set
   * by design (RFC#30) and a principal-bound key would return the same names.
   * The reachable set comes from the storage system's own evaluation, so it
   * agrees with its last policy write.
   *
   * A bucket carrying no policy is reachable by unscoped callers alone, who
   * name no member and so are never filtered here. The console writes a policy
   * on every bucket it creates; one that arrives without it, or loses it, is
   * visible to an Owner or an Admin and to nobody else.
   */
  override async listBuckets(
    tenantId: string,
    requestOptions?: S3ActorOptions,
  ): Promise<BucketSummary[]> {
    const userId = requestOptions?.actAs;
    const listing = super.listBuckets(tenantId, requestOptions);
    return userId
      ? reachableBuckets(this.iam, listing, tenantId, { userId, signal: requestOptions?.signal })
      : listing;
  }

  /**
   * One bucket's details, or null when the named member cannot reach it.
   *
   * The console signs with the tenant's key, which every bucket answers, so
   * reach is settled here from the storage system's own evaluation of the
   * member's policies. A bucket outside them answers exactly like a bucket that
   * does not exist.
   */
  override async getBucket(
    tenantId: string,
    bucketName: string,
    requestOptions?: S3ActorOptions,
  ): Promise<BucketDetails | null> {
    const userId = requestOptions?.actAs;
    if (userId && !(await reachesBucket(this.iam, tenantId, userId, bucketName))) return null;
    return super.getBucket(tenantId, bucketName, requestOptions);
  }
}

export function createFilOneOrchestrator(config: FilOneOrchestratorConfig): ServiceOrchestrator {
  return config.accessModel === 'iam'
    ? new IamFilOneOrchestrator(config)
    : new ScopedKeysFilOneOrchestrator(config);
}
