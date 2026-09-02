import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

let tenantReady = true;
vi.mock('./service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (region: string) => ({
    id: 'aurora',
    region,
    accessModel: 'scoped-keys',
    isTenantReady: () => (tenantReady ? `tenant:${region}` : null),
    deleteAccessKey: vi.fn(),
  }),
}));

const mockRevokeAccessKey = vi.fn();
vi.mock('./key-revocation.js', () => ({
  revokeAccessKey: (...args: unknown[]) => mockRevokeAccessKey(...args),
}));

import { userActor } from './audit.js';
import { revokeMemberKeys } from './revoke-member-keys.js';
import type { DoomedKey } from './member-keys.js';

const ORG_ID = 'org-1';
const ACTOR = userActor({ userId: 'admin-1' });

function doomed(id: string): DoomedKey {
  return {
    id,
    keyName: `key ${id}`,
    accessKeyId: `AKIAEXAMPLE${id}`,
    region: S3Region.UsEast1,
    createdAt: '2026-02-01T00:00:00.000Z',
    createdBy: 'member-1',
    reason: 'exceeds_role',
    excess: [],
  };
}

const KEYS = [doomed('0001'), doomed('0002'), doomed('0003')];

function revoke(onFailure?: 'stop' | 'continue') {
  return revokeMemberKeys({
    orgId: ORG_ID,
    orgProfile: undefined,
    keys: KEYS,
    actor: ACTOR,
    reason: 'role_narrowing',
    ...(onFailure ? { onFailure } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mockRevokeAccessKey.mockResolvedValue(undefined);
  tenantReady = true;
});

describe('revokeMemberKeys', () => {
  it('revokes every key in order when nothing refuses', async () => {
    expect(await revoke()).toStrictEqual({
      revoked: KEYS.map((key) => expect.objectContaining({ id: key.id })),
      failed: [],
    });
  });

  it('stops at the first refusal before the membership write', async () => {
    // Nothing has committed yet, so the caller leaves the role alone and the
    // retry is the same request. Revoking further buys nothing.
    mockRevokeAccessKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));

    const outcome = await revoke('stop');

    expect(outcome.revoked.map((key) => key.id)).toStrictEqual(['0001']);
    expect(outcome.failed.map((key) => key.id)).toStrictEqual(['0002']);
    expect(mockRevokeAccessKey).toHaveBeenCalledTimes(2);
  });

  it('carries on past a refusal after the membership write, and names them all', async () => {
    // The member already holds the narrower role, so every key still above it
    // should go and the ones that will not have to be named.
    mockRevokeAccessKey
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('down'));

    const outcome = await revoke('continue');

    expect(outcome.revoked.map((key) => key.id)).toStrictEqual(['0002']);
    expect(outcome.failed.map((key) => key.id)).toStrictEqual(['0001', '0003']);
    expect(mockRevokeAccessKey).toHaveBeenCalledTimes(3);
  });

  it('treats a region with no tenant as a refusal rather than a crash', async () => {
    // Nothing to revoke at, which is a key still live like any other refusal.
    tenantReady = false;

    const outcome = await revoke('continue');

    expect(outcome.revoked).toStrictEqual([]);
    expect(outcome.failed.map((key) => key.id)).toStrictEqual(['0001', '0002', '0003']);
    expect(mockRevokeAccessKey).not.toHaveBeenCalled();
  });
});
