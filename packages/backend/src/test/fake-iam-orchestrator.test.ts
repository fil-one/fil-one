import { describe, it, expect } from 'vitest';
import type { BucketPolicy } from '@filone/shared';
import { PolicyValidationError, PrincipalNotFoundError } from '../lib/errors.ts';
import { FakeIamOrchestrator } from './fake-iam-orchestrator.ts';

describe('FakeIamOrchestrator principal reads', () => {
  const grantReadToEveryone: BucketPolicy = {
    Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'] }],
  };

  it('resolveMemberAccess throws PrincipalNotFoundError for a principal that was never added', async () => {
    const fake = new FakeIamOrchestrator();
    fake.seedPolicy('t1', 'photos', grantReadToEveryone);
    await expect(fake.resolveMemberAccess('t1', 'ghost')).rejects.toBeInstanceOf(
      PrincipalNotFoundError,
    );
  });

  it('listBucketPoliciesForMember throws PrincipalNotFoundError for a removed principal', async () => {
    const fake = new FakeIamOrchestrator();
    await fake.syncMember('t1', 'u1');
    await fake.removeMember('t1', 'u1');
    fake.seedPolicy('t1', 'photos', grantReadToEveryone);
    await expect(fake.listBucketPoliciesForMember('t1', 'u1')).rejects.toBeInstanceOf(
      PrincipalNotFoundError,
    );
  });
});

describe('FakeIamOrchestrator policy writes', () => {
  it('removeMember keeps the policy and ETag of a bucket whose policy does not name the member', async () => {
    const fake = new FakeIamOrchestrator();
    await fake.syncMember('t1', 'u1');
    await fake.syncMember('t1', 'u2');
    const policy: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: ['u2'], Action: ['s3:GetObject'] }],
    };
    const etag = fake.seedPolicy('t1', 'photos', policy);
    await fake.removeMember('t1', 'u1');
    await expect(fake.getBucketPolicy('t1', 'photos')).resolves.toStrictEqual({ policy, etag });
  });

  it('putBucketPolicy throws PolicyValidationError when a statement names an unknown principal', async () => {
    const fake = new FakeIamOrchestrator();
    const policy: BucketPolicy = {
      Statement: [{ Effect: 'Allow', Principal: ['ghost'], Action: ['s3:GetObject'] }],
    };
    await expect(
      fake.putBucketPolicy('t1', 'photos', policy, { ifNoneMatch: '*' }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
  });
});
