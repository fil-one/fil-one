import { describe, it, expect } from 'vitest';
import { S3Region } from '@filone/shared';
import { bucketRegion } from './bucket-region.ts';

const oneRegion = { id: 'fth', regions: [S3Region.UsEast1] };
const twoRegions = { id: 'forge', regions: [S3Region.EuCentral3, S3Region.UsEast9] };

describe('bucketRegion', () => {
  it('takes the label the gateway put on the bucket', () => {
    expect(bucketRegion(twoRegions, { name: 'b', region: 'us-east-9' })).toBe(S3Region.UsEast9);
  });

  it('takes an unlabelled bucket as the one region a single-region network serves', () => {
    expect(bucketRegion(oneRegion, { name: 'b' })).toBe(S3Region.UsEast1);
  });

  it('refuses an unlabelled bucket from a multi-region network rather than guessing', () => {
    expect(() => bucketRegion(twoRegions, { name: 'b' })).toThrow(/without a region/);
  });

  it('refuses a label naming a region the network does not serve', () => {
    expect(() => bucketRegion(twoRegions, { name: 'b', region: 'eu-west-1' })).toThrow(
      /does not serve/,
    );
  });
});
