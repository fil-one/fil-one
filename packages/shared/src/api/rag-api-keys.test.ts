import { describe, it, expect } from 'vitest';
import { S3Region } from '../constants.js';
import { CreateRagApiKeySchema, RAG_KEY_MAX_BUCKETS } from './rag-api-keys.js';

const BUCKET = { region: S3Region.EuWest1, name: 'my-bucket' };

describe('CreateRagApiKeySchema', () => {
  it('accepts a minimal all-buckets key and defaults bucketScope to "all"', () => {
    const result = CreateRagApiKeySchema.parse({ keyName: 'ci key' });
    expect(result.bucketScope).toBe('all');
    expect(result.buckets).toBeUndefined();
  });

  it('accepts a specific scope with buckets', () => {
    const result = CreateRagApiKeySchema.parse({
      keyName: 'scoped',
      bucketScope: 'specific',
      buckets: [BUCKET, { region: S3Region.UsEast1, name: 'other' }],
    });
    expect(result.buckets).toHaveLength(2);
  });

  it('trims and validates the key name like access keys', () => {
    expect(CreateRagApiKeySchema.parse({ keyName: '  ok name  ' }).keyName).toBe('ok name');
    expect(CreateRagApiKeySchema.safeParse({ keyName: '' }).success).toBe(false);
    expect(CreateRagApiKeySchema.safeParse({ keyName: 'bad/name' }).success).toBe(false);
    expect(CreateRagApiKeySchema.safeParse({ keyName: 'x'.repeat(65) }).success).toBe(false);
  });

  it('rejects specific scope without buckets', () => {
    for (const buckets of [undefined, []]) {
      const result = CreateRagApiKeySchema.safeParse({
        keyName: 'k',
        bucketScope: 'specific',
        buckets,
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects buckets provided alongside all scope', () => {
    const result = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'all',
      buckets: [BUCKET],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate (region, name) pairs but allows the same name across regions', () => {
    const dup = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'specific',
      buckets: [BUCKET, { ...BUCKET }],
    });
    expect(dup.success).toBe(false);

    const crossRegion = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'specific',
      buckets: [BUCKET, { region: S3Region.UsEast1, name: BUCKET.name }],
    });
    expect(crossRegion.success).toBe(true);
  });

  it('rejects more than RAG_KEY_MAX_BUCKETS buckets', () => {
    const buckets = Array.from({ length: RAG_KEY_MAX_BUCKETS + 1 }, (_, i) => ({
      region: S3Region.EuWest1,
      name: `bucket-${i}`,
    }));
    const result = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'specific',
      buckets,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid regions in bucket refs', () => {
    const result = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'specific',
      buckets: [{ region: 'mars-central-1', name: 'my-bucket' }],
    });
    expect(result.success).toBe(false);
  });
});
