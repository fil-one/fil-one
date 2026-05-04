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

import type { UsageTrendsResponse } from '@filone/shared';

import { Heading } from '../components/Heading/Heading';
import { formatBytes, formatBytesShort } from '@filone/shared';
import { getActivity } from '../lib/api.js';
import { formatDate } from '../lib/time.js';
import { queryKeys } from '../lib/query-client.js';

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
// Component
// ---------------------------------------------------------------------------

export function UsageTrends() {
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');

  const { data, isPending } = useQuery({
    queryKey: queryKeys.activityTrends(period),
    queryFn: () => getActivity({ period }),
  });

  const trends: UsageTrendsResponse | null = data?.trends ?? null;
  const storageSeries = trends?.storage ?? [];
  const latestStorage =
    storageSeries.length > 0 ? storageSeries[storageSeries.length - 1].value : 0;
  const latestObjects = trends?.objects.reduce((sum, p) => sum + p.value, 0) ?? 0;

  return (
    <div className="mb-6">
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <Heading tag="h2" size="sm">
          Usage Trends
        </Heading>
        <div className="flex items-center gap-1 rounded-lg bg-[rgba(243,244,246,0.6)] p-0.5">
          <button
            type="button"
            onClick={() => setPeriod('7d')}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              period === '7d'
                ? 'bg-white text-zinc-900 shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)]'
                : 'text-zinc-500 hover:text-zinc-900'
            }`}
          >
            7 days
          </button>
          <button
            type="button"
            onClick={() => setPeriod('30d')}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              period === '30d'
                ? 'bg-white text-zinc-900 shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)]'
                : 'text-zinc-500 hover:text-zinc-900'
            }`}
          >
            30 days
          </button>
        </div>
      </div>

      {isPending && !trends ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="h-[180px] animate-pulse rounded-lg bg-zinc-100" />
          <div className="h-[180px] animate-pulse rounded-lg bg-zinc-100" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Storage chart — AreaChart */}
          <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                STORAGE
              </span>
              <span className="text-[13px] font-semibold text-zinc-900">
                {formatBytes(latestStorage)}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart
                data={trends?.storage ?? []}
                margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="storageGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0080FF" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#0080FF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  horizontal={true}
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke="var(--color-zinc-200)"
                  strokeOpacity={0.6}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#677183' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatDate}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#677183' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  tickCount={5}
                  tickFormatter={formatBytesShort}
                  domain={['dataMin', 'dataMax']}
                />
                <Tooltip
                  content={<ChartTooltip valueLabel="Storage" formatValue={formatBytes} />}
                  cursor={{ stroke: 'var(--color-zinc-200)', strokeWidth: 1 }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  fill="url(#storageGradient)"
                  stroke="#0080FF"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Objects chart — BarChart */}
          <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                OBJECTS
              </span>
              <span className="text-[13px] font-semibold text-zinc-900">{latestObjects} total</span>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart
                data={trends?.objects ?? []}
                margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  horizontal={true}
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke="var(--color-zinc-200)"
                  strokeOpacity={0.6}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#677183' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatDate}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#677183' }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                  tickCount={6}
                  allowDecimals={false}
                  domain={['dataMin', 'dataMax']}
                />
                <Tooltip
                  content={<ChartTooltip valueLabel="Objects" formatValue={(v) => v.toString()} />}
                  cursor={{ fill: 'var(--color-zinc-100)', opacity: 0.6 }}
                />
                <Bar dataKey="value" fill="#0080FF" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

export default UsageTrends;
