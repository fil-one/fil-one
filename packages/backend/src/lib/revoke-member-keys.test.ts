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
import type { AccessKeyToRevoke } from './member-keys.js';

const ORG_ID = 'org-1';
const ACTOR = userActor({ userId: 'admin-1' });

function keyToRevoke(id: string): AccessKeyToRevoke {
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

const KEYS = [keyToRevoke('0001'), keyToRevoke('0002'), keyToRevoke('0003')];

function revoke() {
  return revokeMemberKeys({
    orgId: ORG_ID,
    orgProfile: undefined,
    keys: KEYS,
    actor: ACTOR,
    reason: 'role_narrowing',
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
    // `refused` is absent rather than undefined, like every other optional
    // field a pass builds.
    expect(await revoke()).toStrictEqual({
      revoked: KEYS.map((key) => expect.objectContaining({ id: key.id })),
    });
  });

  it('stops at the first refusal', async () => {
    // Nothing has committed yet, so the caller leaves the role alone and the
    // retry is the same request. Revoking further buys nothing.
    mockRevokeAccessKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));

    const outcome = await revoke();

    expect(outcome.revoked.map((key) => key.id)).toStrictEqual(['0001']);
    expect(outcome.refused?.id).toBe('0002');
    expect(mockRevokeAccessKey).toHaveBeenCalledTimes(2);
  });

  it('treats a region with no tenant as a refusal rather than a crash', async () => {
    // Nothing to revoke at, which is a key still live like any other refusal.
    tenantReady = false;

    const outcome = await revoke();

    expect(outcome.revoked).toStrictEqual([]);
    expect(outcome.refused?.id).toBe('0001');
    expect(mockRevokeAccessKey).not.toHaveBeenCalled();
  });
});
