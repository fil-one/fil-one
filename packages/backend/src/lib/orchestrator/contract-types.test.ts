import { describe, it } from 'vitest';
import type { AccessKey, PolicyAction, PrincipalAccess } from '@filone/orchestrator-client';

// Type-level claims about the generated Management API client. The runtime
// body is empty; `tsc --noEmit` is the assertion.
describe('generated contract types', () => {
  it('rejects s3:GetBucketPolicy, s3:PutBucketPolicy and s3:DeleteBucketPolicy as a PolicyAction', () => {
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

  it("rejects s3:* as an action in a principal's effective access", () => {
    // @ts-expect-error — the effective set is expanded before it is returned.
    const _a: PrincipalAccess['buckets'][number]['actions'][number] = 's3:*';
    void _a;
  });

  it('rejects a principal key without a principal id or with permissions', () => {
    const base = { accessKeyId: 'AK', name: 'k', createdAt: '2026-01-01T00:00:00Z' };
    // @ts-expect-error — a principal key names its principal.
    const _a: AccessKey = { ...base, type: 'principal' };
    // @ts-expect-error — and carries no permissions of its own.
    const _b: AccessKey = { ...base, type: 'principal', principalId: 'p', permissions: [] };
    void _a;
    void _b;
  });
});
