import { getEffectiveActions, getPrincipalIds, toPolicyPrincipal } from '@filone/shared';
import type { BucketPolicy, MemberBucketAccess, PolicyStatement } from '@filone/shared';
import { BucketNotFoundError, PolicyNotFoundError, PolicyValidationError } from '../lib/errors.ts';
import type { BucketPolicyOrchestrator } from '../lib/bucket-policy-orchestrator.ts';
import type { MemberBucketPolicy, MemberOrchestrator } from '../lib/member-orchestrator.ts';
import type { OrchestratorRequestOptions } from '../lib/service-orchestrator.ts';

function removePrincipalFromStatement(s: PolicyStatement, userId: string): PolicyStatement {
  if (s.Principal === '*') return s;
  const principalIds = getPrincipalIds(s.Principal).filter((p) => p !== userId);
  return { ...s, Principal: toPolicyPrincipal(principalIds) };
}

/**
 * An in-memory bucket-policy and member orchestrator with the storage system's semantics: unconditional
 * writes where the last one wins, principals that must exist before a key binds to them, and
 * effective actions computed by the same shared function the console previews
 * with. Handler tests drive it where a real Hilt would be.
 *
 * Buckets: a tenant with no seeded bucket set accepts any bucket name; once
 * `seedBucket` names one, every other name is a {@link BucketNotFoundError}.
 * `failNext` makes one call throw, for the partial-failure paths.
 */
type FakedMethods = BucketPolicyOrchestrator & MemberOrchestrator;

export class FakeIamOrchestrator implements BucketPolicyOrchestrator, MemberOrchestrator {
  readonly principals = new Map<string, Set<string>>();
  readonly policies = new Map<string, Map<string, BucketPolicy>>();
  readonly buckets = new Map<string, Set<string>>();
  /** Every call in order, for tests that assert what ran before what. */
  readonly calls: Array<{ method: keyof FakedMethods; tenantId: string; target: string }> = [];

  private readonly failures = new Map<keyof FakedMethods, Error>();

  seedBucket(tenantId: string, bucketName: string): void {
    this.getOrCreateBuckets(tenantId).add(bucketName);
  }

  seedPrincipal(tenantId: string, userId: string): void {
    this.getOrCreatePrincipals(tenantId).add(userId);
  }

  seedPolicy(tenantId: string, bucketName: string, policy: BucketPolicy): void {
    this.getOrCreatePolicies(tenantId).set(bucketName, policy);
  }

  /** The next call to `method` throws `error`, once. */
  failNext(method: keyof FakedMethods, error: Error): void {
    this.failures.set(method, error);
  }

  async syncMember(tenantId: string, userId: string): Promise<void> {
    this.recordCall('syncMember', tenantId, userId);
    this.throwInjectedFailure('syncMember');
    this.getOrCreatePrincipals(tenantId).add(userId);
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    this.recordCall('removeMember', tenantId, userId);
    this.throwInjectedFailure('removeMember');
    this.getOrCreatePrincipals(tenantId).delete(userId);
    for (const [bucketName, policy] of this.getOrCreatePolicies(tenantId)) {
      const appliesToUser = (s: PolicyStatement) => getPrincipalIds(s.Principal).includes(userId);
      if (!policy.Statement.some(appliesToUser)) continue;
      const remainingStatements = policy.Statement.map((s) =>
        removePrincipalFromStatement(s, userId),
      ).filter((s) => s.Principal === '*' || s.Principal.AWS.length > 0);
      if (remainingStatements.length === 0) this.getOrCreatePolicies(tenantId).delete(bucketName);
      else
        this.getOrCreatePolicies(tenantId).set(bucketName, {
          ...policy,
          Statement: remainingStatements,
        });
    }
  }

  async getBucketPolicy(tenantId: string, bucketName: string): Promise<BucketPolicy | null> {
    this.recordCall('getBucketPolicy', tenantId, bucketName);
    this.throwInjectedFailure('getBucketPolicy');
    this.assertBucketExists(tenantId, bucketName);
    return this.getOrCreatePolicies(tenantId).get(bucketName) ?? null;
  }

  async putBucketPolicy(tenantId: string, bucketName: string, policy: BucketPolicy): Promise<void> {
    this.recordCall('putBucketPolicy', tenantId, bucketName);
    this.throwInjectedFailure('putBucketPolicy');
    this.assertBucketExists(tenantId, bucketName);
    for (const statement of policy.Statement) {
      for (const principal of getPrincipalIds(statement.Principal)) {
        if (!this.getOrCreatePrincipals(tenantId).has(principal)) {
          // The S3 write answers MalformedPolicy, which the console maps to
          // PolicyValidationError.
          throw new PolicyValidationError(`unknown principal "${principal}"`);
        }
      }
    }
    this.getOrCreatePolicies(tenantId).set(bucketName, policy);
  }

  async deleteBucketPolicy(tenantId: string, bucketName: string): Promise<void> {
    this.recordCall('deleteBucketPolicy', tenantId, bucketName);
    this.throwInjectedFailure('deleteBucketPolicy');
    this.assertBucketExists(tenantId, bucketName);
    if (!this.getOrCreatePolicies(tenantId).has(bucketName)) {
      throw new PolicyNotFoundError(bucketName);
    }
    this.getOrCreatePolicies(tenantId).delete(bucketName);
  }

  async listBucketPoliciesForMember(
    tenantId: string,
    userId: string,
  ): Promise<MemberBucketPolicy[]> {
    this.recordCall('listBucketPoliciesForMember', tenantId, userId);
    this.throwInjectedFailure('listBucketPoliciesForMember');
    // A principal Hilt does not know is named in no policy.
    if (!this.getOrCreatePrincipals(tenantId).has(userId)) return [];
    return [...this.getOrCreatePolicies(tenantId)]
      .filter(([, policy]) =>
        policy.Statement.some(
          (s) => s.Principal === '*' || getPrincipalIds(s.Principal).includes(userId),
        ),
      )
      .map(([bucketName, policy]) => ({ bucketName, policy }));
  }

  async resolveMemberAccess(
    tenantId: string,
    userId: string,
    _requestOptions?: OrchestratorRequestOptions,
  ): Promise<MemberBucketAccess[]> {
    this.recordCall('resolveMemberAccess', tenantId, userId);
    this.throwInjectedFailure('resolveMemberAccess');
    // A principal Hilt does not know reaches no bucket.
    if (!this.getOrCreatePrincipals(tenantId).has(userId)) return [];
    return [...this.getOrCreatePolicies(tenantId)]
      .map(([bucketName, policy]) => ({
        bucketName,
        actions: getEffectiveActions(policy, userId),
      }))
      .filter((access) => access.actions.length > 0);
  }

  private recordCall(method: keyof FakedMethods, tenantId: string, target: string): void {
    this.calls.push({ method, tenantId, target });
  }

  private throwInjectedFailure(method: keyof FakedMethods): void {
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  private assertBucketExists(tenantId: string, bucketName: string): void {
    const known = this.buckets.get(tenantId);
    if (known && !known.has(bucketName)) throw new BucketNotFoundError(bucketName);
  }

  private getOrCreatePrincipals(tenantId: string): Set<string> {
    let set = this.principals.get(tenantId);
    if (!set) this.principals.set(tenantId, (set = new Set()));
    return set;
  }

  private getOrCreatePolicies(tenantId: string): Map<string, BucketPolicy> {
    let map = this.policies.get(tenantId);
    if (!map) this.policies.set(tenantId, (map = new Map()));
    return map;
  }

  private getOrCreateBuckets(tenantId: string): Set<string> {
    let set = this.buckets.get(tenantId);
    if (!set) this.buckets.set(tenantId, (set = new Set()));
    return set;
  }
}

/**
 * The fake's methods bound to it, for spreading onto a fake orchestrator: a
 * spread copies own properties only, and class methods live on the prototype.
 */
export function delegateIamMethods(iam: FakeIamOrchestrator): FakedMethods {
  return {
    getBucketPolicy: (...args) => iam.getBucketPolicy(...args),
    putBucketPolicy: (...args) => iam.putBucketPolicy(...args),
    deleteBucketPolicy: (...args) => iam.deleteBucketPolicy(...args),
    syncMember: (...args) => iam.syncMember(...args),
    removeMember: (...args) => iam.removeMember(...args),
    listBucketPoliciesForMember: (...args) => iam.listBucketPoliciesForMember(...args),
    resolveMemberAccess: (...args) => iam.resolveMemberAccess(...args),
  };
}
