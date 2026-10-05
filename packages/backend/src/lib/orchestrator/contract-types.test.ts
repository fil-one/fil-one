import { describe, it } from 'vitest';
import type { PolicyAction, PrincipalAccess } from '@filone/orchestrator-client';

// Type-level claims about the generated Management API client. The runtime
// body is empty; `tsc --noEmit` is the assertion.
describe('generated contract types', () => {
  it('PolicyAction never admits the policy-administration actions', () => {
    // @ts-expect-error — a policy cannot grant s3:GetBucketPolicy.
    const _a: PolicyAction = 's3:GetBucketPolicy';
    // @ts-expect-error — nor s3:PutBucketPolicy.
    const _b: PolicyAction = 's3:PutBucketPolicy';
    // @ts-expect-error — nor s3:DeleteBucketPolicy.
    const _c: PolicyAction = 's3:DeleteBucketPolicy';
    void _a;
    void _b;
    void _c;
  });

  it('a principal access entry lists expanded actions, never s3:*', () => {
    // @ts-expect-error — the effective set is expanded before it is returned.
    const _a: PrincipalAccess['buckets'][number]['actions'][number] = 's3:*';
    void _a;
  });
});
