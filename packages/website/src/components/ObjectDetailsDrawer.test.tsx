import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
vi.mock('../lib/use-presign.js', () => ({
  batchPresign: () => new Promise(() => {}),
}));

import { queryKeys } from '../lib/query-client.js';
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

  it.each([
    ['j', 'onNext'],
    ['ArrowDown', 'onNext'],
    ['k', 'onPrevious'],
    ['ArrowUp', 'onPrevious'],
  ] as const)('steps to the neighbouring object on %s', async (key, handler) => {
    const steps = siblings();
    renderDrawer({ siblings: steps });

    fireEvent.keyDown(await screen.findByTestId('object-details-drawer-panel'), { key });

    expect(steps[handler]).toHaveBeenCalledOnce();
  });

  it('leaves arrow keys to a focused text preview', async () => {
    const steps = siblings();
    renderDrawer({ siblings: steps });
    const panel = await screen.findByTestId('object-details-drawer-panel');
    const pre = document.createElement('pre');
    panel.append(pre);

    fireEvent.keyDown(pre, { key: 'ArrowDown' });

    expect(steps.onNext).not.toHaveBeenCalled();
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
