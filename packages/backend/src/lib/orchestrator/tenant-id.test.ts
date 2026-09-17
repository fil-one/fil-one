import { describe, it, expect } from 'vitest';
import { isUuid, S3Region } from '@filone/shared';
import { FILONE_TENANT_ID_NAMESPACE, tenantIdFor, uuidV5 } from './tenant-id.ts';

const orgId = '00000000-0000-0000-0000-000000000001';
const otherOrgId = '00000000-0000-0000-0000-000000000002';

describe('uuidV5', () => {
  // The spec's own vector, independent of anything in this repo: it catches a
  // byte-order or nibble-masking mistake that a self-consistent test would not.
  it('matches the RFC 9562 DNS-namespace vector', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });
});

describe('tenantIdFor', () => {
  // The namespace and the derived values are frozen: changing either re-keys
  // every setup that is mid-flight between the PUT and the pointer write. These
  // two tests are what fails when someone edits them.
  it('derives ids under the frozen namespace', () => {
    expect(FILONE_TENANT_ID_NAMESPACE).toBe('ae825539-e796-4468-ade9-7907a47eeed2');
  });

  const pinnedIds: Record<S3Region, string> = {
    [S3Region.EuWest1]: '551afffe-c4ea-5f8c-bff5-a4b4f001b96b',
    [S3Region.UsEast1]: '1071119c-675a-5bc1-94be-cf6b7b096793',
    [S3Region.EuCentral3]: 'a0954109-1f09-5761-abc1-e09b636e92c0',
    [S3Region.UsEast9]: 'd2310af7-f01d-5c8d-b8fc-046aac9c348c',
  };

  it('pins the id derived for each region', () => {
    const derived = Object.fromEntries(
      Object.values(S3Region).map((region) => [region, tenantIdFor(orgId, region)]),
    );
    expect(derived).toStrictEqual(pinnedIds);
  });

  // The whole point: one Hilt serves several regions, so two regions must never
  // present it the same tenant id for the same org.
  it('derives a distinct id for every region', () => {
    const ids = Object.values(S3Region).map((region) => tenantIdFor(orgId, region));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('derives a distinct id for a different org in the same region', () => {
    expect(tenantIdFor(orgId, S3Region.EuCentral3)).not.toBe(
      tenantIdFor(otherOrgId, S3Region.EuCentral3),
    );
  });

  it('never derives the orgId itself', () => {
    const ids = Object.values(S3Region).map((region) => tenantIdFor(orgId, region));
    expect(ids).not.toContain(orgId);
  });

  for (const region of Object.values(S3Region)) {
    it(`is deterministic for ${region}`, () => {
      expect(tenantIdFor(orgId, region)).toBe(tenantIdFor(orgId, region));
    });

    it(`sets the version and variant nibbles for ${region}`, () => {
      expect(tenantIdFor(orgId, region)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    // The contract's TenantId schema is `format: uuid` plus a UUID pattern, and
    // the shared validator is that same shape — this ties the output to the wire.
    it(`produces a contract-legal UUID for ${region}`, () => {
      expect(isUuid(tenantIdFor(orgId, region))).toBe(true);
    });
  }
});
