import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';
import { useRagAccess } from './use-rag-access.js';
import { queryKeys } from './query-client.js';

const mockGetMe = vi.fn();
vi.mock('./api.js', () => ({
  getMe: () => mockGetMe(),
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(qc: QueryClient) {
  return function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function meWith(ragAccess: boolean): MeResponse {
  return {
    orgId: 'org-1',
    orgName: 'Example Corp',
    emailVerified: true,
    email: 'user@example.com',
    mfaEnrollments: [],
    ragAccess,
  };
}

describe('useRagAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when me.ragAccess is true', () => {
    const qc = makeClient();
    mockGetMe.mockResolvedValue(meWith(true));
    qc.setQueryData(queryKeys.me, meWith(true));

    const { result } = renderHook(() => useRagAccess(), { wrapper: wrapperFor(qc) });

    expect(result.current).toBe(true);
  });

  it('returns false when me.ragAccess is false', () => {
    const qc = makeClient();
    mockGetMe.mockResolvedValue(meWith(false));
    qc.setQueryData(queryKeys.me, meWith(false));

    const { result } = renderHook(() => useRagAccess(), { wrapper: wrapperFor(qc) });

    expect(result.current).toBe(false);
  });

  it('returns false while me data is not yet loaded', () => {
    const qc = makeClient();
    // Keep the query pending so no data is available on first render.
    mockGetMe.mockReturnValue(new Promise<MeResponse>(() => {}));

    const { result } = renderHook(() => useRagAccess(), { wrapper: wrapperFor(qc) });

    expect(result.current).toBe(false);
  });

  it('re-renders to true when the me query result changes', async () => {
    const qc = makeClient();
    // Keep the underlying fetch pending so the cached value drives the result
    // and a background refetch can't clobber it mid-test.
    mockGetMe.mockReturnValue(new Promise<MeResponse>(() => {}));
    qc.setQueryData(queryKeys.me, meWith(false));

    const { result } = renderHook(() => useRagAccess(), { wrapper: wrapperFor(qc) });
    expect(result.current).toBe(false);

    act(() => {
      qc.setQueryData(queryKeys.me, meWith(true));
    });

    await waitFor(() => expect(result.current).toBe(true));
  });
});
