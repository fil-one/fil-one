import { test, expect } from '@playwright/test';
import {
  isUnexpired,
  parseRestrictionFixture,
  assertStagingRestrictionProof,
  assertDistinctTenantMappings,
} from './restriction-fixture.util.ts';

const fixture = () => ({
  disposable: true,
  targetUserId: 'any-target',
  targetOrganizationId: 'any-target-org',
  controlUserId: 'any-control',
  controlOrganizationId: 'any-control-org',
  controlStorageState: '.auth/any-control.json',
  objects: Object.fromEntries(
    ['eu-west-1', 'us-east-1'].map((region) => [
      region,
      { bucket: 'any-bucket', key: 'any-key', sha256: 'a'.repeat(64) },
    ]),
  ),
});

test.describe('restriction isolation fixture', () => {
  test('accepts only the bound staging stack before any status change', () => {
    expect(() => assertStagingRestrictionProof('staging')).not.toThrow();
    expect(() => assertStagingRestrictionProof('production')).toThrow('bound SST staging stack');
    expect(() => assertStagingRestrictionProof('')).toThrow('bound SST staging stack');
  });

  test('requires distinct provisioned tenant mappings in both measured providers', () => {
    const target = { 'eu-west-1': 'any-aurora', 'us-east-1': 'any-fth' };
    const control = { 'eu-west-1': 'other-aurora', 'us-east-1': 'other-fth' };
    expect(() => assertDistinctTenantMappings(target, control)).not.toThrow();
    expect(() =>
      assertDistinctTenantMappings(target, { ...control, 'eu-west-1': target['eu-west-1'] }),
    ).toThrow('Distinct provisioned target and control tenants required');
    expect(() =>
      assertDistinctTenantMappings(target, { ...control, 'us-east-1': undefined }),
    ).toThrow('Distinct provisioned target and control tenants required');
  });
  test('accepts an explicit distinct disposable control and pre-existing objects', () => {
    expect(
      parseRestrictionFixture(JSON.stringify(fixture()), 'any-target', ['any-suite-user']),
    ).toStrictEqual(fixture());
  });

  for (const [name, changes] of [
    ['not disposable', { disposable: false }],
    ['wrong target', { targetUserId: 'different-target' }],
    ['same user', { controlUserId: 'any-target' }],
    ['same Organization', { controlOrganizationId: 'any-target-org' }],
    ['reset by suite setup', { controlUserId: 'any-suite-user' }],
    ['missing authentication state', { controlStorageState: '' }],
  ] as const)
    test(`rejects a fixture that is ${name} before any status helper can run`, () => {
      expect(() =>
        parseRestrictionFixture(JSON.stringify({ ...fixture(), ...changes }), 'any-target', [
          'any-suite-user',
        ]),
      ).toThrow('Distinct disposable restriction fixtures required');
    });

  test('requires a digest and pre-existing object in each measured provider', () => {
    const input = fixture();
    delete input.objects['us-east-1'];
    expect(() => parseRestrictionFixture(JSON.stringify(input), 'any-target')).toThrow(
      'Existing control objects and SHA-256 digests required in Aurora and FTH',
    );
  });

  for (const [expiry, expected] of [
    ['2026-11-19T12:00:01Z', true],
    ['2026-11-19T12:00:00Z', false],
    ['2026-11-19T11:59:59Z', false],
    ['not-an-expiry', false],
  ] as const)
    test(`classifies expiry ${expiry} without mistaking expiry for revocation`, () => {
      expect(isUnexpired(expiry, Date.parse('2026-11-19T12:00:00Z'))).toBe(expected);
    });
});
