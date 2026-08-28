import { useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { useQuery } from '@tanstack/react-query';

import type { UsageDataPoint, UsageTrendsResponse } from '@filone/shared';

import { Heading } from '../components/Heading/Heading';
import { formatBytes, bytesAxisFormatter } from '@filone/shared';
import { getUsageTrends } from '../lib/api.js';
import { formatDate, formatDateShort } from '../lib/time.js';
import { niceScale } from '../lib/chart-scale.js';
import { queryKeys, USAGE_STALE_TIME } from '../lib/query-client.js';
import { Card } from '../components/Card';

const CHART_HEIGHT = 160;

/**
 * Recharts grows a series in from zero over 1500ms by default, well outside the
 * 150/200ms the design system allows, and it replays on every period switch and
 * background refetch. It is also driven by `requestAnimationFrame`, so in a
 * background tab the series sits at frame zero: the chart paints its axes and
 * nothing else. A usage chart should be readable the moment it appears.
 */
const ANIMATE_SERIES = false;

/** Shared axis and gridline styling, so the two charts cannot drift apart. */
const AXIS_TICK = { fontSize: 10, fill: 'var(--color-zinc-500)' };
const GRID_STROKE = 'var(--color-zinc-200)';
const SERIES_COLOR = 'var(--color-brand-600)';

/**
 * Object counts, read two ways.
 *
 * A full count is what the rest of the console shows (`ObjectBrowser` says
 * "17,300 objects"), so the card total and the tooltip match it. An axis has
 * only the gutter's width to work with: spelled out, a 20,000 tick overruns it
 * and clips against the left edge of the chart, so ticks go compact.
 */
const countFormatter = new Intl.NumberFormat(undefined, { notation: 'compact' });

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatCountTick(value: number): string {
  return countFormatter.format(value);
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

type ChartTooltipProps = {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string;
  valueLabel: string;
  formatValue: (v: number) => string;
};

function ChartTooltip({ active, payload, label, valueLabel, formatValue }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 shadow-md">
      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        {formatDate(label as string)}
      </p>
      <p className="text-xs text-zinc-700">
        {valueLabel}: {formatValue(payload[0].value ?? 0)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart card
// ---------------------------------------------------------------------------

type ChartCardProps = {
  label: string;
  value: string;
  children: React.ReactElement;
};

function ChartCard({ label, value, children }: ChartCardProps) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="text-[13px] font-semibold text-zinc-900">{value}</span>
      </div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        {children}
      </ResponsiveContainer>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

/**
 * Storage and object count are both stocks: what the account holds right now,
 * not what it accumulated over the window. The latest sample is the total, and
 * summing the series would count the same objects once per day.
 */
function latestValue(series: UsageDataPoint[]): number {
  return series.length > 0 ? series[series.length - 1].value : 0;
}

function seriesMax(series: UsageDataPoint[]): number {
  return series.reduce((max, p) => Math.max(max, p.value), 0);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
] as const;

export function UsageTrends() {
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');

  const { data, isPending } = useQuery({
    queryKey: queryKeys.usageTrends(period),
    queryFn: () => getUsageTrends(period),
    staleTime: USAGE_STALE_TIME,
  });

  const trends: UsageTrendsResponse | null = data ?? null;
  const storageSeries = trends?.storage ?? [];
  const objectsSeries = trends?.objects ?? [];

  const storageScale = niceScale(seriesMax(storageSeries), { tickCount: 5 });
  const objectsScale = niceScale(seriesMax(objectsSeries), { tickCount: 6, integer: true });
  const formatStorageTick = bytesAxisFormatter(storageScale.domainMax);

  return (
    <div className="mb-6">
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <Heading tag="h2" size="sm">
          Usage Trends
        </Heading>
        <div className="flex items-center gap-1 rounded-lg bg-zinc-100/60 p-0.5">
          {PERIODS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setPeriod(value)}
              aria-pressed={period === value}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                period === value
                  ? 'bg-white text-zinc-900 shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {isPending && !trends ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="h-[180px] animate-pulse rounded-xl bg-zinc-100" />
          <div className="h-[180px] animate-pulse rounded-xl bg-zinc-100" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Storage — how much the account holds, day by day */}
          <ChartCard label="Storage" value={formatBytes(latestValue(storageSeries))}>
            <AreaChart data={storageSeries} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="storageGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={SERIES_COLOR} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={SERIES_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                horizontal={true}
                vertical={false}
                strokeDasharray="3 3"
                stroke={GRID_STROKE}
                strokeOpacity={0.6}
              />
              <XAxis
                dataKey="date"
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatDateShort}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                width={40}
                domain={[0, storageScale.domainMax]}
                ticks={storageScale.ticks}
                tickFormatter={formatStorageTick}
              />
              <Tooltip
                content={<ChartTooltip valueLabel="Storage" formatValue={formatBytes} />}
                cursor={{ stroke: GRID_STROKE, strokeWidth: 1 }}
              />
              {/* `linear`, not `monotone`: these are daily samples, and a spline
                  between them draws a curve nobody measured. */}
              <Area
                type="linear"
                dataKey="value"
                fill="url(#storageGradient)"
                stroke={SERIES_COLOR}
                strokeWidth={2}
                dot={false}
                isAnimationActive={ANIMATE_SERIES}
              />
            </AreaChart>
          </ChartCard>

          {/* Objects — a count, so bars, and bars baseline at zero */}
          <ChartCard label="Objects" value={`${formatCount(latestValue(objectsSeries))} total`}>
            <BarChart data={objectsSeries} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid
                horizontal={true}
                vertical={false}
                strokeDasharray="3 3"
                stroke={GRID_STROKE}
                strokeOpacity={0.6}
              />
              <XAxis
                dataKey="date"
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatDateShort}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                width={40}
                allowDecimals={false}
                domain={[0, objectsScale.domainMax]}
                ticks={objectsScale.ticks}
                tickFormatter={formatCountTick}
              />
              <Tooltip
                content={<ChartTooltip valueLabel="Objects" formatValue={formatCount} />}
                cursor={{ fill: 'var(--color-zinc-100)', opacity: 0.6 }}
              />
              <Bar
                dataKey="value"
                fill={SERIES_COLOR}
                radius={[2, 2, 0, 0]}
                isAnimationActive={ANIMATE_SERIES}
              />
            </BarChart>
          </ChartCard>
        </div>
      )}
    </div>
  );
}

export default UsageTrends;
