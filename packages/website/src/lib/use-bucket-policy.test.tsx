import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole, S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

import { seedPermissions } from './test-permissions.js';
import { queryKeys } from './query-client.js';

const mockGet = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
vi.mock('./bucket-policy-api.js', async () => ({
  ...(await vi.importActual<typeof import('./bucket-policy-api.js')>('./bucket-policy-api.js')),
  getBucketPolicy: (...a: unknown[]) => mockGet(...a),
  putBucketPolicy: (...a: unknown[]) => mockPut(...a),
  deleteBucketPolicy: (...a: unknown[]) => mockDelete(...a),
}));
vi.mock('./access-model.js', () => ({
  isIamRegion: (region: string) => region === 'us-east-9',
}));
vi.mock('./api.js', async () => ({
  ...(await vi.importActual<typeof import('./api.js')>('./api.js')),
  getMe: vi.fn(() => new Promise(() => {})),
}));

import { useBucketPolicy } from './use-bucket-policy.js';

const policy: BucketPolicy = {
  statement: [{ effect: 'allow', principal: ['user-1'], action: ['s3:GetObject'] }],
};

function renderPolicy(region: S3Region = S3Region.UsEast9, role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useBucketPolicy('photos', region), { wrapper }) };
}

describe('useBucketPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ policy, etag: '"v1"' });
  });

  it('reads the policy for an Owner on an iam region', async () => {
    const { result } = renderPolicy();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.snapshot).toStrictEqual({ policy, etag: '"v1"' });
    expect(mockGet).toHaveBeenCalledWith('photos', S3Region.UsEast9);
  });

  it('asks nothing on a scoped-keys region, or for a role without the permission', () => {
    const scoped = renderPolicy(S3Region.EuWest1);
    expect(scoped.result.current.enabled).toBe(false);
    expect(scoped.result.current.loading).toBe(false);
    expect(scoped.result.current.snapshot).toBeUndefined();

    const member = renderPolicy(S3Region.UsEast9, OrgRole.Member);
    expect(member.result.current.enabled).toBe(false);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('writes a save into the cache and invalidates the bucket\u2019s keys', async () => {
    mockPut.mockResolvedValue({ etag: '"v2"', created: false });
    const { client, result } = renderPolicy();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const setData = vi.spyOn(client, 'setQueryData');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    // The refetch the invalidation triggers answers the saved document.
    mockGet.mockResolvedValue({ policy, etag: '"v2"' });

    await act(() => result.current.save.mutateAsync({ policy, etag: '"v1"' }));

    expect(mockPut).toHaveBeenCalledWith('photos', S3Region.UsEast9, { policy, etag: '"v1"' });
    expect(setData).toHaveBeenCalledWith(queryKeys.bucketPolicy('photos', S3Region.UsEast9), {
      policy,
      etag: '"v2"',
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.bucketAccessKeys('photos', S3Region.UsEast9),
    });
    await waitFor(() => expect(result.current.snapshot?.etag).toBe('"v2"'));
  });

  it('reports a save that lost to another writer as a conflict', async () => {
    mockPut.mockRejectedValue(
      Object.assign(new Error('changed'), { status: 409, code: ApiErrorCode.POLICY_CONFLICT }),
    );
    const { result } = renderPolicy();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save.mutateAsync({ policy, etag: '"stale"' }).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.conflict).toBe(true));
  });

  it('clears the cache when the policy is removed', async () => {
    mockDelete.mockResolvedValue(undefined);
    const { client, result } = renderPolicy();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const setData = vi.spyOn(client, 'setQueryData');
    mockGet.mockResolvedValue(null);

    await act(() => result.current.remove.mutateAsync({ etag: '"v1"' }));

    expect(setData).toHaveBeenCalledWith(queryKeys.bucketPolicy('photos', S3Region.UsEast9), null);
    await waitFor(() => expect(result.current.snapshot).toBeNull());
  });
});
