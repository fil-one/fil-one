import { describe, it, expect } from 'vitest';
import { S3Region } from '../constants.ts';
import { CreateRagApiKeySchema, RAG_KEY_MAX_BUCKETS } from './rag-api-keys.ts';

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
    expect(CreateRagApiKeySchema.safeParse({ keyName: '' })).toMatchObject({
      success: false,
      error: {
        issues: [
          { code: 'too_small', path: ['keyName'] },
          { code: 'invalid_format', path: ['keyName'] },
        ],
      },
    });
    expect(CreateRagApiKeySchema.safeParse({ keyName: 'bad/name' })).toMatchObject({
      success: false,
      error: { issues: [{ code: 'invalid_format', path: ['keyName'] }] },
    });
    expect(CreateRagApiKeySchema.safeParse({ keyName: 'x'.repeat(65) })).toMatchObject({
      success: false,
      error: { issues: [{ code: 'too_big', path: ['keyName'] }] },
    });
  });

  it('rejects specific scope without buckets', () => {
    for (const buckets of [undefined, []]) {
      const result = CreateRagApiKeySchema.safeParse({
        keyName: 'k',
        bucketScope: 'specific',
        buckets,
      });
      expect(result, `buckets: ${JSON.stringify(buckets)}`).toMatchObject({
        success: false,
        error: {
          issues: [
            {
              path: ['buckets'],
              message: 'At least one bucket is required when scope is "specific"',
            },
          ],
        },
      });
    }
  });

  it('rejects buckets provided alongside all scope', () => {
    const result = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'all',
      buckets: [BUCKET],
    });
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [
          { path: ['buckets'], message: 'Buckets must not be provided when scope is "all"' },
        ],
      },
    });
  });

  it('rejects duplicate (region, name) pairs but allows the same name across regions', () => {
    const dup = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'specific',
      buckets: [BUCKET, { ...BUCKET }],
    });
    expect(dup).toMatchObject({
      success: false,
      error: { issues: [{ path: ['buckets'], message: 'Duplicate bucket in scope' }] },
    });

    const crossRegion = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'specific',
      buckets: [BUCKET, { region: S3Region.UsEast1, name: BUCKET.name }],
    });
    expect(crossRegion).toMatchObject({ success: true });
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
    expect(result).toMatchObject({
      success: false,
      error: { issues: [{ code: 'too_big', maximum: RAG_KEY_MAX_BUCKETS, path: ['buckets'] }] },
    });
  });

  it('rejects invalid regions in bucket refs', () => {
    const result = CreateRagApiKeySchema.safeParse({
      keyName: 'k',
      bucketScope: 'specific',
      buckets: [{ region: 'mars-central-1', name: 'my-bucket' }],
    });
    expect(result).toMatchObject({
      success: false,
      error: { issues: [{ code: 'invalid_value', path: ['buckets', 0, 'region'] }] },
    });
  });
});
