import { effectiveActions } from '@filone/shared';
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
  MemberPolicy,
  PolicyPrecondition,
  StoredBucketPolicy,
} from '../lib/iam-orchestrator.ts';
import type { OrchestratorRequestOptions } from '../lib/service-orchestrator.ts';

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

  private etagSeq = 0;
  private readonly failures = new Map<keyof IamMethods, Error>();

  seedBucket(tenantId: string, bucketName: string): void {
    this.bucketsOf(tenantId).add(bucketName);
  }

  seedPrincipal(tenantId: string, userId: string): void {
    this.principalsOf(tenantId).add(userId);
  }

  seedPolicy(tenantId: string, bucketName: string, policy: BucketPolicy): string {
    const stored = { policy, etag: this.nextEtag() };
    this.policiesOf(tenantId).set(bucketName, stored);
    return stored.etag;
  }

  /** The next call to `method` throws `error`, once. */
  failNext(method: keyof IamMethods, error: Error): void {
    this.failures.set(method, error);
  }

  async syncMember(tenantId: string, userId: string): Promise<void> {
    this.record('syncMember', tenantId, userId);
    this.principalsOf(tenantId).add(userId);
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    this.record('removeMember', tenantId, userId);
    this.principalsOf(tenantId).delete(userId);
    for (const [bucketName, stored] of this.policiesOf(tenantId)) {
      const names = (s: BucketPolicy['Statement'][number]) =>
        s.Principal !== '*' && s.Principal.includes(userId);
      if (!stored.policy.Statement.some(names)) continue;
      const statement = stored.policy.Statement.map((s) =>
        s.Principal === '*' ? s : { ...s, Principal: s.Principal.filter((p) => p !== userId) },
      ).filter((s) => s.Principal === '*' || s.Principal.length > 0);
      if (statement.length === 0) this.policiesOf(tenantId).delete(bucketName);
      else
        this.policiesOf(tenantId).set(bucketName, {
          policy: { Statement: statement },
          etag: this.nextEtag(),
        });
    }
  }

  async getBucketPolicy(tenantId: string, bucketName: string): Promise<StoredBucketPolicy | null> {
    this.record('getBucketPolicy', tenantId, bucketName);
    this.assertBucket(tenantId, bucketName);
    return this.policiesOf(tenantId).get(bucketName) ?? null;
  }

  async putBucketPolicy(
    tenantId: string,
    bucketName: string,
    policy: BucketPolicy,
    precondition?: PolicyPrecondition,
  ): Promise<{ etag: string }> {
    this.record('putBucketPolicy', tenantId, bucketName);
    this.assertBucket(tenantId, bucketName);
    const current = this.policiesOf(tenantId).get(bucketName);
    this.assertPrecondition(bucketName, current, precondition);
    for (const statement of policy.Statement) {
      if (statement.Principal === '*') continue;
      for (const principal of statement.Principal) {
        if (!this.principalsOf(tenantId).has(principal)) {
          // The S3 write answers MalformedPolicy, which the console maps here.
          throw new PolicyValidationError(`unknown principal "${principal}"`);
        }
      }
    }
    const stored = { policy, etag: this.nextEtag() };
    this.policiesOf(tenantId).set(bucketName, stored);
    return { etag: stored.etag };
  }

  async deleteBucketPolicy(
    tenantId: string,
    bucketName: string,
    precondition?: { ifMatch: string },
  ): Promise<void> {
    this.record('deleteBucketPolicy', tenantId, bucketName);
    this.assertBucket(tenantId, bucketName);
    const current = this.policiesOf(tenantId).get(bucketName);
    if (!current) throw new PolicyNotFoundError(bucketName);
    this.assertPrecondition(bucketName, current, precondition);
    this.policiesOf(tenantId).delete(bucketName);
  }

  async listBucketPoliciesForMember(tenantId: string, userId: string): Promise<MemberPolicy[]> {
    this.record('listBucketPoliciesForMember', tenantId, userId);
    // Hilt answers the access reads 404 for a principal it does not know.
    if (!this.principalsOf(tenantId).has(userId)) throw new PrincipalNotFoundError(userId);
    return [...this.policiesOf(tenantId)]
      .filter(([, stored]) =>
        stored.policy.Statement.some((s) => s.Principal === '*' || s.Principal.includes(userId)),
      )
      .map(([bucketName, { policy }]) => ({ bucketName, policy }));
  }

  async resolveMemberAccess(
    tenantId: string,
    userId: string,
    _opts?: OrchestratorRequestOptions,
  ): Promise<MemberBucketAccess[]> {
    this.record('resolveMemberAccess', tenantId, userId);
    // Hilt answers the access reads 404 for a principal it does not know.
    if (!this.principalsOf(tenantId).has(userId)) throw new PrincipalNotFoundError(userId);
    return [...this.policiesOf(tenantId)]
      .map(([bucketName, stored]) => ({
        bucketName,
        actions: effectiveActions(stored.policy, userId),
      }))
      .filter((access) => access.actions.length > 0);
  }

  private record(method: keyof IamMethods, tenantId: string, target: string): void {
    this.calls.push({ method, tenantId, target });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  private assertBucket(tenantId: string, bucketName: string): void {
    const known = this.buckets.get(tenantId);
    if (known && !known.has(bucketName)) throw new BucketNotFoundError(bucketName);
  }

  private assertPrecondition(
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

  private nextEtag(): string {
    return `"etag-${++this.etagSeq}"`;
  }

  private principalsOf(tenantId: string): Set<string> {
    let set = this.principals.get(tenantId);
    if (!set) this.principals.set(tenantId, (set = new Set()));
    return set;
  }

  private policiesOf(tenantId: string): Map<string, StoredBucketPolicy> {
    let map = this.policies.get(tenantId);
    if (!map) this.policies.set(tenantId, (map = new Map()));
    return map;
  }

  private bucketsOf(tenantId: string): Set<string> {
    let set = this.buckets.get(tenantId);
    if (!set) this.buckets.set(tenantId, (set = new Set()));
    return set;
  }
}
