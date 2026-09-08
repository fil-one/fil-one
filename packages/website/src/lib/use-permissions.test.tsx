import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

const mockGetMe = vi.fn();
vi.mock('./api.js', () => ({ getMe: () => mockGetMe() }));

import { usePermissions, useHasPermission } from './use-permissions.js';
import { queryKeys } from './query-client.js';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function meWith(role: OrgRole | undefined): MeResponse {
  return {
    orgId: 'org-1',
    orgName: 'Acme',
    slug: 'acme',
    nameConfirmed: true,
    emailVerified: true,
    mfaEnrollments: [],
    ragAccess: false,
    orgsBeta: false,
    billingActive: true,
    userId: 'user-1',
    ...(role ? { role } : {}),
    permissions: role ? ROLE_PERMISSIONS[role] : [],
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('usePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports what the role holds', async () => {
    mockGetMe.mockResolvedValue(meWith(OrgRole.Member));
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(freshClient()) });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.has('objects.write')).toBe(true);
    expect(result.current.has('buckets.delete')).toBe(false);
  });

  it('holds nothing while /me is in flight', () => {
    mockGetMe.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(freshClient()) });

    // Fail-closed: a list that briefly defaulted to everything would flash a
    // Delete button at a ReadOnly member.
    expect(result.current.isPending).toBe(true);
    expect(result.current.has('buckets.read')).toBe(false);
  });

  it('holds nothing when /me fails', async () => {
    mockGetMe.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(freshClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.has('buckets.read')).toBe(false);
    // An unreadable /me is not the same claim as "you were removed".
    expect(result.current.isNotAMember).toBe(false);
  });

  it('reports the organizations beta, false until /me says otherwise', async () => {
    mockGetMe.mockResolvedValue({ ...meWith(OrgRole.Owner), orgsBeta: true });
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(freshClient()) });

    // Fail-closed like the permission list: the invite form is gated on this,
    // and a flag that briefly defaulted to on would offer a form the server
    // refuses.
    expect(result.current.orgsBeta).toBe(false);
    await waitFor(() => expect(result.current.orgsBeta).toBe(true));
  });

  it('names the caller with no membership row', async () => {
    mockGetMe.mockResolvedValue(meWith(undefined));
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(freshClient()) });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isNotAMember).toBe(true);
    expect(result.current.has('buckets.read')).toBe(false);
  });

  it('follows a role change without a remount', async () => {
    mockGetMe.mockResolvedValue(meWith(OrgRole.Admin));
    const client = freshClient();
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.has('buckets.delete')).toBe(true));

    act(() => {
      client.setQueryData(queryKeys.me, meWith(OrgRole.ReadOnly));
    });

    await waitFor(() => expect(result.current.has('buckets.delete')).toBe(false));
  });
});

describe('useHasPermission', () => {
  it('answers the single-permission question', async () => {
    mockGetMe.mockResolvedValue(meWith(OrgRole.ReadOnly));
    const { result } = renderHook(() => useHasPermission('objects.read'), {
      wrapper: wrapperFor(freshClient()),
    });

    await waitFor(() => expect(result.current).toBe(true));
  });
});
