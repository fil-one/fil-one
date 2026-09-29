import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { INSTATUS_PAGE_URL, type InstatusSummary } from '../lib/instatus.js';
import { queryKeys } from '../lib/query-client.js';
import { StatusIndicator } from './StatusIndicator.js';

function renderIndicator(variant: 'row' | 'pill', status?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  if (status) {
    const summary: InstatusSummary = {
      page: { name: 'Fil One', url: INSTATUS_PAGE_URL, status },
    };
    client.setQueryData(queryKeys.instatusSummary, summary);
  }
  return render(
    <QueryClientProvider client={client}>
      <StatusIndicator variant={variant} />
    </QueryClientProvider>,
  );
}

describe('StatusIndicator', () => {
  it.each(['row', 'pill'] as const)('renders nothing before the first read (%s)', (variant) => {
    const { container } = renderIndicator(variant);
    expect(container).toBeEmptyDOMElement();
  });

  it('the pill names the status for assistive technology and links to the status page', () => {
    renderIndicator('pill', 'UP');

    const link = screen.getByRole('link', { name: 'System status: All systems operational' });
    expect(link).toHaveAttribute('href', INSTATUS_PAGE_URL);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('falls back when the status is one it does not recognize', () => {
    renderIndicator('pill', 'SOMETHING_NEW');

    expect(
      screen.getByRole('link', { name: 'System status: Status unavailable' }),
    ).toBeInTheDocument();
  });

  it('the row shows the status as its label and links to the status page', () => {
    renderIndicator('row', 'HASISSUES');

    const link = screen.getByTestId('system-status');
    expect(link).toHaveAttribute('href', INSTATUS_PAGE_URL);
    expect(link).toHaveTextContent('Service disruption');
  });
});
