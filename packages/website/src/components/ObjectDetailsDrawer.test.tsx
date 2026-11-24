import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { OrgRole, S3Region } from '@filone/shared';
import type { ObjectMetadataResponse, S3ObjectVersion } from '@filone/shared';

// Nothing in these tests reaches S3: every request stays in flight, so a test
// that seeds no details sees the panel as it is before the HEAD request answers.
// A test that needs S3 to answer sets that answer once.
const { batchPresign } = vi.hoisted(() => ({
  batchPresign: vi.fn<(region: string, ops: { op: string }[]) => Promise<unknown>>(
    () => new Promise(() => {}),
  ),
}));
vi.mock('../lib/use-presign.js', () => ({ batchPresign }));

import { S3RequestError } from '../lib/aurora-s3.js';
import { queryClient, queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from './Toast/ToastProvider.js';
import { ObjectDetailsDrawer, type ObjectDetailsDrawerProps } from './ObjectDetailsDrawer';

const BUCKET = 'any-bucket';
const REGION = S3Region.UsEast1;
const KEY = 'any-folder/any-file.bin';

const listed: S3ObjectVersion = {
  key: KEY,
  versionId: 'any-version',
  sizeBytes: 2_097_152,
  lastModified: '2026-10-21T14:32:00Z',
  isLatest: true,
  isDeleteMarker: false,
};

function renderDrawer(
  props: Partial<ObjectDetailsDrawerProps> = {},
  details?: Partial<ObjectMetadataResponse>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
  if (details) {
    const metadataKey = queryKeys.objectMetadata(BUCKET, KEY, props.versionId);
    client.setQueryDefaults(metadataKey, { staleTime: Infinity });
    client.setQueryData(metadataKey, {
      key: KEY,
      sizeBytes: listed.sizeBytes,
      lastModified: listed.lastModified,
      metadata: {},
      ...details,
    });
  }
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <ObjectDetailsDrawer
          bucketName={BUCKET}
          region={REGION}
          objectKey={KEY}
          listed={listed}
          versioningEnabled={false}
          objectLockEnabled={false}
          onDownload={() => {}}
          onDelete={() => Promise.resolve()}
          onClose={() => {}}
          {...props}
        />
      </ToastProvider>
    ),
  });
  const objectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([objectRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function siblings() {
  return { position: 2, total: 3, onPrevious: vi.fn(), onNext: vi.fn() };
}

describe('ObjectDetailsDrawer', () => {
  afterEach(() => {
    queryClient.clear();
    batchPresign.mockImplementation(() => new Promise(() => {}));
  });

  it('focuses the panel itself on open, so no button shows its tooltip', async () => {
    renderDrawer({ siblings: { position: 2, total: 3, onPrevious: vi.fn(), onNext: vi.fn() } });

    const panel = await screen.findByTestId('object-details-drawer-panel');
    await waitFor(() => expect(panel).toHaveFocus());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it("shows the listing's size before the object's own details arrive", async () => {
    renderDrawer();

    expect(await screen.findByText('2.1 MB')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('shows the type once the details arrive', async () => {
    renderDrawer({}, { contentType: 'application/zip' });

    expect(await screen.findByText('ZIP archive')).toBeInTheDocument();
  });

  it('shows the S3 URI', async () => {
    renderDrawer();

    expect(await screen.findByTitle(`s3://${BUCKET}/${KEY}`)).toBeInTheDocument();
  });

  it('keeps Download in the bar pinned under the details', async () => {
    renderDrawer();

    const bar = await screen.findByTestId('object-details-drawer-actions');

    expect(within(bar).getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('shows Delete on the bar, with no menu to open', async () => {
    renderDrawer();

    const bar = await screen.findByTestId('object-details-drawer-actions');

    expect(within(bar).getByRole('button', { name: 'Delete object' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
  });

  it('copies the object page address, not the bucket page', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    renderDrawer();

    fireEvent.click(await screen.findByTestId('object-details-drawer-copy-link'));

    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/buckets/${BUCKET}/objects?key=${encodeURIComponent(KEY)}&region=${REGION}`,
    );
  });

  it('groups the S3 URI and ETag apart from the facts about the file', async () => {
    renderDrawer({}, { etag: '"any-etag"' });

    const identifiers = await screen.findByTestId('object-identifiers');

    expect(within(identifiers).getByText('S3 URI')).toBeInTheDocument();
    expect(within(identifiers).getByText('ETag')).toBeInTheDocument();
    expect(within(identifiers).queryByText('Size')).not.toBeInTheDocument();
  });

  it('shows a retention whose date has passed as ended', async () => {
    renderDrawer(
      { objectLockEnabled: true },
      { retention: { mode: 'COMPLIANCE', retainUntilDate: '2020-05-02T00:00:00Z' } },
    );

    const retention = await screen.findByTestId('object-retention');

    expect(within(retention).getByText(/^Compliance, ended /)).toBeInTheDocument();
  });

  it('holds the preview at loading until the type arrives, rather than guessing from the name', async () => {
    // .html has no preview by name alone, but its content type gives it one
    renderDrawer({ objectKey: 'any-page.html' });

    expect(await screen.findByRole('status', { name: 'Loading preview' })).toBeInTheDocument();
    expect(screen.queryByText('No preview for this file type')).not.toBeInTheDocument();
  });

  it('says the object no longer exists, with nothing to act on, when S3 has no such object', async () => {
    // The HEAD request waits on the bucket's settings, which no test API answers
    queryClient.setQueryData(queryKeys.bucket(BUCKET, REGION), { bucket: {} });
    // Only the HEAD request fails; the key's history stays in flight
    batchPresign.mockImplementation((_region, ops) =>
      ops[0]?.op === 'headObject'
        ? Promise.reject(new S3RequestError('S3 request failed with status 404', 404))
        : new Promise(() => {}),
    );
    renderDrawer();

    expect(await screen.findByText('This object no longer exists')).toBeInTheDocument();
    expect(screen.queryByText(/S3 request failed/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('object-details-drawer-actions')).not.toBeInTheDocument();
  });

  it(`leaves S3's "null" version ID out of the facts`, async () => {
    renderDrawer({ versionId: 'null', versioningEnabled: true }, {});

    await screen.findByTestId('object-identifiers');

    expect(screen.queryByText('Version ID')).not.toBeInTheDocument();
  });

  it('disables Next on the last object in the folder', async () => {
    renderDrawer({ siblings: { ...siblings(), onNext: undefined } });

    expect(await screen.findByTestId('object-details-drawer-next')).toBeDisabled();
  });

  it('expands to the object page for the version on screen', async () => {
    renderDrawer({ versionId: 'any-older-version' });

    const expand = await screen.findByTestId('object-details-drawer-expand');

    expect(expand.getAttribute('href')).toBe(
      `/buckets/${BUCKET}/objects?key=${encodeURIComponent(KEY)}&region=${REGION}&versionId=any-older-version`,
    );
  });
});
