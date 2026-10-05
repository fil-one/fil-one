import { describe, it, expect } from 'vitest';

import {
  BulkDeleteJobStatus,
  BulkDeleteScope,
  CreateBulkDeleteJobSchema,
  isTerminalBulkDeleteStatus,
} from './bulk-delete.ts';

const idempotencyKey = '3f1a6b2c-8d4e-4f0a-9b3c-1d2e3f4a5b6c';

describe('CreateBulkDeleteJobSchema', () => {
  it('defaults to the whole bucket and all versions', () => {
    const parsed = CreateBulkDeleteJobSchema.parse({ idempotencyKey });
    expect(parsed.prefix).toBe('');
    expect(parsed.scope).toBe(BulkDeleteScope.AllVersions);
  });

  it('accepts an explicit prefix and scope', () => {
    const parsed = CreateBulkDeleteJobSchema.parse({
      idempotencyKey,
      prefix: 'photos/',
      scope: BulkDeleteScope.Current,
    });
    expect(parsed.prefix).toBe('photos/');
    expect(parsed.scope).toBe(BulkDeleteScope.Current);
  });

  it('requires an idempotency key', () => {
    expect(CreateBulkDeleteJobSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-UUID idempotency key', () => {
    expect(CreateBulkDeleteJobSchema.safeParse({ idempotencyKey: 'nope' }).success).toBe(false);
  });

  it('rejects an unknown scope', () => {
    expect(
      CreateBulkDeleteJobSchema.safeParse({ idempotencyKey, scope: 'everything' }).success,
    ).toBe(false);
  });
});

describe('isTerminalBulkDeleteStatus', () => {
  it('treats finished states as terminal', () => {
    expect(isTerminalBulkDeleteStatus(BulkDeleteJobStatus.Completed)).toBe(true);
    expect(isTerminalBulkDeleteStatus(BulkDeleteJobStatus.CompletedWithErrors)).toBe(true);
    expect(isTerminalBulkDeleteStatus(BulkDeleteJobStatus.Failed)).toBe(true);
  });

  it('treats in-flight states as non-terminal', () => {
    expect(isTerminalBulkDeleteStatus(BulkDeleteJobStatus.Pending)).toBe(false);
    expect(isTerminalBulkDeleteStatus(BulkDeleteJobStatus.Running)).toBe(false);
  });
});
