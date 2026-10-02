import { describe, it, expect } from 'vitest';
import { PrincipalNotFoundError } from '../lib/errors.ts';
import { FakeIamOrchestrator } from './fake-iam-orchestrator.ts';

describe('FakeIamOrchestrator principal reads', () => {
  const wildcard = {
    statement: [{ effect: 'allow', principal: '*', action: ['s3:GetObject'] }],
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
