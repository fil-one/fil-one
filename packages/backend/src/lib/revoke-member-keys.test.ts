import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';
import type { AccessKeySummary } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

let regionsWithoutTenant: S3Region[] = [];
vi.mock('./service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (region: S3Region) => ({
    id: 'aurora',
    region,
    accessModel: 'scoped-keys',
    isTenantReady: () => (regionsWithoutTenant.includes(region) ? null : `tenant:${region}`),
    deleteAccessKey: vi.fn(),
  }),
}));

const mockRevokeAccessKey = vi.fn();
// Partial: the error class is the real one, since the classification below is
// an `instanceof` test against it.
vi.mock('./key-revocation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./key-revocation.js')>()),
  revokeAccessKey: (...args: unknown[]) => mockRevokeAccessKey(...args),
}));

import { userActor } from './audit.js';
import { RevocationNotRecordedError } from './key-revocation.js';
import { revokeMemberKeys } from './revoke-member-keys.js';
import type { AccessKeyToRevoke } from './member-keys.js';

const ORG_ID = 'org-1';
const ACTOR = userActor({ userId: 'admin-1' });

function keyToRevoke(id: string, region: S3Region = S3Region.UsEast1): AccessKeyToRevoke {
  return {
    id,
    keyName: `key ${id}`,
    accessKeyId: `AKIAEXAMPLE${id}`,
    region,
    createdAt: '2026-02-01T00:00:00.000Z',
    createdBy: 'member-1',
    reason: 'exceeds_role',
    excess: [],
  };
}

const KEYS = [keyToRevoke('0001'), keyToRevoke('0002', S3Region.EuWest1), keyToRevoke('0003')];

function revoke() {
  return revokeMemberKeys({
    orgId: ORG_ID,
    orgProfile: undefined,
    keys: KEYS,
    actor: ACTOR,
    reason: 'role_narrowing',
  });
}

/** The vendor refuses these keys and revokes every other. */
function vendorRefuses(...keyIds: string[]) {
  mockRevokeAccessKey.mockImplementation(({ keyId }: { keyId: string }) =>
    keyIds.includes(keyId) ? Promise.reject(new Error('down')) : Promise.resolve(),
  );
}

const ids = (keys: AccessKeySummary[]) => keys.map((key) => key.id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mockRevokeAccessKey.mockResolvedValue(undefined);
  regionsWithoutTenant = [];
});

describe('revokeMemberKeys', () => {
  it('revokes every key, in the order given, when nothing refuses', async () => {
    expect(await revoke()).toStrictEqual({
      revoked: KEYS.map((key) => expect.objectContaining({ id: key.id })),
      refused: [],
    });
  });

  it('attempts every key past a refusal, and names the one refused', async () => {
    // Nothing has committed, so the caller leaves the role alone either way.
    // Going on costs a key for a change that will not land, and buys the caller
    // every failure at once and a retry with less left to do.
    vendorRefuses('0002');

    const outcome = await revoke();

    expect(ids(outcome.revoked)).toStrictEqual(['0001', '0003']);
    expect(ids(outcome.refused)).toStrictEqual(['0002']);
    expect(mockRevokeAccessKey).toHaveBeenCalledTimes(3);
  });

  it('names every refusal, in the order the keys were given', async () => {
    vendorRefuses('0003', '0001');

    const outcome = await revoke();

    expect(ids(outcome.revoked)).toStrictEqual(['0002']);
    expect(ids(outcome.refused)).toStrictEqual(['0001', '0003']);
  });

  it('counts a key the vendor deleted but nothing recorded as revoked', async () => {
    // The credential is gone, so the client is already broken: calling this a
    // refusal would stop the role change and tell the member a dead key still
    // works. What survives is the row, which is why it is logged apart.
    mockRevokeAccessKey.mockImplementation(({ keyId }: { keyId: string }) =>
      keyId === '0002' ? Promise.reject(new RevocationNotRecordedError(keyId)) : Promise.resolve(),
    );

    const outcome = await revoke();

    expect(ids(outcome.revoked)).toStrictEqual(['0001', '0002', '0003']);
    expect(outcome.refused).toStrictEqual([]);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('its row survives');
  });

  it('treats a region with no tenant as a refusal rather than a crash, and the rest proceed', async () => {
    // Nothing to revoke at, which is a key still live like any other refusal.
    regionsWithoutTenant = [S3Region.EuWest1];

    const outcome = await revoke();

    expect(ids(outcome.revoked)).toStrictEqual(['0001', '0003']);
    expect(ids(outcome.refused)).toStrictEqual(['0002']);
    expect(mockRevokeAccessKey).toHaveBeenCalledTimes(2);
    expect(mockRevokeAccessKey).not.toHaveBeenCalledWith(
      expect.objectContaining({ keyId: '0002' }),
    );
  });
});
