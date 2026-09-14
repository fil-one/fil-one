import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFetchInstatusSummary = vi.fn();

// Spread the real module: `INSTATUS_PAGE_URL`/`getStatusDisplay` are pure and
// used as-is; only the network call needs stubbing.
vi.mock('../lib/instatus.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/instatus.js')>()),
  fetchInstatusSummary: (...args: unknown[]) => mockFetchInstatusSummary(...args),
}));

import { SystemStatusPill } from './SystemStatusPill';

function renderPill() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SystemStatusPill />
    </QueryClientProvider>,
  );
}

describe('SystemStatusPill', () => {
  it('renders nothing before the first read lands', () => {
    mockFetchInstatusSummary.mockReturnValue(new Promise(() => {}));
    const { container } = renderPill();

    expect(container).toBeEmptyDOMElement();
  });

  it('links to the status page once operational', async () => {
    mockFetchInstatusSummary.mockResolvedValue({ page: { status: 'UP' } });
    renderPill();

    const link = await screen.findByRole('link', {
      name: 'System status: All systems operational',
    });
    expect(link).toHaveAttribute('href', 'https://status.fil.one');
    expect(screen.getByText('All systems operational')).toBeInTheDocument();
  });

  it('names a service disruption', async () => {
    mockFetchInstatusSummary.mockResolvedValue({ page: { status: 'HASISSUES' } });
    renderPill();

    expect(await screen.findByText('Service disruption')).toBeInTheDocument();
  });

  it('falls back when the status is one it does not recognize', async () => {
    mockFetchInstatusSummary.mockResolvedValue({ page: { status: 'SOMETHING_NEW' } });
    renderPill();

    await waitFor(() => {
      expect(screen.getByText('Status unavailable')).toBeInTheDocument();
    });
  });
});
