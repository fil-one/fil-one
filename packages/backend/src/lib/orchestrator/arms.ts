// The two concrete arms of the service orchestrator, and the factory that picks
// between them. Separate from orchestrator.ts so the abstract core stays put as
// the `iam` arm grows: a scoped-keys region carries permissions on its keys, an
// `iam` region carries them on its bucket policies.

import { FilOneOrchestrator } from './orchestrator.ts';
import type { FilOneOrchestratorConfig } from './orchestrator.ts';
import { buildIamMethods } from './iam.ts';
import { memberCredentials, reachableBuckets, withFreshMemberCredential } from './member-access.ts';
import { registerMemberPrincipals } from './principals.ts';
import type { S3Credentials } from '../s3-credentials.ts';
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
  readonly iam: IamMethods = buildIamMethods(this.client, this.id);

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
    const buckets = await super.listBuckets(tenantId, requestOptions);
    // Awaited after the listing rather than beside it, so a failed access lookup
    // rejects this method and the caller's fan-out reports the region as
    // unavailable. Answering unfiltered would hand the member every bucket name
    // in the tenant.
    return userId ? reachableBuckets(this.iam, buckets, tenantId, userId) : buckets;
  }

  /**
   * The tenant's console key, or the named member's, on this `iam` region.
   *
   * A member's key is bound to their principal and carries no authority of its
   * own: what it may do is whatever the bucket policies give them at the time of
   * each request. So a role change or a policy edit needs no reissue here, and
   * a demotion deletes nothing — rewriting the policies is the narrowing.
   */
  /**
   * One bucket's details, signed as the member when the caller names one.
   *
   * A bucket outside their policies answers exactly like a bucket that does not
   * exist: the gateway refuses the read and this returns null.
   */
  override async getBucket(
    tenantId: string,
    bucketName: string,
    requestOptions?: S3ActorOptions,
  ): Promise<BucketDetails | null> {
    const userId = requestOptions?.actAs;
    if (!userId) return super.getBucket(tenantId, bucketName, requestOptions);
    const { id: orchestratorId, config } = this;
    return withFreshMemberCredential(
      { orchestratorId, stage: config.stage, tenantId, userId },
      () => super.getBucket(tenantId, bucketName, requestOptions),
    );
  }

  protected override s3Credentials(
    tenantId: string,
    requestOptions?: S3ActorOptions,
  ): Promise<S3Credentials> {
    const userId = requestOptions?.actAs;
    if (!userId) return super.s3Credentials(tenantId, requestOptions);
    const { id: orchestratorId, config } = this;
    return memberCredentials(
      this,
      { orchestratorId, stage: config.stage, tenantId, userId },
      requestOptions,
    );
  }
}

export function createFilOneOrchestrator(config: FilOneOrchestratorConfig): ServiceOrchestrator {
  return config.accessModel === 'iam'
    ? new IamFilOneOrchestrator(config)
    : new ScopedKeysFilOneOrchestrator(config);
}
