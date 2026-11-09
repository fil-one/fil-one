import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';
import type { S3ObjectVersion } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import type { useObjectActions } from '../lib/use-object-actions.js';
import { ObjectsPanel } from './BucketObjectsPanel';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

// Each row's Share control reads the plan; left unsettled, as it is not what
// these tests are about.
vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  getBilling: () => new Promise(() => {}),
}));

/** Enough objects to show the search and sort controls. */
const VERSIONS: S3ObjectVersion[] = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((key) => ({
  key,
  sizeBytes: 1,
  lastModified: '2026-01-01T00:00:00Z',
  versionId: `v-${key}`,
  isLatest: true,
  isDeleteMarker: false,
}));

// The panel only hands these to the browser; none is called here.
const OBJECT_ACTIONS = {
  deleteObject: vi.fn(),
  deleteObjects: vi.fn(),
  downloadObject: vi.fn(),
  downloading: null,
} as unknown as ReturnType<typeof useObjectActions>;

function panel(bucketName: string) {
  return (
    <ObjectsPanel
      loading={false}
      bucketName={bucketName}
      region={S3Region.UsEast1}
      versions={VERSIONS}
      versioningEnabled={false}
      currentPrefix=""
      onPrefixChange={vi.fn()}
      objectActions={OBJECT_ACTIONS}
      mayUpload={false}
      mayDelete={false}
      activeAccessKeyCount={0}
      accessKeysLoading={false}
      accessKeysFailed={false}
      permissionsLoading={false}
      mayCreateKeys={false}
      onAddKeyOpenChange={vi.fn()}
      onShowKeys={vi.fn()}
      listingTruncated={false}
      totalObjectCount={VERSIONS.length}
    />
  );
}

describe('ObjectsPanel', () => {
  it('opens another bucket without the search typed in the previous one', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Owner);
    const wrap = (node: React.ReactNode) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(wrap(panel('any-bucket')));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search objects by name' }), {
      target: { value: 'nothing-matches' },
    });
    expect(screen.getByText('No matching objects')).toBeInTheDocument();

    // The route stays mounted across a bucket change, so this is a re-render.
    rerender(wrap(panel('other-bucket')));

    expect(screen.getByRole('searchbox', { name: 'Search objects by name' })).toHaveValue('');
    expect(screen.queryByText('No matching objects')).not.toBeInTheDocument();
  });
});
