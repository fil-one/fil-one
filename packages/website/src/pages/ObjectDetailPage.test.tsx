import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, PlanId, S3Region, SubscriptionStatus } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';

// ---------------------------------------------------------------------------
// Mocks: the router, the network, and the object actions. Presigning never
// settles, so the metadata query stays pending for the whole test.
// ---------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  // A paid plan, so the Share control is enabled.
  getBilling: () =>
    Promise.resolve({
      subscription: { planId: PlanId.PayAsYouGo, status: SubscriptionStatus.Active },
    }),
}));

vi.mock('../lib/use-presign.js', () => ({
  batchPresign: () => new Promise(() => {}),
}));

vi.mock('../lib/use-object-actions.js', () => ({
  useObjectActions: () => ({
    deleteObject: vi.fn(),
    downloadObject: vi.fn(),
  }),
}));

// The share modal reports whether the page asked it to open. Its own body
// presigns a link, which this file is not about.
vi.mock('../components/ShareObjectModal', () => ({
  ShareObjectModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="share-object-modal" /> : null,
}));

import { ObjectDetailPage } from './ObjectDetailPage.js';

function renderLoadingPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
  render(
    <QueryClientProvider client={client}>
      <ObjectDetailPage bucketName="any-bucket" region={S3Region.EuWest1} objectKey="any-key" />
    </QueryClientProvider>,
  );
  // The page is still loading: only the skeleton stands in for the cards.
  expect(screen.getByRole('status', { name: 'Loading object details' })).toBeInTheDocument();
}

describe('ObjectDetailPage while the metadata loads', () => {
  it('opens the share dialog from the header Share control', async () => {
    renderLoadingPage();

    const share = screen.getByRole('button', { name: 'Share object' });
    await waitFor(() => expect(share).toBeEnabled());
    fireEvent.click(share);

    expect(screen.getByTestId('share-object-modal')).toBeInTheDocument();
  });

  it('opens the delete confirmation from the header Delete control', async () => {
    renderLoadingPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete object' }));

    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument();
  });
});
