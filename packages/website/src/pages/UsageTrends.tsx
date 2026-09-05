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
import { ChartLineIcon } from '@phosphor-icons/react/dist/ssr';

import type { UsageDataPoint, UsageTrendsPeriod, UsageTrendsResponse } from '@filone/shared';

import { Heading } from '../components/Heading/Heading';
import { formatBytes, bytesAxisFormatter } from '@filone/shared';
import { getUsageTrends } from '../lib/api.js';
import { formatDate, formatDateShort, formatDateTime, formatTimeShort } from '../lib/time.js';
import { niceScale } from '../lib/chart-scale.js';
import { queryKeys, USAGE_STALE_TIME } from '../lib/query-client.js';
import { Card } from '../components/Card';
import { IconBox } from '../components/IconBox.js';

const CHART_HEIGHT = 160;

/**
 * The chart cards carry a header row the empty state does not: a 19.5px line
 * plus its 12px margin. Adding it back keeps both cards the same height, so the
 * section does not jump when the first object lands.
 */
const EMPTY_STATE_HEADER_OFFSET = 32;

/**
 * Recharts grows a series in from zero over 1500ms by default, well outside the
 * 150/200ms the design system allows, and it replays on every period switch and
 * background refetch. It is also driven by `requestAnimationFrame`, so in a
 * background tab the series sits at frame zero: the chart paints its axes and
 * nothing else. A usage chart should be readable the moment it appears.
 */
const ANIMATE_SERIES = false;

/**
 * Object counts, for the fallback chart. A full count matches the rest of the
 * console (`ObjectBrowser` says "17,300 objects"); axis ticks go compact
 * because a spelled-out 20,000 overruns the gutter and clips off the left edge.
 */
const countFormatter = new Intl.NumberFormat(undefined, { notation: 'compact' });

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatCountTick(value: number): string {
  return countFormatter.format(value);
}

/** Shared axis and gridline styling, so the two charts cannot drift apart. */
const AXIS_TICK = { fontSize: 10, fill: 'var(--color-zinc-500)' };
const GRID_STROKE = 'var(--color-zinc-200)';
const SERIES_COLOR = 'var(--color-brand-600)';

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

type ChartTooltipProps = {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string;
  valueLabel: string;
  formatValue: (v: number) => string;
  formatLabel: (iso: string) => string;
};

function ChartTooltip({
  active,
  payload,
  label,
  valueLabel,
  formatValue,
  formatLabel,
}: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 shadow-md">
      <p className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        {formatLabel(label as string)}
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
        <span className="text-ui font-semibold text-zinc-900">{value}</span>
      </div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        {children}
      </ResponsiveContainer>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

/**
 * Held at the chart height so the section does not resize when the first
 * object lands and the charts take over.
 */
function TrendsEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <div
        className="flex flex-col items-center justify-center gap-2 text-center"
        style={{ height: CHART_HEIGHT + EMPTY_STATE_HEADER_OFFSET }}
      >
        <IconBox icon={ChartLineIcon} color="grey" size="md" />
        <p className="text-sm font-medium text-zinc-900">{title}</p>
        <p className="max-w-xs text-xs text-zinc-500">{description}</p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

/**
 * Storage is a stock: what the account holds right now, not what it
 * accumulated over the window. The latest sample is the figure, and summing the
 * series would count the same bytes once per bucket.
 */
function latestValue(series: UsageDataPoint[]): number {
  return series.length > 0 ? series[series.length - 1].value : 0;
}

/**
 * Egress is a flow: each point is bytes served during that bucket, so the
 * window's figure is the sum. This is the mirror image of `latestValue`, and
 * using the wrong one either way is the bug FIL-995 was filed for.
 */
function windowTotal(series: UsageDataPoint[]): number {
  return series.reduce((sum, p) => sum + p.value, 0);
}

function seriesMax(series: UsageDataPoint[]): number {
  return series.reduce((max, p) => Math.max(max, p.value), 0);
}

/**
 * Which of the two empty states a response earns, if either.
 *
 * The distinction matters, and the console already draws it elsewhere: on
 * BucketsPage, "No buckets yet" is deliberately withheld while a region is
 * down, because it is a claim about the account rather than about the request.
 * Same here. Days reported as zero mean the account is genuinely empty and the
 * next step is worth naming; no days reported at all means the metrics pipeline
 * gave us nothing, and saying "no usage yet" would be inventing a fact.
 */
type TrendsState = 'no-data' | 'no-usage' | 'ready';

function trendsState(series: NormalizedSeries): TrendsState {
  if (!series.received) return 'no-data';
  if (series.storage.length + series.egress.length === 0) return 'no-data';
  if (seriesMax(series.storage) === 0 && seriesMax(series.egress) === 0) return 'no-usage';
  return 'ready';
}

type NormalizedSeries = {
  /** Whether a response arrived at all, as opposed to one that arrived empty. */
  received: boolean;
  storage: UsageDataPoint[];
  objects: UsageDataPoint[];
  egress: UsageDataPoint[];
  /** Whether the response carried an egress series, as opposed to an empty one. */
  hasEgress: boolean;
};

/**
 * Reads the response defensively, because the type is not a runtime guarantee.
 *
 * `egress` is required on `UsageTrendsResponse`, but a deployed handler that
 * predates it does not send one, and this component can be live before that
 * handler is. Reading `.length` off the absent field threw and the error
 * boundary took the whole dashboard down with it.
 *
 * A missing series is also not an empty one. Charting an absent `egress` as
 * "0 B" would report no traffic on an account that may be serving plenty, on
 * the metric that disables accounts over the trial cap. So the second slot
 * falls back to object count, which every deployed handler does send.
 */
function normalizeSeries(trends: UsageTrendsResponse | undefined): NormalizedSeries {
  const egress = Array.isArray(trends?.egress) ? trends.egress : undefined;
  return {
    received: trends !== undefined,
    storage: Array.isArray(trends?.storage) ? trends.storage : [],
    objects: Array.isArray(trends?.objects) ? trends.objects : [],
    egress: egress ?? [],
    hasEgress: egress !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Section chrome
// ---------------------------------------------------------------------------

function PeriodToggle({
  period,
  onChange,
}: {
  period: UsageTrendsPeriod;
  onChange: (p: UsageTrendsPeriod) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-zinc-100/60 p-0.5">
      {PERIODS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={period === value}
          className={`rounded-md px-2.5 py-1 text-meta font-medium transition-colors ${
            period === value
              ? 'bg-white text-zinc-900 shadow-xs'
              : 'text-zinc-500 hover:text-zinc-900'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TrendsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="h-[180px] animate-pulse rounded-xl bg-zinc-100" />
      <div className="h-[180px] animate-pulse rounded-xl bg-zinc-100" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The dashboard offers the two day-resolution windows.
 *
 * The API and handler also answer '24h' (hourly), and the front end still
 * formats an hourly axis, but the dashboard does not offer it: whether the
 * upstream metrics stores hourly readings at all is unverified, and storage is
 * near-flat inside a day regardless. Hourly belongs on the usage page
 * (FIL-1099) alongside 90d, where egress makes it worth reading.
 */
const PERIODS: Array<{ value: UsageTrendsPeriod; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export function UsageTrends() {
  const [period, setPeriod] = useState<UsageTrendsPeriod>('7d');

  const { data, isPending } = useQuery({
    queryKey: queryKeys.usageTrends(period),
    queryFn: () => getUsageTrends(period),
    staleTime: USAGE_STALE_TIME,
  });

  const {
    storage: storageSeries,
    objects: objectsSeries,
    egress: egressSeries,
    hasEgress,
    received,
  } = normalizeSeries(data);

  const storageScale = niceScale(seriesMax(storageSeries), { tickCount: 5 });
  const egressScale = niceScale(seriesMax(egressSeries), { tickCount: 5 });
  const objectsScale = niceScale(seriesMax(objectsSeries), { tickCount: 6, integer: true });
  const formatStorageTick = bytesAxisFormatter(storageScale.domainMax);
  const formatEgressTick = bytesAxisFormatter(egressScale.domainMax);
  const state = trendsState({
    storage: storageSeries,
    objects: objectsSeries,
    egress: egressSeries,
    hasEgress,
    received,
  });

  /**
   * The second card is egress where the handler provides it, and object count
   * where it does not. Charting the flow and the stock through one BarChart
   * keeps their axis, baseline and tooltip identical by construction: Recharts
   * resolves children by type, so a shared wrapper component is not an option
   * and the alternative is duplicating the chart.
   */
  const secondary = hasEgress
    ? {
        label: 'Egress',
        value: formatBytes(windowTotal(egressSeries)),
        data: egressSeries,
        scale: egressScale,
        tickFormatter: formatEgressTick,
        formatValue: formatBytes,
      }
    : {
        label: 'Objects',
        value: `${formatCount(latestValue(objectsSeries))} total`,
        data: objectsSeries,
        scale: objectsScale,
        tickFormatter: formatCountTick,
        formatValue: formatCount,
      };

  // A 24-hour window repeats one date on every tick and varies only by hour;
  // the 7- and 30-day windows are the other way round.
  const hourly = period === '24h';
  const formatAxisLabel = hourly ? formatTimeShort : formatDateShort;
  const formatTooltipLabel = hourly ? formatDateTime : formatDate;

  return (
    <div className="mb-6">
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <Heading tag="h2" size="sm">
          Usage Trends
        </Heading>
        <PeriodToggle period={period} onChange={setPeriod} />
      </div>

      {state === 'no-data' && !isPending ? (
        <TrendsEmptyState
          title="No usage data for this period"
          description="No samples were reported for this window. Check back shortly."
        />
      ) : state === 'no-usage' ? (
        <TrendsEmptyState
          title="No usage yet"
          description="Upload your first object to start the trend."
        />
      ) : isPending && !received ? (
        <TrendsSkeleton />
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
                tickFormatter={formatAxisLabel}
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
                content={
                  <ChartTooltip
                    valueLabel="Storage"
                    formatValue={formatBytes}
                    formatLabel={formatTooltipLabel}
                  />
                }
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

          {/* Egress, or object count where the handler predates it. Bars either
              way, baselined at zero. */}
          <ChartCard label={secondary.label} value={secondary.value}>
            <BarChart data={secondary.data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
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
                tickFormatter={formatAxisLabel}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                width={40}
                domain={[0, secondary.scale.domainMax]}
                ticks={secondary.scale.ticks}
                tickFormatter={secondary.tickFormatter}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueLabel={secondary.label}
                    formatValue={secondary.formatValue}
                    formatLabel={formatTooltipLabel}
                  />
                }
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
