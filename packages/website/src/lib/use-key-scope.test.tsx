import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

const mockGetMe = vi.fn();
vi.mock('./api.js', () => ({ getMe: () => mockGetMe() }));

import { useKeyActionScope } from './use-key-scope.js';
import { seedPermissions } from './test-permissions.js';

function renderScope(role?: OrgRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (role) seedPermissions(client, role);
  return renderHook(() => useKeyActionScope(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

// `seedPermissions` writes userId 'user-1'.
const OWN = { createdBy: 'user-1' };
const THEIRS = { createdBy: 'user-2' };
/** Minted before attribution existed: the server lists these to manage_all only. */
const UNATTRIBUTED = {};

describe('useKeyActionScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockReturnValue(new Promise(() => {}));
  });

  it('lets a Member list, and revoke only what they minted', () => {
    const { result } = renderScope(OrgRole.Member);

    expect(result.current.mayList).toBe(true);
    expect(result.current.mayRevoke(OWN)).toBe(true);
    expect(result.current.mayRevoke(THEIRS)).toBe(false);
    // `undefined === undefined` must not hand an unclaimed key to everybody.
    expect(result.current.mayRevoke(UNATTRIBUTED)).toBe(false);
  });

  it('lets an Admin revoke every key, attributed or not', () => {
    const { result } = renderScope(OrgRole.Admin);

    expect(result.current.mayRevoke(OWN)).toBe(true);
    expect(result.current.mayRevoke(THEIRS)).toBe(true);
    expect(result.current.mayRevoke(UNATTRIBUTED)).toBe(true);
  });

  it('gives ReadOnly neither the list nor the action', () => {
    const { result } = renderScope(OrgRole.ReadOnly);

    expect(result.current.mayList).toBe(false);
    expect(result.current.mayRevoke(OWN)).toBe(false);
  });

  it('fails closed while /me is in flight', async () => {
    const { result } = renderScope();

    await waitFor(() => expect(result.current.mayList).toBe(false));
    expect(result.current.mayRevoke(OWN)).toBe(false);
  });

  it('answers the column header with the rows it will render', () => {
    const { result } = renderScope(OrgRole.Member);

    expect(result.current.mayRevokeAny([THEIRS, UNATTRIBUTED])).toBe(false);
    expect(result.current.mayRevokeAny([THEIRS, OWN])).toBe(true);
    expect(result.current.mayRevokeAny([])).toBe(false);
  });
});
