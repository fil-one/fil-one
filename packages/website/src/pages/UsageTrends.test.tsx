import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UsageDataPoint, UsageTrendsResponse } from '@filone/shared';

import { UsageTrends } from './UsageTrends.js';

const mockGetUsageTrends = vi.fn();

vi.mock('../lib/api.js', () => ({
  getUsageTrends: (...args: unknown[]) => mockGetUsageTrends(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const LAST_DAY = Date.UTC(2026, 7, 27, 23, 59, 59, 999);

function series(values: number[]): UsageDataPoint[] {
  return values.map((value, i) => ({
    date: new Date(LAST_DAY - (values.length - 1 - i) * DAY).toISOString(),
    value,
  }));
}

function renderTrends() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsageTrends />
    </QueryClientProvider>,
  );
}

describe('UsageTrends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders both charts with their window figures', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: series([10, 20, 30]),
      objects: series([1, 2, 3]),
      egress: series([100, 200, 300]),
    } satisfies UsageTrendsResponse);

    renderTrends();

    // Storage is a stock, so the last reading. Egress is a flow, so the sum.
    expect(await screen.findByText('30 B')).toBeInTheDocument();
    expect(screen.getByText('600 B')).toBeInTheDocument();
  });

  it('charts egress rather than object count when the handler provides it', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: series([10]),
      objects: series([7]),
      egress: series([5]),
    } satisfies UsageTrendsResponse);

    renderTrends();

    expect(await screen.findByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('Egress')).toBeInTheDocument();
    expect(screen.queryByText('Objects')).not.toBeInTheDocument();
  });

  /**
   * The dashboard went to the error boundary against a deployed handler that
   * predated the egress series: `trends.egress.length` threw on the absent
   * field. The response type says egress is required, which is exactly why this
   * has to be tested rather than trusted.
   */
  it('survives a response with no egress series, as an older backend sends', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: series([10, 20, 30]),
      objects: series([1, 2, 3]),
    } as UsageTrendsResponse);

    renderTrends();

    expect(await screen.findByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('30 B')).toBeInTheDocument();
  });

  /**
   * An absent egress series must never be drawn as "0 B": that reports no
   * traffic on an account that may be serving plenty, on the metric that
   * disables accounts over the trial cap. Object count is sent by every
   * deployed handler, so the second slot falls back to it.
   */
  it('falls back to the objects chart when the response carries no egress', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: series([10, 20, 30]),
      objects: series([1, 2, 3]),
    } as UsageTrendsResponse);

    renderTrends();

    expect(await screen.findByText('Objects')).toBeInTheDocument();
    expect(screen.getByText('3 total')).toBeInTheDocument();
    expect(screen.queryByText('Egress')).not.toBeInTheDocument();
    expect(screen.queryByText('0 B')).not.toBeInTheDocument();
  });

  it('charts a genuinely empty egress series, which is a fact rather than a gap', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: series([10, 20, 30]),
      objects: series([1, 2, 3]),
      egress: series([0, 0, 0]),
    } satisfies UsageTrendsResponse);

    renderTrends();

    expect(await screen.findByText('Egress')).toBeInTheDocument();
    expect(screen.getByText('0 B')).toBeInTheDocument();
  });

  it('names the next step when every reported day is zero', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: series([0, 0, 0]),
      objects: series([0, 0, 0]),
      egress: series([0, 0, 0]),
    } satisfies UsageTrendsResponse);

    renderTrends();

    expect(await screen.findByText('No usage yet')).toBeInTheDocument();
  });

  it('does not claim the account is empty when no days were reported', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: [],
      objects: [],
      egress: [],
    } satisfies UsageTrendsResponse);

    renderTrends();

    expect(await screen.findByText('No usage data for this period')).toBeInTheDocument();
    expect(screen.queryByText('No usage yet')).not.toBeInTheDocument();
  });

  it('requests the selected period', async () => {
    mockGetUsageTrends.mockResolvedValue({
      storage: series([10]),
      objects: series([1]),
      egress: series([2]),
    } satisfies UsageTrendsResponse);

    renderTrends();

    await waitFor(() => expect(mockGetUsageTrends).toHaveBeenCalledWith('7d'));
  });
});
