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
  getBucketPolicy: (...args: unknown[]) => mockGet(...args),
  putBucketPolicy: (...args: unknown[]) => mockPut(...args),
  deleteBucketPolicy: (...args: unknown[]) => mockDelete(...args),
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
  Statement: [{ Effect: 'Allow', Principal: ['user-1'], Action: ['s3:GetObject'] }],
};

function renderUseBucketPolicy(region: S3Region = S3Region.UsEast9, role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useBucketPolicy('photos', region), { wrapper }) };
}

async function renderLoaded() {
  const rendered = renderUseBucketPolicy();
  await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
  // Later refetches never answer, so the cache holds what the hook wrote.
  mockGet.mockReturnValue(new Promise(() => {}));
  return rendered;
}

async function saveIgnoringError(
  result: { current: ReturnType<typeof useBucketPolicy> },
  etag: string,
) {
  await act(async () => {
    await result.current.save.mutateAsync({ policy, etag }).catch(() => undefined);
  });
}

describe('useBucketPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ policy, etag: '"v1"' });
  });

  it('reads the policy for an Owner on an iam region', async () => {
    const { result } = renderUseBucketPolicy();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current).toMatchObject({
      isAvailable: true,
      isLoading: false,
      hasLoadFailed: false,
      snapshot: { policy, etag: '"v1"' },
    });
    expect(mockGet).toHaveBeenCalledWith('photos', S3Region.UsEast9);
  });

  it('does not fetch the policy on a service-keys region', () => {
    const { result } = renderUseBucketPolicy(S3Region.EuWest1);

    expect(result.current).toMatchObject({
      isAvailable: false,
      isLoading: false,
      snapshot: undefined,
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('does not fetch the policy for a Member', () => {
    const { result } = renderUseBucketPolicy(S3Region.UsEast9, OrgRole.Member);

    expect(result.current).toMatchObject({
      isAvailable: false,
      isLoading: false,
      snapshot: undefined,
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports hasLoadFailed and the message when the read fails', async () => {
    mockGet.mockRejectedValue(new Error('Bucket not found'));
    const { result } = renderUseBucketPolicy();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current).toMatchObject({
      hasLoadFailed: true,
      errorMessage: 'Bucket not found',
    });
  });

  it('hides the cached snapshot after a downgrade', async () => {
    const { client, result } = await renderLoaded();

    act(() => seedPermissions(client, OrgRole.Member));

    await waitFor(() => expect(result.current.isAvailable).toBe(false));
    expect(result.current.snapshot).toBeUndefined();
  });

  it('calls putBucketPolicy with the policy and ETag', async () => {
    mockPut.mockResolvedValue({ etag: '"v2"' });
    const { result } = await renderLoaded();

    await act(() => result.current.save.mutateAsync({ policy, etag: '"v1"' }));

    expect(mockPut).toHaveBeenCalledWith('photos', S3Region.UsEast9, { policy, etag: '"v1"' });
  });

  it('caches the saved policy with the ETag the PUT returned', async () => {
    mockPut.mockResolvedValue({ etag: '"v2"' });
    const { result } = await renderLoaded();

    await act(() => result.current.save.mutateAsync({ policy, etag: '"v1"' }));

    await waitFor(() => expect(result.current.snapshot).toStrictEqual({ policy, etag: '"v2"' }));
  });

  it('invalidates the bucket’s access keys after a save', async () => {
    mockPut.mockResolvedValue({ etag: '"v2"' });
    const { client, result } = await renderLoaded();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await act(() => result.current.save.mutateAsync({ policy, etag: '"v1"' }));

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.bucketAccessKeys('photos', S3Region.UsEast9),
    });
  });

  it('sets hasConflict when a save fails with POLICY_CONFLICT', async () => {
    mockPut.mockRejectedValue(
      Object.assign(new Error('changed'), { status: 409, code: ApiErrorCode.POLICY_CONFLICT }),
    );
    const { result } = await renderLoaded();

    await saveIgnoringError(result, '"stale"');

    await waitFor(() => expect(result.current.hasConflict).toBe(true));
  });

  it('leaves hasConflict false for any other error', async () => {
    mockPut.mockRejectedValue(Object.assign(new Error('Internal error'), { status: 500 }));
    const { result } = await renderLoaded();

    await saveIgnoringError(result, '"v1"');

    await waitFor(() => expect(result.current.save.isError).toBe(true));
    expect(result.current.hasConflict).toBe(false);
  });

  it('caches null after the policy is deleted', async () => {
    mockDelete.mockResolvedValue(undefined);
    const { result } = await renderLoaded();

    await act(() => result.current.remove.mutateAsync({ etag: '"v1"' }));

    expect(mockDelete).toHaveBeenCalledWith('photos', S3Region.UsEast9, '"v1"');
    await waitFor(() => expect(result.current.snapshot).toBeNull());
  });
});
