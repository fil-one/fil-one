import { describe, it, expect } from 'vitest';

import type { AccessKey, PrincipalAccessKey, ServiceAccessKey } from '@filone/shared';
import { S3Region } from '@filone/shared';

import {
  ACCESS_KEY_TABLE_CONTROLS_MIN,
  EMPTY_ACCESS_KEY_FILTERS,
  accessKeyRegions,
  filterAccessKeys,
  hasActiveAccessKeyFilters,
  shouldShowAccessKeyControls,
} from './access-key-table.js';

function serviceKey(overrides: Partial<ServiceAccessKey>): ServiceAccessKey {
  return {
    type: 'service',
    id: 'any-id',
    keyName: 'any-key',
    accessKeyId: 'ANYACCESSKEYID000000',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'active',
    permissions: ['read'],
    bucketScope: 'all',
    region: S3Region.EuWest1,
    ...overrides,
  };
}

function personalKey(overrides: Partial<PrincipalAccessKey>): PrincipalAccessKey {
  return {
    type: 'principal',
    principalId: 'any-user',
    id: 'any-id',
    keyName: 'any-key',
    accessKeyId: 'ANYACCESSKEYID000000',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'active',
    region: S3Region.EuWest1,
    ...overrides,
  };
}

const keyNames = (keys: AccessKey[]) => keys.map((key) => key.keyName);

describe('shouldShowAccessKeyControls', () => {
  it('shows the controls at exactly the minimum', () => {
    expect(shouldShowAccessKeyControls(ACCESS_KEY_TABLE_CONTROLS_MIN)).toBe(true);
  });

  it('hides the controls one below the minimum', () => {
    expect(shouldShowAccessKeyControls(ACCESS_KEY_TABLE_CONTROLS_MIN - 1)).toBe(false);
  });
});

describe('hasActiveAccessKeyFilters', () => {
  it('treats a query of only spaces as no filter', () => {
    expect(hasActiveAccessKeyFilters({ ...EMPTY_ACCESS_KEY_FILTERS, query: '   ' })).toBe(false);
  });

  it.each([
    ['query', { query: 'prod' }],
    ['region', { region: S3Region.UsEast1 }],
    ['status', { status: 'expired' }],
    ['type', { type: 'principal' }],
  ] as const)('counts a %s filter as narrowing the list', (_name, change) => {
    expect(hasActiveAccessKeyFilters({ ...EMPTY_ACCESS_KEY_FILTERS, ...change })).toBe(true);
  });
});

describe('filterAccessKeys', () => {
  it('keeps every key when no filter is set', () => {
    const keys = [serviceKey({ keyName: 'a' }), personalKey({ keyName: 'b' })];
    expect(keyNames(filterAccessKeys(keys, EMPTY_ACCESS_KEY_FILTERS))).toStrictEqual(['a', 'b']);
  });

  it.each([
    ['part of the key name, ignoring case', 'PROD'],
    ['part of the access key ID', 'X7Q2'],
  ])('matches a query against %s', (_case, query) => {
    const keys = [
      serviceKey({ keyName: 'production', accessKeyId: 'AKIDX7Q2000000000000' }),
      serviceKey({ keyName: 'staging', accessKeyId: 'AKIDOTHER00000000000' }),
    ];
    expect(
      keyNames(filterAccessKeys(keys, { ...EMPTY_ACCESS_KEY_FILTERS, query })),
      query,
    ).toStrictEqual(['production']);
  });

  it('keeps only the keys in the chosen region', () => {
    const keys = [
      serviceKey({ keyName: 'eu', region: S3Region.EuWest1 }),
      serviceKey({ keyName: 'us', region: S3Region.UsEast1 }),
    ];
    const filters = { ...EMPTY_ACCESS_KEY_FILTERS, region: S3Region.UsEast1 };
    expect(keyNames(filterAccessKeys(keys, filters))).toStrictEqual(['us']);
  });

  it('keeps only the keys with the chosen status', () => {
    const keys = [
      serviceKey({ keyName: 'live', status: 'active' }),
      serviceKey({ keyName: 'old', status: 'expired' }),
    ];
    const filters = { ...EMPTY_ACCESS_KEY_FILTERS, status: 'expired' as const };
    expect(keyNames(filterAccessKeys(keys, filters))).toStrictEqual(['old']);
  });

  it('keeps only the keys of the chosen type', () => {
    const keys = [serviceKey({ keyName: 'svc' }), personalKey({ keyName: 'mine' })];
    const filters = { ...EMPTY_ACCESS_KEY_FILTERS, type: 'principal' as const };
    expect(keyNames(filterAccessKeys(keys, filters))).toStrictEqual(['mine']);
  });

  it('applies every filter together', () => {
    const keys = [
      serviceKey({ keyName: 'prod-eu', region: S3Region.EuWest1 }),
      serviceKey({ keyName: 'prod-us', region: S3Region.UsEast1 }),
      serviceKey({ keyName: 'dev-us', region: S3Region.UsEast1 }),
    ];
    const filters = { ...EMPTY_ACCESS_KEY_FILTERS, query: 'prod', region: S3Region.UsEast1 };
    expect(keyNames(filterAccessKeys(keys, filters))).toStrictEqual(['prod-us']);
  });
});

describe('accessKeyRegions', () => {
  it('lists each region once, ordered by its display name', () => {
    const keys = [
      serviceKey({ region: S3Region.UsEast1 }),
      serviceKey({ region: S3Region.EuWest1 }),
      serviceKey({ region: S3Region.UsEast1 }),
    ];
    expect(accessKeyRegions(keys)).toStrictEqual([S3Region.EuWest1, S3Region.UsEast1]);
  });
});
