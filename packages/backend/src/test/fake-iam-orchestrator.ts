import { getEffectiveActions } from '@filone/shared';
import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';
import {
  BucketNotFoundError,
  PolicyNotFoundError,
  PolicyPreconditionFailedError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from '../lib/errors.ts';
import type {
  IamMethods,
  IfMatchPrecondition,
  MemberBucketPolicy,
  PolicyPrecondition,
  StoredBucketPolicy,
} from '../lib/iam-orchestrator.ts';

/**
 * An in-memory `iam` arm with the storage system's semantics: real ETags and
 * preconditions, principals that must exist before a key binds to them, and
 * effective actions computed by the same shared function the console previews
 * with. Handler tests drive it where a real Hilt would be.
 *
 * Buckets: a tenant with no seeded bucket set accepts any bucket name; once
 * `seedBucket` names one, every other name is a {@link BucketNotFoundError}.
 * `failNext` makes one call throw, for the partial-failure paths.
 */
export class FakeIamOrchestrator implements IamMethods {
  readonly principals = new Map<string, Set<string>>();
  readonly policies = new Map<string, Map<string, StoredBucketPolicy>>();
  readonly buckets = new Map<string, Set<string>>();
  /** Every call in order, for tests that assert what ran before what. */
  readonly calls: Array<{ method: keyof IamMethods; tenantId: string; target: string }> = [];

  private etagCounter = 0;
  private readonly failures = new Map<keyof IamMethods, Error>();

  seedBucket(tenantId: string, bucketName: string): void {
    this.getOrCreateBuckets(tenantId).add(bucketName);
  }

  seedPrincipal(tenantId: string, userId: string): void {
    this.getOrCreatePrincipals(tenantId).add(userId);
  }

  seedPolicy(tenantId: string, bucketName: string, policy: BucketPolicy): string {
    const stored = { policy, etag: this.createEtag() };
    this.getOrCreatePolicies(tenantId).set(bucketName, stored);
    return stored.etag;
  }

  /** The next call to `method` throws `error`, once. */
  failNext(method: keyof IamMethods, error: Error): void {
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
    for (const [bucketName, stored] of this.getOrCreatePolicies(tenantId)) {
      const appliesToUser = (s: BucketPolicy['Statement'][number]) =>
        s.Principal !== '*' && s.Principal.includes(userId);
      if (!stored.policy.Statement.some(appliesToUser)) continue;
      const remainingStatements = stored.policy.Statement.map((s) =>
        s.Principal === '*' ? s : { ...s, Principal: s.Principal.filter((p) => p !== userId) },
      ).filter((s) => s.Principal === '*' || s.Principal.length > 0);
      if (remainingStatements.length === 0) this.getOrCreatePolicies(tenantId).delete(bucketName);
      else
        this.getOrCreatePolicies(tenantId).set(bucketName, {
          policy: { Statement: remainingStatements },
          etag: this.createEtag(),
        });
    }
  }

  async getBucketPolicy(tenantId: string, bucketName: string): Promise<StoredBucketPolicy | null> {
    this.recordCall('getBucketPolicy', tenantId, bucketName);
    this.throwInjectedFailure('getBucketPolicy');
    this.assertBucketExists(tenantId, bucketName);
    return this.getOrCreatePolicies(tenantId).get(bucketName) ?? null;
  }

  async putBucketPolicy(
    tenantId: string,
    bucketName: string,
    policy: BucketPolicy,
    precondition?: PolicyPrecondition,
  ): Promise<{ etag: string }> {
    this.recordCall('putBucketPolicy', tenantId, bucketName);
    this.throwInjectedFailure('putBucketPolicy');
    this.assertBucketExists(tenantId, bucketName);
    const current = this.getOrCreatePolicies(tenantId).get(bucketName);
    this.assertPreconditionHolds(bucketName, current, precondition);
    for (const statement of policy.Statement) {
      if (statement.Principal === '*') continue;
      for (const principal of statement.Principal) {
        if (!this.getOrCreatePrincipals(tenantId).has(principal)) {
          // The S3 write answers MalformedPolicy, which the console maps to
          // PolicyValidationError.
          throw new PolicyValidationError(`unknown principal "${principal}"`);
        }
      }
    }
    const stored = { policy, etag: this.createEtag() };
    this.getOrCreatePolicies(tenantId).set(bucketName, stored);
    return { etag: stored.etag };
  }

  async deleteBucketPolicy(
    tenantId: string,
    bucketName: string,
    precondition?: IfMatchPrecondition,
  ): Promise<void> {
    this.recordCall('deleteBucketPolicy', tenantId, bucketName);
    this.throwInjectedFailure('deleteBucketPolicy');
    this.assertBucketExists(tenantId, bucketName);
    const current = this.getOrCreatePolicies(tenantId).get(bucketName);
    if (!current) throw new PolicyNotFoundError(bucketName);
    this.assertPreconditionHolds(bucketName, current, precondition);
    this.getOrCreatePolicies(tenantId).delete(bucketName);
  }

  async listBucketPoliciesForMember(
    tenantId: string,
    userId: string,
  ): Promise<MemberBucketPolicy[]> {
    this.recordCall('listBucketPoliciesForMember', tenantId, userId);
    this.throwInjectedFailure('listBucketPoliciesForMember');
    // Hilt answers the access reads 404 for a principal it does not know.
    if (!this.getOrCreatePrincipals(tenantId).has(userId)) throw new PrincipalNotFoundError(userId);
    return [...this.getOrCreatePolicies(tenantId)]
      .filter(([, stored]) =>
        stored.policy.Statement.some((s) => s.Principal === '*' || s.Principal.includes(userId)),
      )
      .map(([bucketName, { policy }]) => ({ bucketName, policy }));
  }

  async resolveMemberAccess(tenantId: string, userId: string): Promise<MemberBucketAccess[]> {
    this.recordCall('resolveMemberAccess', tenantId, userId);
    this.throwInjectedFailure('resolveMemberAccess');
    // Hilt answers the access reads 404 for a principal it does not know.
    if (!this.getOrCreatePrincipals(tenantId).has(userId)) throw new PrincipalNotFoundError(userId);
    return [...this.getOrCreatePolicies(tenantId)]
      .map(([bucketName, stored]) => ({
        bucketName,
        actions: getEffectiveActions(stored.policy, userId),
      }))
      .filter((access) => access.actions.length > 0);
  }

  private recordCall(method: keyof IamMethods, tenantId: string, target: string): void {
    this.calls.push({ method, tenantId, target });
  }

  private throwInjectedFailure(method: keyof IamMethods): void {
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

  private assertPreconditionHolds(
    bucketName: string,
    current: StoredBucketPolicy | undefined,
    precondition: PolicyPrecondition | undefined,
  ): void {
    if (!precondition) return;
    if ('ifNoneMatch' in precondition) {
      if (current) throw new PolicyPreconditionFailedError(bucketName);
      return;
    }
    if (!current || current.etag !== precondition.ifMatch) {
      throw new PolicyPreconditionFailedError(bucketName);
    }
  }

  private createEtag(): string {
    return `"etag-${++this.etagCounter}"`;
  }

  private getOrCreatePrincipals(tenantId: string): Set<string> {
    let set = this.principals.get(tenantId);
    if (!set) this.principals.set(tenantId, (set = new Set()));
    return set;
  }

  private getOrCreatePolicies(tenantId: string): Map<string, StoredBucketPolicy> {
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
