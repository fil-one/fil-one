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
 * empty account, a single spike. Each of the bugs FIL-995 was filed for was
 * invisible on a healthy rising series and obvious on one of these.
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

function trends(storage: number[], objects: number[], egress: number[]): UsageTrendsResponse {
  return { storage: series(storage), objects: series(objects), egress: series(egress) };
}

const MB = 1_000_000;
const GB = 1_000 * MB;

const FIXTURES = {
  /** A week that grows steadily, with traffic to match. */
  typical: trends(
    [6.1, 9.4, 13.8, 15.2, 19.6, 24.3, 27.1].map((n) => n * MB),
    [5, 9, 14, 16, 19, 21, 22],
    [120, 340, 180, 410, 260, 520, 300].map((n) => n * MB),
  ),
  /**
   * The regression case, now on the egress bars.
   *
   * Four quiet-but-not-silent days sat below a `dataMin` baseline and drew as
   * empty columns, so the chart reported no traffic on days that served real
   * bytes. The same scale bug, on the metric where under-reporting matters
   * most: egress is what disables an account over its trial cap (FIL-869).
   */
  lowBaseline: trends(
    [18.2, 18.2, 18.4, 18.4, 26.8, 27.1, 27.1].map((n) => n * MB),
    [7, 7, 7, 7, 22, 22, 22],
    [40, 40, 40, 40, 620, 640, 610].map((n) => n * MB),
  ),
  /**
   * One heavy day in a quiet week. A flow metric's most common real shape, and
   * the one a truncated axis flattens worst.
   */
  spike: trends(
    [22, 22, 22, 23, 23, 23, 23].map((n) => n * MB),
    [18, 18, 18, 19, 19, 19, 19],
    [15, 12, 18, 1_400, 22, 19, 14].map((n) => n * MB),
  ),
  /** Nothing changed all week. Every value is both the min and the max. */
  flat: trends(Array(7).fill(4.5 * MB), Array(7).fill(12), Array(7).fill(80 * MB)),
  /** Stored, but never read. Egress is legitimately flat at zero. */
  noEgress: trends(
    [4, 8, 12, 16, 20, 24, 28].map((n) => n * MB),
    [3, 6, 9, 12, 15, 18, 21],
    Array(7).fill(0),
  ),
  /** A brand-new org: days were reported, all of them zero. */
  empty: trends(Array(7).fill(0), Array(7).fill(0), Array(7).fill(0)),
  /**
   * No days reported at all. Distinct from `empty`: the account may well hold
   * data, so the copy must not claim otherwise.
   */
  noData: { storage: [], objects: [], egress: [] },
  /** Day one, with six days of nothing behind it. */
  firstDay: trends(
    [0, 0, 0, 0, 0, 0, 1.2 * MB],
    [0, 0, 0, 0, 0, 0, 3],
    [0, 0, 0, 0, 0, 0, 2.4 * MB],
  ),
  /** Small enough that a byte axis has to reach for KB. */
  kilobytes: trends(
    [12, 40, 40, 96, 96, 140, 210].map((n) => n * 1000),
    [1, 3, 3, 6, 6, 9, 14],
    [4, 18, 9, 32, 11, 44, 26].map((n) => n * 1000),
  ),
  /** A terabyte account, to check neither axis runs out of room. */
  terabytes: trends(
    [0.8, 1.1, 1.1, 1.4, 1.9, 2.2, 2.4].map((n) => n * 1_000 * GB),
    [8_400, 9_100, 9_100, 11_200, 14_800, 16_050, 17_300],
    [180, 240, 210, 320, 280, 410, 350].map((n) => n * GB),
  ),
  /**
   * Approaching the 2 TB trial egress cap, which is a threshold that disables
   * the account rather than an allowance (FIL-869). The reason a trend beats a
   * progress bar: this shape says roughly when, not just how far.
   */
  nearTrialCap: trends(
    [140, 145, 148, 152, 155, 158, 160].map((n) => n * GB),
    [92_000, 94_500, 96_000, 98_200, 99_100, 101_000, 102_400],
    [210, 260, 240, 330, 380, 420, 460].map((n) => n * GB),
  ),
} satisfies Record<string, UsageTrendsResponse>;

/**
 * What a handler deployed before the egress series returns.
 *
 * Typed as a full response because that is the lie the type tells at runtime:
 * reading `.length` off the absent field took the dashboard to the error
 * boundary. The second slot falls back to object count rather than reporting
 * absent egress as "0 B".
 */
const LEGACY_BACKEND = {
  storage: series([6.1, 9.4, 13.8, 15.2, 19.6, 24.3, 27.1].map((n) => n * MB)),
  objects: series([5, 9, 14, 16, 19, 21, 22]),
} as UsageTrendsResponse;

/** 30 days of steady growth, for the wider period and its axis label density. */
const THIRTY_DAYS = trends(
  Array.from({ length: 30 }, (_, i) => (5 + i * 0.9) * MB),
  Array.from({ length: 30 }, (_, i) => 4 + Math.round(i * 1.7)),
  Array.from({ length: 30 }, (_, i) => (60 + ((i * 37) % 240)) * MB),
);

function seed(data: UsageTrendsResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
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
    // Re-seeded when the control changes, so each fixture gets a clean client.
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
 * Both charts must start at zero. Before the fix the bars baselined at the
 * series minimum, so the four quiet days drew as nothing at all.
 */
export const LowBaseline: Story = { args: { fixture: 'lowBaseline' } };

/** One heavy day. The axis has to accommodate it without flattening the rest. */
export const Spike: Story = { args: { fixture: 'spike' } };

/** A flat series still needs a readable axis, not a degenerate one. */
export const Flat: Story = { args: { fixture: 'flat' } };

/** Storage climbing while egress sits at zero: a real state, not an empty one. */
export const NoEgress: Story = { args: { fixture: 'noEgress' } };

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

/** The case that makes an egress trend worth more than a progress bar. */
export const NearTrialCap: Story = { args: { fixture: 'nearTrialCap' } };

/**
 * A handler deployed before the egress series. Falls back to object count
 * instead of crashing, and instead of claiming zero traffic.
 */
export const LegacyBackend: Story = {
  render: () => {
    const [client] = useState(() => seed(LEGACY_BACKEND));
    return (
      <QueryClientProvider client={client}>
        <div className="max-w-4xl">
          <UsageTrends />
        </div>
      </QueryClientProvider>
    );
  },
};

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
