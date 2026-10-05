import { describe, it, expect } from 'vitest';
import { PolicyValidationError, PrincipalNotFoundError } from '../lib/errors.ts';
import type { PolicyPrecondition } from '../lib/iam-orchestrator.ts';
import { FakeIamOrchestrator } from './fake-iam-orchestrator.ts';

describe('FakeIamOrchestrator principal reads', () => {
  const wildcard = {
    Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'] }],
  } as never;

  it('refuses resolveMemberAccess for a principal never synced, as Hilt does', async () => {
    const fake = new FakeIamOrchestrator();
    fake.seedPolicy('t1', 'photos', wildcard);
    await expect(fake.resolveMemberAccess('t1', 'ghost')).rejects.toBeInstanceOf(
      PrincipalNotFoundError,
    );
  });

  it('refuses listBucketPoliciesForMember for a removed principal, as Hilt does', async () => {
    const fake = new FakeIamOrchestrator();
    await fake.syncMember('t1', 'u1');
    await fake.removeMember('t1', 'u1');
    fake.seedPolicy('t1', 'photos', wildcard);
    await expect(fake.listBucketPoliciesForMember('t1', 'u1')).rejects.toBeInstanceOf(
      PrincipalNotFoundError,
    );
  });
});

describe('FakeIamOrchestrator policy writes', () => {
  it('leaves a policy that never names the removed member untouched, as Hilt does', async () => {
    const fake = new FakeIamOrchestrator();
    await fake.syncMember('t1', 'u1');
    await fake.syncMember('t1', 'u2');
    const etag = fake.seedPolicy('t1', 'photos', {
      Statement: [{ Effect: 'Allow', Principal: ['u2'], Action: ['s3:GetObject'] }],
    } as never);
    await fake.removeMember('t1', 'u1');
    expect((await fake.getBucketPolicy('t1', 'photos'))?.etag).toBe(etag);
  });

  it('refuses a policy naming an unknown principal as a malformed policy, as Hilt does', async () => {
    const fake = new FakeIamOrchestrator();
    const policy = {
      Statement: [{ Effect: 'Allow', Principal: ['ghost'], Action: ['s3:GetObject'] }],
    } as never;
    await expect(
      fake.putBucketPolicy('t1', 'photos', policy, { ifNoneMatch: '*' }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
  });

  it('takes exactly one precondition', () => {
    // @ts-expect-error — a write carries If-Match or If-None-Match, never both.
    const _p: PolicyPrecondition = { ifMatch: '"e1"', ifNoneMatch: '*' };
    void _p;
  });
});
