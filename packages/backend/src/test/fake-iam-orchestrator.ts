import { effectiveActions } from '@filone/shared';
import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';
import {
  AccessKeyAlreadyExistsError,
  BucketNotFoundError,
  PolicyNotFoundError,
  PolicyPreconditionFailedError,
  PrincipalNotFoundError,
} from '../lib/errors.ts';
import type {
  IamMethods,
  IssueMemberKeyOpts,
  IssuedMemberKey,
  MemberPolicy,
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
  readonly keys: Array<{
    tenantId: string;
    userId: string;
    keyName: string;
    id: string;
    accessKeyId: string;
  }> = [];
  /** Every call in order, for tests that assert what ran before what. */
  readonly calls: Array<{ method: keyof IamMethods; tenantId: string; target: string }> = [];

  private etagSeq = 0;
  private keySeq = 0;
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
    for (let i = this.keys.length - 1; i >= 0; i--) {
      const key = this.keys[i]!;
      if (key.tenantId === tenantId && key.userId === userId) this.keys.splice(i, 1);
    }
    for (const [bucketName, stored] of this.policiesOf(tenantId)) {
      const statement = stored.policy.statement
        .map((s) =>
          s.principal === '*' ? s : { ...s, principal: s.principal.filter((p) => p !== userId) },
        )
        .filter((s) => s.principal === '*' || s.principal.length > 0);
      if (statement.length === 0) this.policiesOf(tenantId).delete(bucketName);
      else
        this.policiesOf(tenantId).set(bucketName, { policy: { statement }, etag: this.nextEtag() });
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
    precondition: PolicyPrecondition,
  ): Promise<{ etag: string; created: boolean }> {
    this.record('putBucketPolicy', tenantId, bucketName);
    this.assertBucket(tenantId, bucketName);
    const current = this.policiesOf(tenantId).get(bucketName);
    this.assertPrecondition(bucketName, current, precondition);
    for (const statement of policy.statement) {
      if (statement.principal === '*') continue;
      for (const principal of statement.principal) {
        if (!this.principalsOf(tenantId).has(principal)) {
          throw new PrincipalNotFoundError(principal);
        }
      }
    }
    const stored = { policy, etag: this.nextEtag() };
    this.policiesOf(tenantId).set(bucketName, stored);
    return { etag: stored.etag, created: current === undefined };
  }

  async deleteBucketPolicy(
    tenantId: string,
    bucketName: string,
    precondition: { ifMatch: string },
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
    return [...this.policiesOf(tenantId)]
      .filter(([, stored]) =>
        stored.policy.statement.some((s) => s.principal === '*' || s.principal.includes(userId)),
      )
      .map(([bucketName, stored]) => ({ bucketName, ...stored }));
  }

  async resolveMemberAccess(tenantId: string, userId: string): Promise<MemberBucketAccess[]> {
    this.record('resolveMemberAccess', tenantId, userId);
    return [...this.policiesOf(tenantId)]
      .map(([bucketName, stored]) => ({
        bucketName,
        actions: effectiveActions(stored.policy, userId),
      }))
      .filter((access) => access.actions.length > 0);
  }

  async issueMemberKey(
    tenantId: string,
    userId: string,
    opts: IssueMemberKeyOpts,
  ): Promise<IssuedMemberKey> {
    this.record('issueMemberKey', tenantId, userId);
    if (!this.principalsOf(tenantId).has(userId)) throw new PrincipalNotFoundError(userId);
    if (
      this.keys.some(
        (k) => k.tenantId === tenantId && k.userId === userId && k.keyName === opts.keyName,
      )
    ) {
      throw new AccessKeyAlreadyExistsError();
    }
    const n = ++this.keySeq;
    const key = {
      tenantId,
      userId,
      keyName: opts.keyName,
      id: `did:key:z${n}`,
      accessKeyId: `did:key:z${n}`,
    };
    this.keys.push(key);
    return {
      id: key.id,
      accessKeyId: key.accessKeyId,
      accessKeySecret: `secret-${n}`,
      createdAt: '2026-09-16T12:00:00.000Z',
      principalId: userId,
    };
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
    precondition: PolicyPrecondition,
  ): void {
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
