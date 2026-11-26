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
  role: OrgRole = OrgRole.Owner,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
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

  it.each([
    ["the object's own row, when it was deleted", undefined, 'This object was deleted'],
    ['an older delete marker', 'any-marker', 'This version is a delete marker'],
  ])(
    'says a delete marker has no content, asks S3 for nothing and offers no actions, for %s',
    async (_case, versionId, title) => {
      // The HEAD request waits on the bucket's settings, which no test API answers
      queryClient.setQueryData(queryKeys.bucket(BUCKET, REGION), { bucket: {} });
      renderDrawer({ versionId, listed: { ...listed, isDeleteMarker: true } });

      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.queryByTestId('object-details-drawer-actions')).not.toBeInTheDocument();
      expect(batchPresign).not.toHaveBeenCalledWith(REGION, [
        expect.objectContaining({ op: 'headObject' }),
      ]);
    },
  );

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

    expect(await screen.findByTestId('object-details-drawer-next')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  describe('stepping from the keyboard', () => {
    it.each([
      ['onNext', 'j'],
      ['onNext', 'ArrowDown'],
      ['onPrevious', 'k'],
      ['onPrevious', 'ArrowUp'],
    ] as const)('calls %s on %s, pressed straight after opening', async (handler, key) => {
      const steps = siblings();
      renderDrawer({ siblings: steps });
      const panel = await screen.findByTestId('object-details-drawer-panel');
      await waitFor(() => expect(panel).toHaveFocus());

      fireEvent.keyDown(panel, { key });

      expect(steps[handler]).toHaveBeenCalledOnce();
    });

    it.each([
      ['Shift', { shiftKey: true }],
      ['Cmd', { metaKey: true }],
      ['Ctrl', { ctrlKey: true }],
      ['Alt', { altKey: true }],
    ])('does not step on a key held with %s, which belongs to the browser', async (_, modifier) => {
      const steps = siblings();
      renderDrawer({ siblings: steps });

      fireEvent.keyDown(await screen.findByTestId('object-details-drawer-panel'), {
        key: 'ArrowDown',
        ...modifier,
      });

      expect(steps.onNext).not.toHaveBeenCalled();
    });

    // The tags the panel's field, text preview and players render as
    it.each(['input', 'textarea', 'select', 'pre', 'video', 'audio'])(
      'leaves the keys to a focused %s inside the panel',
      async (tag) => {
        const steps = siblings();
        renderDrawer({ siblings: steps });
        const panel = await screen.findByTestId('object-details-drawer-panel');
        const element = document.createElement(tag);
        panel.append(element);

        fireEvent.keyDown(element, { key: 'ArrowDown' });

        expect(steps.onNext).not.toHaveBeenCalled();
      },
    );

    it('keeps the object on screen when a key is pressed in the Delete confirmation', async () => {
      const steps = siblings();
      renderDrawer({ siblings: steps });
      fireEvent.click(await screen.findByRole('button', { name: 'Delete object' }));

      fireEvent.keyDown(await screen.findByTestId('confirm-dialog'), { key: 'j' });

      expect(steps.onNext).not.toHaveBeenCalled();
    });

    it('keeps the object on screen when a key is pressed in the Share modal', async () => {
      const steps = siblings();
      // A Member cannot read billing, so Share is offered without a plan to check
      renderDrawer({ siblings: steps }, undefined, OrgRole.Member);
      fireEvent.click(await screen.findByRole('button', { name: 'Share' }));

      fireEvent.keyDown(await screen.findByTestId('share-object-modal'), { key: 'j' });

      expect(steps.onNext).not.toHaveBeenCalled();
    });

    it('keeps focus on Next, and the keys working, once Next reaches the last object', async () => {
      const steps = { ...siblings(), onNext: undefined };
      renderDrawer({ siblings: steps });
      const next = await screen.findByTestId('object-details-drawer-next');
      next.focus();

      fireEvent.click(next);
      fireEvent.keyDown(next, { key: 'k' });

      expect(next).toHaveFocus();
      expect(steps.onPrevious).toHaveBeenCalledOnce();
    });

    it.each([
      ['Previous object', 'Up arrow or K', 'ArrowUp K'],
      ['Next object', 'Down arrow or J', 'ArrowDown J'],
    ])('names the keys for %s to screen readers', async (name, spoken, shortcuts) => {
      renderDrawer({ siblings: siblings() });

      const button = await screen.findByRole('button', { name });

      expect(button).toHaveAccessibleDescription(`Shortcut: ${spoken}`);
      expect(button).toHaveAttribute('aria-keyshortcuts', shortcuts);
    });

    it.each([
      ['Previous object', '↑ or K'],
      ['Next object', '↓ or J'],
    ])('names the keys for %s in its tooltip', async (name, shown) => {
      renderDrawer({ siblings: siblings() });

      fireEvent.mouseEnter(await screen.findByRole('button', { name }));

      expect(await screen.findByRole('tooltip')).toHaveTextContent(`${name}${shown}`);
    });

    it('announces the object on screen after a step, and not on open', async () => {
      renderDrawer({ siblings: siblings() });
      const announcement = await screen.findByTestId('object-details-drawer-announcement');
      expect(announcement).toBeEmptyDOMElement();

      fireEvent.keyDown(screen.getByTestId('object-details-drawer-panel'), { key: 'j' });

      expect(announcement).toHaveTextContent('any-file.bin, 2 of 3');
    });
  });

  it('expands to the object page for the version on screen', async () => {
    renderDrawer({ versionId: 'any-older-version' });

    const expand = await screen.findByTestId('object-details-drawer-expand');

    expect(expand.getAttribute('href')).toBe(
      `/buckets/${BUCKET}/objects?key=${encodeURIComponent(KEY)}&region=${REGION}&versionId=any-older-version`,
    );
  });
});
