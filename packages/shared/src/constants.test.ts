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
  PROD_CONSOLE_HOST,
  PROD_CONSOLE_ALIAS_HOSTS,
  MARKETING_URL_BY_CONSOLE_ORIGIN,
  logoutReturnTo,
  AUTH0_DOMAIN_BY_CONSOLE_ORIGIN,
  getAvailableRegions,
  supportsBucketManagement,
  isFoundationEmail,
  isSupportedRegion,
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
    expect(getS3Endpoint(S3Region.EuWest1, Stage.Production)).toBe(
      'https://eu-west-1.s3.filonecontent.com',
    );
  });

  it('returns the dev URL for staging', () => {
    expect(getS3Endpoint(S3Region.EuWest1, Stage.Staging)).toBe('https://s3.dev.aur.lu');
  });

  it('returns the dev URL for arbitrary non-production stage strings', () => {
    expect(getS3Endpoint(S3Region.EuWest1, 'dev')).toBe('https://s3.dev.aur.lu');
  });

  it('returns the eu-central-3 staging gateway', () => {
    expect(getS3Endpoint(S3Region.EuCentral3, Stage.Staging)).toBe('https://ingot.staging.fil.one');
  });

  it('returns the us-east-9 dev sandbox gateway', () => {
    expect(getS3Endpoint(S3Region.UsEast9, Stage.Staging)).toBe(
      'https://ingot.dev.forge-sandbox.fil.one',
    );
  });

  it('serves every region from the content domain in production', () => {
    for (const region of Object.values(S3Region)) {
      expect(getS3Endpoint(region, Stage.Production)).toBe(
        `https://${region}.s3.filonecontent.com`,
      );
    }
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

  for (const hostname of PROD_CONSOLE_ALIAS_HOSTS) {
    it(`returns Production for the demo alias "${hostname}"`, () => {
      expect(getStageFromHostname(hostname)).toBe(Stage.Production);
    });
  }

  it('ignores hostname casing', () => {
    expect(getStageFromHostname('APP.FIL.ONE')).toBe(Stage.Production);
  });

  const nonProductionHostnames = [
    'staging.fil.one',
    'pr-42.fil.one',
    'localhost',
    'd123abc.cloudfront.net',
    '',
    // Guards against this ever being relaxed into a suffix or substring match.
    // Each of these is a hostname an attacker could control that ends with,
    // starts with, or contains a production host.
    'app.fil.one.attacker.example',
    'app.filone.ai.attacker.example',
    'notapp.filone.ai',
    'filone.ai',
    'fil.one',
  ];

  for (const hostname of nonProductionHostnames) {
    it(`returns Staging for "${hostname}"`, () => {
      expect(getStageFromHostname(hostname)).toBe(Stage.Staging);
    });
  }
});

describe('demo alias constants', () => {
  it('gives every production console origin a marketing site to log out to', () => {
    for (const host of [PROD_CONSOLE_HOST, ...PROD_CONSOLE_ALIAS_HOSTS]) {
      expect(MARKETING_URL_BY_CONSOLE_ORIGIN[`https://${host}`]).toBeDefined();
    }
  });

  // The alias console must not send a signed-out user to fil.one, which is the
  // domain the alias exists to route around.
  it('keeps each alias console on its own marketing domain', () => {
    expect(MARKETING_URL_BY_CONSOLE_ORIGIN['https://app.filone.ai']).toBe('https://filone.ai');
  });

  it('leaves non-production origins out of the table', () => {
    expect(MARKETING_URL_BY_CONSOLE_ORIGIN['https://staging.fil.one']).toBeUndefined();
  });

  // Without this, adding an alias host and forgetting its Auth0 entry routes that
  // alias's login through auth.fil.one — the flagged TLD the alias exists to escape
  // — and nothing else in the suite would catch it.
  it('gives every production console origin an Auth0 domain to authenticate against', () => {
    for (const host of [PROD_CONSOLE_HOST, ...PROD_CONSOLE_ALIAS_HOSTS]) {
      expect(AUTH0_DOMAIN_BY_CONSOLE_ORIGIN[`https://${host}`]).toBeDefined();
    }
  });

  it('keeps aliases off the Auth0 custom domain on the flagged TLD', () => {
    for (const host of PROD_CONSOLE_ALIAS_HOSTS) {
      expect(AUTH0_DOMAIN_BY_CONSOLE_ORIGIN[`https://${host}`]).not.toBe('auth.fil.one');
    }
  });

  // getStageFromHostname lowercases its input before comparing, so an entry
  // carrying any uppercase could never match.
  it('declares every host in lowercase', () => {
    for (const host of [PROD_CONSOLE_HOST, ...PROD_CONSOLE_ALIAS_HOSTS]) {
      expect(host).toBe(host.toLowerCase());
    }
  });

  it('keeps aliases off the flagged domain they exist to avoid', () => {
    for (const host of PROD_CONSOLE_ALIAS_HOSTS) {
      expect(host.endsWith('.fil.one')).toBe(false);
    }
  });
});

describe('logoutReturnTo', () => {
  it('hands a production console off to its marketing site', () => {
    expect(logoutReturnTo(`https://${PROD_CONSOLE_HOST}`)).toBe('https://fil.one');
  });

  it('hands a demo alias off to the alias marketing site', () => {
    expect(logoutReturnTo('https://app.filone.ai')).toBe('https://filone.ai');
  });

  // Non-production stages have no marketing site of their own, and being thrown onto
  // production marketing is a nuisance when you are only switching the signed-in user.
  const nonProductionOrigins = [
    'https://staging.fil.one',
    'https://pr-42.dev.fil.one',
    'https://localhost:5173',
  ];

  for (const origin of nonProductionOrigins) {
    it(`returns "${origin}" to itself`, () => {
      expect(logoutReturnTo(origin)).toBe(origin);
    });
  }
});

describe('getAvailableRegions', () => {
  it('returns all non-production regions when stage is empty', () => {
    expect(getAvailableRegions('')).toEqual([
      S3Region.EuWest1,
      S3Region.UsEast1,
      S3Region.EuCentral3,
      S3Region.UsEast9,
    ]);
  });

  it('excludes the non-GA Forge regions in production', () => {
    expect(getAvailableRegions(Stage.Production)).toEqual([S3Region.EuWest1, S3Region.UsEast1]);
  });

  it('includes the Forge regions on non-production stages', () => {
    expect(getAvailableRegions(Stage.Staging)).toEqual([
      S3Region.EuWest1,
      S3Region.UsEast1,
      S3Region.EuCentral3,
      S3Region.UsEast9,
    ]);
    expect(getAvailableRegions('dev-pr-123')).toContain(S3Region.EuCentral3);
    expect(getAvailableRegions('dev-pr-123')).toContain(S3Region.UsEast9);
  });
});

describe('isSupportedRegion', () => {
  it('accepts GA regions regardless of stage', () => {
    expect(isSupportedRegion('eu-west-1', 'unknown')).toBe(true);
    expect(isSupportedRegion('us-east-1', Stage.Production)).toBe(true);
  });

  it('gates eu-central-3 to non-production stages', () => {
    expect(isSupportedRegion('eu-central-3', Stage.Production)).toBe(false);
    expect(isSupportedRegion('eu-central-3', Stage.Staging)).toBe(true);
    expect(isSupportedRegion('eu-central-3', 'unknown')).toBe(true);
  });

  it('gates us-east-9 to non-production stages', () => {
    expect(isSupportedRegion('us-east-9', Stage.Production)).toBe(false);
    expect(isSupportedRegion('us-east-9', Stage.Staging)).toBe(true);
    expect(isSupportedRegion('us-east-9', 'unknown')).toBe(true);
  });

  it('rejects unknown regions', () => {
    expect(isSupportedRegion('mars-1', Stage.Staging)).toBe(false);
  });
});

describe('REGION_LABELS', () => {
  it('has a label for every region including eu-central-3', () => {
    expect(REGION_LABELS[S3Region.EuCentral3]).toBe('Europe (Amsterdam)');
  });

  it('names us-east-9 as the Forge dev sandbox', () => {
    expect(REGION_LABELS[S3Region.UsEast9]).toBe('Forge Dev Sandbox (US East)');
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
