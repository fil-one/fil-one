import { describe, it, expect } from 'vitest';
import {
  TB_BYTES,
  TRIAL_STORAGE_LIMIT,
  TRIAL_EGRESS_LIMIT,
  UNLIMITED,
  getUsageLimits,
  getS3Endpoint,
  getAuth0Domain,
  getStageFromHostname,
  getAvailableRegions,
  supportsBucketManagement,
  isFoundationEmail,
  formatRegion,
  getRegionLabel,
  REGION_LABELS,
  S3_REGION,
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

describe('getAuth0Domain', () => {
  const nonProductionStages = [Stage.Staging, 'dev', 'pr-42', ''];

  it('returns the production custom domain for Stage.Production', () => {
    expect(getAuth0Domain(Stage.Production)).toBe('auth.fil.one');
  });

  for (const stage of nonProductionStages) {
    it(`returns the shared dev tenant domain for stage "${stage}"`, () => {
      expect(getAuth0Domain(stage)).toBe('dev-oar2nhqh58xf5pwf.us.auth0.com');
    });
  }
});

describe('getStageFromHostname', () => {
  it('returns Production for "app.fil.one"', () => {
    expect(getStageFromHostname('app.fil.one')).toBe(Stage.Production);
  });

  const nonProductionHostnames = [
    'staging.fil.one',
    'pr-42.fil.one',
    'localhost',
    'd123abc.cloudfront.net',
    '',
  ];

  for (const hostname of nonProductionHostnames) {
    it(`returns Staging for "${hostname}"`, () => {
      expect(getStageFromHostname(hostname)).toBe(Stage.Staging);
    });
  }
});

describe('getAvailableRegions', () => {
  it('returns only eu-west-1 in production', () => {
    expect(getAvailableRegions(Stage.Production)).toEqual([S3Region.EuWest1]);
  });

  it('returns both regions in staging', () => {
    expect(getAvailableRegions(Stage.Staging)).toEqual([S3Region.EuWest1, S3Region.UsEast1]);
  });

  const nonProductionStages = ['dev', 'pr-42', ''];
  for (const stage of nonProductionStages) {
    it(`returns both regions for non-production stage "${stage}"`, () => {
      expect(getAvailableRegions(stage)).toEqual([S3Region.EuWest1, S3Region.UsEast1]);
    });
  }

  it('returns both regions in production for a Foundation email', () => {
    expect(getAvailableRegions(Stage.Production, 'someone@fil.org')).toEqual([
      S3Region.EuWest1,
      S3Region.UsEast1,
    ]);
  });

  it('returns only eu-west-1 in production for a non-Foundation email', () => {
    expect(getAvailableRegions(Stage.Production, 'someone@example.com')).toEqual([
      S3Region.EuWest1,
    ]);
  });

  it('returns only eu-west-1 in production when no email is provided', () => {
    expect(getAvailableRegions(Stage.Production, undefined)).toEqual([S3Region.EuWest1]);
  });
});

describe('supportsBucketManagement', () => {
  it('returns false for the Aurora region (eu-west-1)', () => {
    expect(supportsBucketManagement(S3Region.EuWest1)).toBe(false);
  });

  it('returns true for non-Aurora regions', () => {
    expect(supportsBucketManagement(S3Region.UsEast1)).toBe(true);
  });
});

describe('isFoundationEmail', () => {
  it('matches @fil.org addresses', () => {
    expect(isFoundationEmail('alice@fil.org')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isFoundationEmail('Alice@FIL.ORG')).toBe(true);
  });

  it('rejects other domains', () => {
    expect(isFoundationEmail('alice@fil.one')).toBe(false);
    expect(isFoundationEmail('alice@notfil.org')).toBe(false);
    expect(isFoundationEmail('fil.org@example.com')).toBe(false);
  });

  it('rejects undefined and empty', () => {
    expect(isFoundationEmail(undefined)).toBe(false);
    expect(isFoundationEmail('')).toBe(false);
  });
});

describe('formatRegion', () => {
  it('formats a known region as "<label> <code>"', () => {
    expect(formatRegion(S3Region.EuWest1)).toBe(`${REGION_LABELS[S3Region.EuWest1]} eu-west-1`);
  });

  it('formats us-east-1 as "<label> <code>"', () => {
    expect(formatRegion(S3Region.UsEast1)).toBe(`${REGION_LABELS[S3Region.UsEast1]} us-east-1`);
  });

  it('returns the raw region for unknown values', () => {
    expect(formatRegion('ap-south-1')).toBe('ap-south-1');
  });
});

describe('getRegionLabel', () => {
  it('returns the label for a known region', () => {
    expect(getRegionLabel(S3Region.EuWest1)).toBe(REGION_LABELS[S3Region.EuWest1]);
    expect(getRegionLabel(S3Region.UsEast1)).toBe(REGION_LABELS[S3Region.UsEast1]);
  });

  it('returns the default region label for undefined', () => {
    expect(getRegionLabel(undefined)).toBe(REGION_LABELS[S3_REGION]);
  });

  it('returns the default region label for null', () => {
    expect(getRegionLabel(null)).toBe(REGION_LABELS[S3_REGION]);
  });

  it('returns the raw region string for unknown values', () => {
    expect(getRegionLabel('ap-south-1')).toBe('ap-south-1');
  });
});
