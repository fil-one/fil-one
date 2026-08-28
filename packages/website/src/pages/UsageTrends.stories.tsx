import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UsageDataPoint, UsageTrendsResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client';
import { UsageTrends } from './UsageTrends';

/**
 * The dashboard's trend charts, which until now could only be seen by signing
 * in against an account that happened to hold the right data (FIL-1039).
 *
 * The stories that matter are the awkward ones: a flat week, a first day, an
 * empty account. Each of the shipped bugs in FIL-995 was invisible on a
 * healthy, rising series and obvious on one of these.
 */

// The series are keyed by end-of-day UTC, as the backend builds them. Fixed
// dates keep the stories stable rather than drifting with the clock.
const DAY = 24 * 60 * 60 * 1000;
const LAST_DAY = Date.UTC(2026, 7, 27, 23, 59, 59, 999);

function series(values: number[]): UsageDataPoint[] {
  return values.map((value, i) => ({
    date: new Date(LAST_DAY - (values.length - 1 - i) * DAY).toISOString(),
    value,
  }));
}

function trends(storage: number[], objects: number[]): UsageTrendsResponse {
  return { storage: series(storage), objects: series(objects) };
}

const MB = 1_000_000;

const FIXTURES = {
  /** A week that grows steadily: the case every version of this chart handled. */
  typical: trends(
    [6.1, 9.4, 13.8, 15.2, 19.6, 24.3, 27.1].map((n) => n * MB),
    [5, 9, 14, 16, 19, 21, 22],
  ),
  /**
   * The regression case. Four days at 7 objects sat below a `dataMin` baseline
   * and drew as empty columns, and the card summed the series to "94 total"
   * for an account holding 22.
   */
  lowBaseline: trends(
    [18.2, 18.2, 18.4, 18.4, 26.8, 27.1, 27.1].map((n) => n * MB),
    [7, 7, 7, 7, 22, 22, 22],
  ),
  /** Nothing changed all week. Every value is both the min and the max. */
  flat: trends(Array(7).fill(4.5 * MB), Array(7).fill(12)),
  /** A brand-new org: days were reported, all of them zero. */
  empty: trends(Array(7).fill(0), Array(7).fill(0)),
  /**
   * No days reported at all. Distinct from `empty`: the account may well hold
   * data, so the copy must not claim otherwise.
   */
  noData: { storage: [], objects: [] },
  /** Day one, with six days of nothing behind it. */
  firstDay: trends([0, 0, 0, 0, 0, 0, 1.2 * MB], [0, 0, 0, 0, 0, 0, 3]),
  /** Small enough that a byte axis has to reach for KB. */
  kilobytes: trends(
    [12, 40, 40, 96, 96, 140, 210].map((n) => n * 1000),
    [1, 3, 3, 6, 6, 9, 14],
  ),
  /** A terabyte account, to check the axis does not run out of room. */
  terabytes: trends(
    [0.8, 1.1, 1.1, 1.4, 1.9, 2.2, 2.4].map((n) => n * 1_000_000 * MB),
    [8_400, 9_100, 9_100, 11_200, 14_800, 16_050, 17_300],
  ),
} satisfies Record<string, UsageTrendsResponse>;

/**
 * 24 hourly buckets, for the hour-resolution axis. Storage barely moves inside
 * a day, which is the honest shape: the interesting line at this resolution is
 * egress (FIL-1098), not storage.
 */
const HOUR = 60 * 60 * 1000;
const LAST_HOUR = Date.UTC(2026, 7, 27, 12, 59, 59, 999);
const TWENTY_FOUR_HOURS: UsageTrendsResponse = {
  storage: Array.from({ length: 24 }, (_, i) => ({
    date: new Date(LAST_HOUR - (23 - i) * HOUR).toISOString(),
    value: (26 + i * 0.05) * MB,
  })),
  objects: Array.from({ length: 24 }, (_, i) => ({
    date: new Date(LAST_HOUR - (23 - i) * HOUR).toISOString(),
    value: 20 + Math.floor(i / 8),
  })),
};

/** 30 days of steady growth, for the wider period and its axis label density. */
const THIRTY_DAYS = trends(
  Array.from({ length: 30 }, (_, i) => (5 + i * 0.9) * MB),
  Array.from({ length: 30 }, (_, i) => 4 + Math.round(i * 1.7)),
);

function seed(data: UsageTrendsResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.usageTrends('24h'), TWENTY_FOUR_HOURS);
  client.setQueryData(queryKeys.usageTrends('7d'), data);
  client.setQueryData(queryKeys.usageTrends('30d'), THIRTY_DAYS);
  return client;
}

type Args = { fixture: keyof typeof FIXTURES };

const meta: Meta<Args> = {
  title: 'Pages/Dashboard/UsageTrends',
  argTypes: {
    fixture: { control: 'select', options: Object.keys(FIXTURES) },
  },
  args: { fixture: 'typical' },
  render: ({ fixture }) => {
    // Keyed so switching the control rebuilds the seeded client.
    const [client, setClient] = useState(() => seed(FIXTURES[fixture]));
    const [current, setCurrent] = useState(fixture);
    if (current !== fixture) {
      setCurrent(fixture);
      setClient(seed(FIXTURES[fixture]));
    }
    return (
      <QueryClientProvider client={client}>
        <div className="max-w-4xl">
          <UsageTrends />
        </div>
      </QueryClientProvider>
    );
  },
};

export default meta;
type Story = StoryObj<Args>;

export const Typical: Story = {};

/**
 * Both charts must start at zero. Before the fix the objects bars baselined at
 * the series minimum, so the first four days drew as nothing at all.
 */
export const LowBaseline: Story = { args: { fixture: 'lowBaseline' } };

/** A flat series still needs a readable axis, not a degenerate one. */
export const Flat: Story = { args: { fixture: 'flat' } };

/** A genuinely empty account, so the next step is named. */
export const Empty: Story = { args: { fixture: 'empty' } };

/**
 * The metrics pipeline returned nothing. Deliberately does NOT say "no usage
 * yet": that is a claim about the account, and this is a fact about the request.
 */
export const NoData: Story = { args: { fixture: 'noData' } };

export const FirstDay: Story = { args: { fixture: 'firstDay' } };

/** Small values: every tick shares one unit, none of them repeat. */
export const Kilobytes: Story = { args: { fixture: 'kilobytes' } };

export const Terabytes: Story = { args: { fixture: 'terabytes' } };

/** Nothing seeded, so the query never resolves and the skeleton holds. */
export const Loading: Story = {
  render: () => {
    const [client] = useState(
      () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    return (
      <QueryClientProvider client={client}>
        <div className="max-w-4xl">
          <UsageTrends />
        </div>
      </QueryClientProvider>
    );
  },
};

/**
 * 375px, where the two-column grid stacks.
 *
 * The viewport parameter is doing the work, deliberately without a fixed-width
 * wrapper. `sm:grid-cols-2` keys off the viewport, not the container, so a
 * narrow wrapper inside a wide viewport renders two 180px charts side by side:
 * a layout that cannot ship, presented as if it were the mobile one.
 */
export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
