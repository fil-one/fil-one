import { useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_STORAGE_7D = [
  { date: 'Feb 4', value: 4200000000 },
  { date: 'Feb 5', value: 4800000000 },
  { date: 'Feb 6', value: 5000000000 },
  { date: 'Feb 7', value: 5200000000 },
  { date: 'Feb 8', value: 5500000000 },
  { date: 'Feb 9', value: 6200000000 },
  { date: 'Feb 10', value: 6500000000 },
];

const MOCK_OBJECTS_7D = [
  { date: 'Feb 4', value: 280 },
  { date: 'Feb 5', value: 295 },
  { date: 'Feb 6', value: 300 },
  { date: 'Feb 7', value: 310 },
  { date: 'Feb 8', value: 318 },
  { date: 'Feb 9', value: 330 },
  { date: 'Feb 10', value: 342 },
];

// UNKNOWN: 30-day trend data is not specified — reusing 7-day data as a placeholder
const MOCK_STORAGE_30D = MOCK_STORAGE_7D;
const MOCK_OBJECTS_30D = MOCK_OBJECTS_7D;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type UsageTrendsProps = {
  storageUsed: number;
  objectsCount: number;
};

export function UsageTrends({ storageUsed, objectsCount }: UsageTrendsProps) {
  const [trendPeriod, setTrendPeriod] = useState<'7d' | '30d'>('7d');

  const storageChartData = trendPeriod === '7d' ? MOCK_STORAGE_7D : MOCK_STORAGE_30D;
  const objectsChartData = trendPeriod === '7d' ? MOCK_OBJECTS_7D : MOCK_OBJECTS_30D;

  return (
    <div className="mb-6">
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900">Usage Trends</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTrendPeriod('7d')}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${
              trendPeriod === '7d' ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            7 days
          </button>
          <button
            type="button"
            onClick={() => setTrendPeriod('30d')}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${
              trendPeriod === '30d' ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            30 days
          </button>
        </div>
      </div>

      {/* Chart cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Storage chart */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              STORAGE
            </span>
            <span className="text-sm font-semibold text-zinc-900">{formatBytes(storageUsed)}</span>
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={storageChartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="storageGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#EFF6FF" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#EFF6FF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 6 }}
                formatter={(value) => [
                  typeof value === 'number' ? formatBytes(value) : String(value ?? ''),
                  'Storage',
                ]}
              />
              <Area
                type="monotone"
                dataKey="value"
                fill="#EFF6FF"
                stroke="#2563EB"
                strokeWidth={2}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Objects chart */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              OBJECTS
            </span>
            <span className="text-sm font-semibold text-zinc-900">{objectsCount} total</span>
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={objectsChartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="objectsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#EFF6FF" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#EFF6FF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 6 }}
                formatter={(value) => [value ?? '', 'Objects']}
              />
              <Area
                type="monotone"
                dataKey="value"
                fill="#EFF6FF"
                stroke="#2563EB"
                strokeWidth={2}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

export default UsageTrends;
