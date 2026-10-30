import { describe, it, expect } from 'vitest';
import { PolicyValidationError } from '../lib/errors.ts';
import { FakeIamOrchestrator } from './fake-iam-orchestrator.ts';
import { policyOf, statement } from './policy-statements.ts';

describe('FakeIamOrchestrator principal reads', () => {
  const grantReadToEveryone = policyOf(statement('photos', 'Allow', '*', ['s3:GetObject']));

  it('resolveMemberAccess answers no buckets for a principal that was never added', async () => {
    const fake = new FakeIamOrchestrator();
    fake.seedPolicy('t1', 'photos', grantReadToEveryone);
    await expect(fake.resolveMemberAccess('t1', 'ghost')).resolves.toStrictEqual([]);
  });

  it('listBucketPoliciesForMember answers no policies for a removed principal', async () => {
    const fake = new FakeIamOrchestrator();
    await fake.syncMember('t1', 'u1');
    await fake.removeMember('t1', 'u1');
    fake.seedPolicy('t1', 'photos', grantReadToEveryone);
    await expect(fake.listBucketPoliciesForMember('t1', 'u1')).resolves.toStrictEqual([]);
  });
});

describe('FakeIamOrchestrator policy writes', () => {
  it('removeMember keeps the policy of a bucket whose policy does not name the member', async () => {
    const fake = new FakeIamOrchestrator();
    await fake.syncMember('t1', 'u1');
    await fake.syncMember('t1', 'u2');
    const policy = policyOf(statement('photos', 'Allow', ['u2'], ['s3:GetObject']));
    fake.seedPolicy('t1', 'photos', policy);
    await fake.removeMember('t1', 'u1');
    await expect(fake.getBucketPolicy('t1', 'photos')).resolves.toStrictEqual(policy);
  });

  it('removeMember keeps an everyone statement and drops the member from a named one', async () => {
    const fake = new FakeIamOrchestrator();
    await fake.syncMember('t1', 'u1');
    await fake.syncMember('t1', 'u2');
    const readByEveryone = statement('photos', 'Allow', '*', ['s3:GetObject']);
    fake.seedPolicy(
      't1',
      'photos',
      policyOf(readByEveryone, statement('photos', 'Allow', ['u1', 'u2'], ['s3:PutObject'])),
    );
    await fake.removeMember('t1', 'u1');
    await expect(fake.getBucketPolicy('t1', 'photos')).resolves.toStrictEqual(
      policyOf(readByEveryone, statement('photos', 'Allow', ['u2'], ['s3:PutObject'])),
    );
  });

  it('putBucketPolicy throws PolicyValidationError when a statement names an unknown principal', async () => {
    const fake = new FakeIamOrchestrator();
    const policy = policyOf(statement('photos', 'Allow', ['ghost'], ['s3:GetObject']));
    await expect(fake.putBucketPolicy('t1', 'photos', policy)).rejects.toBeInstanceOf(
      PolicyValidationError,
    );
  });
});
