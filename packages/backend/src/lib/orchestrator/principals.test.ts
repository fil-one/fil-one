import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrgRole } from '@filone/shared';

vi.mock('sst', () => ({ Resource: { UserInfoTable: { name: 'UserInfoTable' } } }));

const mockGetOrgProfile = vi.fn();
const mockAddRegistered = vi.fn(async (_orgId: string, _id: string, _ids: string[]) => {});
const mockListMembers = vi.fn();

// `getRegisteredPrincipals` stays real: the test then covers how the
// `${id}Principals` set is read off the PROFILE row, not just that a helper was
// called.
vi.mock('../org-profile.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../org-profile.ts')>()),
  getOrgProfile: (orgId: string) => mockGetOrgProfile(orgId),
  addRegisteredPrincipals: (orgId: string, id: string, ids: string[]) =>
    mockAddRegistered(orgId, id, ids),
}));
vi.mock('../org-membership.ts', () => ({ listMembers: (orgId: string) => mockListMembers(orgId) }));

const { registerMemberPrincipals } = await import('./principals.ts');

const member = (userId: string, role: OrgRole) => ({
  orgId: 'org-1',
  userId,
  role,
});
const createFakeIamMethods = () =>
  ({ syncMember: vi.fn(async () => {}) }) as unknown as Parameters<
    typeof registerMemberPrincipals
  >[0] & { syncMember: ReturnType<typeof vi.fn> };

describe('registerMemberPrincipals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddRegistered.mockResolvedValue(undefined);
  });

  it('registers every member the profile does not already record', async () => {
    mockGetOrgProfile.mockResolvedValue(undefined);
    mockListMembers.mockResolvedValue([
      member('alice', OrgRole.Owner),
      member('bob', OrgRole.Member),
    ]);
    const iamMethods = createFakeIamMethods();

    await registerMemberPrincipals(iamMethods, 'forgeDev', 'org-1', 'tenant-1');

    expect(iamMethods.syncMember.mock.calls).toEqual([
      ['tenant-1', 'alice'],
      ['tenant-1', 'bob'],
    ]);
    expect(mockAddRegistered).toHaveBeenCalledWith('org-1', 'forgeDev', ['alice', 'bob']);
  });

  it('syncs no principal when every member is already registered', async () => {
    mockGetOrgProfile.mockResolvedValue({ forgeDevPrincipals: { SS: ['alice', 'bob'] } });
    mockListMembers.mockResolvedValue([
      member('alice', OrgRole.Owner),
      member('bob', OrgRole.Member),
    ]);
    const iamMethods = createFakeIamMethods();

    await registerMemberPrincipals(iamMethods, 'forgeDev', 'org-1', 'tenant-1');

    expect(iamMethods.syncMember).not.toHaveBeenCalled();
    expect(mockAddRegistered).not.toHaveBeenCalled();
  });

  it('registers only the member missing from the set', async () => {
    mockGetOrgProfile.mockResolvedValue({ forgeDevPrincipals: { SS: ['alice'] } });
    mockListMembers.mockResolvedValue([
      member('alice', OrgRole.Owner),
      member('carol', OrgRole.Admin),
    ]);
    const iamMethods = createFakeIamMethods();

    await registerMemberPrincipals(iamMethods, 'forgeDev', 'org-1', 'tenant-1');

    expect(iamMethods.syncMember.mock.calls).toEqual([['tenant-1', 'carol']]);
    expect(mockAddRegistered).toHaveBeenCalledWith('org-1', 'forgeDev', ['carol']);
  });
});
