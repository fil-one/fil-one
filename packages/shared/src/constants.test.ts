import { describe, it, expect } from 'vitest';
import {
  TB_BYTES,
  TRIAL_STORAGE_LIMIT,
  TRIAL_EGRESS_LIMIT,
  UNLIMITED,
  getUsageLimits,
  getS3Endpoint,
  S3Region,
  Stage,
} from './constants.js';

describe('constants', () => {
  it('TB_BYTES equals 10^12', () => {
    expect(TB_BYTES).toBe(1_000_000_000_000);
  });

  it('TRIAL_STORAGE_LIMIT equals 1 TB', () => {
    expect(TRIAL_STORAGE_LIMIT).toBe(TB_BYTES);
  });

  it('TRIAL_EGRESS_LIMIT equals 2 TB', () => {
    expect(TRIAL_EGRESS_LIMIT).toBe(2 * TB_BYTES);
  });

  it('UNLIMITED is -1', () => {
    expect(UNLIMITED).toBe(-1);
  });
});

describe('getUsageLimits', () => {
  it('returns trial limits when not active paid', () => {
    const limits = getUsageLimits(false);
    expect(limits).toEqual({
      storageLimitBytes: TRIAL_STORAGE_LIMIT,
      egressLimitBytes: TRIAL_EGRESS_LIMIT,
    });
  });

  it('returns unlimited when active paid', () => {
    const limits = getUsageLimits(true);
    expect(limits).toEqual({
      storageLimitBytes: UNLIMITED,
      egressLimitBytes: UNLIMITED,
    });
  });

  it('trial storage limit is 1 TB in bytes', () => {
    const limits = getUsageLimits(false);
    expect(limits.storageLimitBytes).toBe(1_000_000_000_000);
  });

  it('trial egress limit is 2 TB in bytes', () => {
    const limits = getUsageLimits(false);
    expect(limits.egressLimitBytes).toBe(2_000_000_000_000);
  });

  it('paid limits are both -1', () => {
    const limits = getUsageLimits(true);
    expect(limits.storageLimitBytes).toBe(-1);
    expect(limits.egressLimitBytes).toBe(-1);
  });
});

describe('getS3Endpoint', () => {
  it('returns the production URL with region prefix', () => {
    expect(getS3Endpoint(S3Region.EuWest1, Stage.Production)).toBe('https://eu-west-1.s3.fil.one');
  });

  it('returns the dev URL for staging', () => {
    expect(getS3Endpoint(S3Region.EuWest1, Stage.Staging)).toBe('https://s3.dev.aur.lu');
  });

  it('returns the dev URL for arbitrary non-production stage strings', () => {
    expect(getS3Endpoint(S3Region.EuWest1, 'dev')).toBe('https://s3.dev.aur.lu');
  });
});
