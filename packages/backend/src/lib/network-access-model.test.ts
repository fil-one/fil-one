import { describe, expect, it } from 'vitest';
import { S3Region } from '@filone/shared';
import { supportsIamMethods } from './network-access-model.ts';

describe('supportsIamMethods', () => {
  it.each([
    [S3Region.UsEast9, true],
    [S3Region.EuCentral3, true],
    [S3Region.EuWest1, false],
    [S3Region.UsEast1, false],
  ])('answers %s: %s', (region, expected) => {
    expect(supportsIamMethods(region)).toBe(expected);
  });
});
