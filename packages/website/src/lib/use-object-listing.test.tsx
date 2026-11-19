import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { S3Region, type S3ObjectVersion } from '@filone/shared';

import type { ObjectListingPage, ObjectListingRequest } from './object-listing.js';

const mockFetchPage = vi.fn<(request: ObjectListingRequest) => Promise<ObjectListingPage>>();
vi.mock('./object-listing.js', () => ({
  fetchObjectListingPage: (request: ObjectListingRequest) => mockFetchPage(request),
}));

import { useObjectListing } from './use-object-listing.js';

function version(key: string): S3ObjectVersion {
  return {
    key,
    versionId: '',
    isLatest: true,
    isDeleteMarker: false,
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00.000Z',
  };
}

// Two pages of one folder: three rows, then one.
const firstPage: ObjectListingPage = {
  versions: [version('a'), version('b')],
  folders: ['sub/'],
  nextCursor: { kind: 'continuation', token: 'page-2' },
};
const secondPage: ObjectListingPage = { versions: [version('c')], folders: [] };

function servePages(request: ObjectListingRequest): Promise<ObjectListingPage> {
  const isSecond = request.cursor?.kind === 'continuation' && request.cursor.token === 'page-2';
  return Promise.resolve(isSecond ? secondPage : firstPage);
}

function renderListing(prefix = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ prefix: currentPrefix, search: currentSearch }) =>
      useObjectListing({
        bucketName: 'any-bucket',
        region: S3Region.EuWest1,
        versioning: false,
        prefix: currentPrefix,
        search: currentSearch,
        enabled: true,
      }),
    { wrapper, initialProps: { prefix, search: '' } },
  );
}

beforeEach(() => {
  mockFetchPage.mockReset();
  mockFetchPage.mockImplementation(servePages);
});

describe('useObjectListing', () => {
  it('numbers the first page’s rows from one and offers only Next', async () => {
    const { result } = renderListing();
    await waitFor(() => expect(result.current.page).toBeDefined());

    expect(result.current).toMatchObject({
      rangeStart: 1,
      rangeEnd: 3,
      hasPrevious: false,
      hasNext: true,
    });
  });

  it('fetches the next page ahead of the reader asking for it', async () => {
    renderListing();

    await waitFor(() =>
      expect(mockFetchPage).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { kind: 'continuation', token: 'page-2' } }),
      ),
    );
  });

  it('continues the row numbers on the next page', async () => {
    const { result } = renderListing();
    await waitFor(() => expect(result.current.hasNext).toBe(true));

    act(() => result.current.goToNextPage());
    await waitFor(() => expect(result.current.page).toBe(secondPage));

    expect(result.current).toMatchObject({
      rangeStart: 4,
      rangeEnd: 4,
      hasPrevious: true,
      hasNext: false,
    });
  });

  it('returns to the first page on Previous', async () => {
    const { result } = renderListing();
    await waitFor(() => expect(result.current.hasNext).toBe(true));
    act(() => result.current.goToNextPage());
    await waitFor(() => expect(result.current.page).toBe(secondPage));

    act(() => result.current.goToPreviousPage());

    expect(result.current).toMatchObject({ page: firstPage, rangeStart: 1, hasPrevious: false });
  });

  it('starts another folder from its first page', async () => {
    const { result, rerender } = renderListing();
    await waitFor(() => expect(result.current.hasNext).toBe(true));
    act(() => result.current.goToNextPage());
    await waitFor(() => expect(result.current.page).toBe(secondPage));

    rerender({ prefix: 'sub/', search: '' });

    expect(result.current).toMatchObject({ rangeStart: 1, hasPrevious: false });
    expect(mockFetchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ prefix: 'sub/', cursor: undefined }),
    );
  });

  it('lists the folder narrowed to names that start with the search', async () => {
    const { rerender } = renderListing('any-folder/');

    rerender({ prefix: 'any-folder/', search: 'rep' });

    await waitFor(() =>
      expect(mockFetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ prefix: 'any-folder/rep', cursor: undefined }),
      ),
    );
  });

  it('starts a new search from its first page', async () => {
    const { result, rerender } = renderListing();
    await waitFor(() => expect(result.current.hasNext).toBe(true));
    act(() => result.current.goToNextPage());
    await waitFor(() => expect(result.current.page).toBe(secondPage));

    rerender({ prefix: '', search: 'a' });

    expect(result.current).toMatchObject({ rangeStart: 1, hasPrevious: false });
  });
});
