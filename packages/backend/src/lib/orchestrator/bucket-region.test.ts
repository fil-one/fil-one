import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Region, type NonEmptyArray } from '@filone/shared';
import { bucketRegion } from './bucket-region.ts';

const oneRegion = { id: 'fth', regions: [S3Region.UsEast1] as NonEmptyArray<S3Region> };
const twoRegions = {
  id: 'forge',
  regions: [S3Region.EuCentral3, S3Region.UsEast9] as NonEmptyArray<S3Region>,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bucketRegion', () => {
  it('takes the label the gateway put on the bucket', () => {
    expect(bucketRegion(twoRegions, { name: 'b', region: 'us-east-9' })).toBe(S3Region.UsEast9);
  });

  it('refuses a label naming a region the network does not serve', () => {
    expect(() => bucketRegion(twoRegions, { name: 'b', region: 'eu-west-1' })).toThrow(
      /does not serve/,
    );
  });

  describe('a listing missing the region', () => {
    it('reads it as the one region a single-region network serves', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(bucketRegion(oneRegion, { name: 'b' })).toBe(S3Region.UsEast1);
    });

    // A gateway that has not implemented the label is only answerable while the
    // network has one region, so say so before a second one makes it fatal.
    it('warns, naming the bucket and the region it was read as', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      bucketRegion(oneRegion, { name: 'b' });

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain('"b"');
      expect(warn.mock.calls[0]![0]).toContain('us-east-1');
    });

    it('refuses it on a multi-region network rather than guessing', () => {
      expect(() => bucketRegion(twoRegions, { name: 'b' })).toThrow(/without a region/);
    });
  });
});
