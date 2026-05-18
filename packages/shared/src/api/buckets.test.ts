import { describe, it, expect } from 'vitest';
import { CreateBucketSchema } from './buckets.js';

const validRetention = (
  overrides: Partial<{
    enabled: true;
    mode: 'governance' | 'compliance';
    duration: number;
    durationType: 'd' | 'y';
  }> = {},
) => ({
  enabled: true as const,
  mode: 'governance' as const,
  duration: 15,
  durationType: 'd' as const,
  ...overrides,
});

describe('CreateBucketSchema', () => {
  describe('default values', () => {
    it('sets versioning=false and lock=false when omitted', () => {
      const result = CreateBucketSchema.parse({ name: 'my-bucket', region: 'eu-west-1' });
      expect(result.versioning).toBe(false);
      expect(result.lock).toBe(false);
      expect(result.retention).toBeUndefined();
    });
  });

  describe('valid combinations', () => {
    it('versioning OFF, lock OFF, no retention', () => {
      const result = CreateBucketSchema.parse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: false,
        lock: false,
      });
      expect(result.versioning).toBe(false);
      expect(result.lock).toBe(false);
    });

    it('versioning ON, lock OFF, no retention', () => {
      const result = CreateBucketSchema.parse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: false,
      });
      expect(result.versioning).toBe(true);
      expect(result.lock).toBe(false);
    });

    it('versioning ON, lock ON, no retention', () => {
      const result = CreateBucketSchema.parse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: true,
      });
      expect(result.versioning).toBe(true);
      expect(result.lock).toBe(true);
    });

    it('versioning ON, lock ON, governance retention', () => {
      const result = CreateBucketSchema.parse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: true,
        retention: validRetention({ mode: 'governance', duration: 15, durationType: 'd' }),
      });
      expect(result.retention).toEqual({
        enabled: true,
        mode: 'governance',
        duration: 15,
        durationType: 'd',
      });
    });

    it('versioning ON, lock ON, compliance retention', () => {
      const result = CreateBucketSchema.parse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: true,
        retention: validRetention({ mode: 'compliance', duration: 1, durationType: 'y' }),
      });
      expect(result.retention).toEqual({
        enabled: true,
        mode: 'compliance',
        duration: 1,
        durationType: 'y',
      });
    });
  });

  describe('invalid combinations', () => {
    it('rejects lock ON without versioning', () => {
      const result = CreateBucketSchema.safeParse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: false,
        lock: true,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const lockError = result.error.issues.find((i) => i.path.includes('lock'));
        expect(lockError?.message).toBe('Versioning must be enabled to use Object Lock');
      }
    });

    it('rejects retention without lock', () => {
      const result = CreateBucketSchema.safeParse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: false,
        retention: validRetention(),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const retentionError = result.error.issues.find((i) => i.path.includes('retention'));
        expect(retentionError?.message).toBe('Object Lock must be enabled to use Retention');
      }
    });

    it('rejects retention without versioning (both refinements fail)', () => {
      const result = CreateBucketSchema.safeParse({
        name: 'my-bucket',
        region: 'eu-west-1',
        versioning: false,
        lock: false,
        retention: validRetention(),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const retentionError = result.error.issues.find((i) => i.path.includes('retention'));
        expect(retentionError?.message).toBe('Object Lock must be enabled to use Retention');
      }
    });
  });

  describe('duration bounds', () => {
    const base = {
      name: 'my-bucket',
      region: 'eu-west-1',
      versioning: true,
      lock: true,
    };

    it('rejects duration of 0', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 0 }),
      });
      expect(result.success).toBe(false);
    });

    it('accepts duration of 1', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 1 }),
      });
      expect(result.success).toBe(true);
    });

    it('accepts duration of 36500', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 36500 }),
      });
      expect(result.success).toBe(true);
    });

    it('rejects duration of 36501', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 36501 }),
      });
      expect(result.success).toBe(false);
    });

    it('accepts years duration of 100', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 100, durationType: 'y' }),
      });
      expect(result.success).toBe(true);
    });

    it('rejects years duration of 101', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 101, durationType: 'y' }),
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer duration', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 1.5 }),
      });
      expect(result.success).toBe(false);
    });
  });
});
