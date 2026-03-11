import { lazy, Suspense, useState } from 'react';
import {
  PlusIcon,
  DatabaseIcon,
  KeyIcon,
  ArrowUpIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link } from '@tanstack/react-router';

const UsageTrends = lazy(() => import('./UsageTrends'));

import { Button } from '@hyperspace/ui/Button';
import { StatCard } from '@hyperspace/ui/StatCard';

import type { RecentActivity, ActivityAction } from '@filone/shared';

// ---------------------------------------------------------------------------
// Dev toggle — set IS_POPULATED = false to see the first-time empty state
// ---------------------------------------------------------------------------
const IS_POPULATED = true;

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_ACTIVITIES: RecentActivity[] = [
  {
    id: '1',
    action: 'bucket.created',
    resourceType: 'bucket',
    resourceName: 'my-media-files',
    timestamp: '2024-02-10T14:30:00Z',
  },
  {
    id: '2',
    action: 'object.uploaded',
    resourceType: 'object',
    resourceName: 'video.mp4',
    timestamp: '2024-02-10T15:00:00Z',
  },
  {
    id: '3',
    action: 'key.created',
    resourceType: 'key',
    resourceName: 'Production',
    timestamp: '2024-02-09T09:00:00Z',
  },
];

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Activity helpers
// ---------------------------------------------------------------------------

type ActivityIconConfig = {
  icon: React.ElementType;
  colorClass: string;
  label: string;
};

const ACTIVITY_CONFIG: Record<ActivityAction, ActivityIconConfig> = {
  'bucket.created': {
    icon: DatabaseIcon,
    colorClass: 'text-green-600',
    label: 'Bucket created',
  },
  'bucket.deleted': {
    icon: DatabaseIcon,
    colorClass: 'text-red-500',
    label: 'Bucket deleted',
  },
  'object.uploaded': {
    icon: ArrowUpIcon,
    colorClass: 'text-blue-600',
    label: 'Object uploaded',
  },
  'object.deleted': {
    icon: TrashIcon,
    colorClass: 'text-red-500',
    label: 'Object deleted',
  },
  'key.created': {
    icon: KeyIcon,
    colorClass: 'text-green-600',
    label: 'Key created',
  },
  'key.deleted': {
    icon: KeyIcon,
    colorClass: 'text-red-500',
    label: 'Key deleted',
  },
};

// ---------------------------------------------------------------------------
// Populated stats (mocked)
// ---------------------------------------------------------------------------

const POPULATED_STATS = {
  storageUsed: 6500000000, // 6.5 GB
  storageLimit: 1099511627776, // 1 TiB
  downloadsUsed: 0,
  downloadsLimit: 10995116277760, // 10 TiB
  bucketsCount: 3,
  bucketsLimit: 100,
  objectsCount: 342,
  accessKeysCount: 2,
  accessKeysLimit: 300,
};

const EMPTY_STATS = {
  storageUsed: 0,
  storageLimit: 1099511627776,
  downloadsUsed: 0,
  downloadsLimit: 10995116277760,
  bucketsCount: 0,
  bucketsLimit: 100,
  objectsCount: 0,
  accessKeysCount: 0,
  accessKeysLimit: 300,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DashboardPage() {
  const [trialBannerVisible, setTrialBannerVisible] = useState(true);
  // UNKNOWN: completedSteps would come from user progress tracking — using empty array as default
  const [completedSteps] = useState<string[]>([]);

  const stats = IS_POPULATED ? POPULATED_STATS : EMPTY_STATS;
  const activities = IS_POPULATED ? MOCK_ACTIVITIES : [];

  const storageUsagePct =
    stats.storageLimit > 0 ? Math.round((stats.storageUsed / stats.storageLimit) * 100) : 0;

  const downloadsUsagePct =
    stats.downloadsLimit > 0 ? Math.round((stats.downloadsUsed / stats.downloadsLimit) * 100) : 0;

  // Quick setup tasks: first-time = tasks 1 + 3, populated = tasks 1 + 2 + 3
  const quickSetupTasks = IS_POPULATED
    ? [
        {
          id: 'create-bucket',
          icon: DatabaseIcon,
          title: 'Create a bucket',
          subtitle: 'Organize your storage',
          href: '/buckets',
        },
        {
          id: 'upload-object',
          icon: ArrowUpIcon,
          title: 'Upload an object',
          subtitle: 'Store files on Filecoin',
          href: '/buckets',
        },
        {
          id: 'generate-key',
          icon: KeyIcon,
          title: 'Generate API key',
          subtitle: 'Connect via S3 API',
          href: '/api-keys',
        },
      ]
    : [
        {
          id: 'create-bucket',
          icon: DatabaseIcon,
          title: 'Create a bucket',
          subtitle: 'Organize your storage',
          href: '/buckets',
        },
        {
          id: 'generate-key',
          icon: KeyIcon,
          title: 'Generate API key',
          subtitle: 'Connect via S3 API',
          href: '/api-keys',
        },
      ];

  const quickSetupDone = completedSteps.length;
  const quickSetupTotal = quickSetupTasks.length;
  const showQuickSetup = quickSetupDone < quickSetupTotal;

  return (
    <div className="p-6">
      {/* ------------------------------------------------------------------ */}
      {/* 1. Page header */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">Dashboard</h1>
        {IS_POPULATED && (
          <Button variant="filled" icon={PlusIcon} href="/buckets">
            New bucket
          </Button>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 2. Trial banner */}
      {/* ------------------------------------------------------------------ */}
      {trialBannerVisible && (
        <div className="mb-6 flex items-center gap-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
            14 DAYS LEFT
          </span>
          <p className="flex-1 text-sm text-zinc-700">
            Free trial — Add a payment method to unlock unlimited storage at $4.99/TiB
          </p>
          <Button variant="filled" href="/billing">
            Upgrade →
          </Button>
          <button
            type="button"
            aria-label="Dismiss trial banner"
            onClick={() => setTrialBannerVisible(false)}
            className="text-zinc-400 hover:text-zinc-600"
          >
            <XIcon size={18} />
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 3. Quick Setup card */}
      {/* ------------------------------------------------------------------ */}
      {showQuickSetup && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Quick Setup
            </span>
            <span className="text-xs text-zinc-400">
              {quickSetupDone} of {quickSetupTotal}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quickSetupTasks.map(({ id, icon: Icon, title, subtitle, href }) => (
              <Link
                key={id}
                to={href}
                className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-zinc-200 p-4 text-center hover:bg-zinc-50"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                  <Icon size={20} />
                </span>
                <span className="text-sm font-medium text-zinc-800">{title}</span>
                <span className="text-xs text-zinc-500">{subtitle}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 4. Stats row */}
      {/* ------------------------------------------------------------------ */}

      {/* Wide stats: Storage + Downloads */}
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="STORAGE"
          value={formatBytes(stats.storageUsed)}
          limit={`/ ${formatBytes(stats.storageLimit)}`}
          usage={`${storageUsagePct}% used`}
        />
        <StatCard
          label="DOWNLOADS"
          value={formatBytes(stats.downloadsUsed)}
          limit={`/ ${formatBytes(stats.downloadsLimit)}`}
          usage={`${downloadsUsagePct}% used`}
        />
      </div>

      {/* Narrow stats: Buckets + Objects + Access Keys */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="BUCKETS"
          value={String(stats.bucketsCount)}
          limit={`/ ${stats.bucketsLimit}`}
        />
        <StatCard label="OBJECTS" value={String(stats.objectsCount)} limit="total" />
        <StatCard
          label="ACCESS KEYS"
          value={String(stats.accessKeysCount)}
          limit={`/ ${stats.accessKeysLimit}`}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 5. Usage Trends (lazy-loaded to avoid forced layout before styles) */}
      {/* ------------------------------------------------------------------ */}
      <Suspense fallback={<div className="mb-6" style={{ height: 200 }} />}>
        <UsageTrends storageUsed={stats.storageUsed} objectsCount={stats.objectsCount} />
      </Suspense>

      {/* ------------------------------------------------------------------ */}
      {/* 6. Recent Activity */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Recent Activity
        </h2>

        {activities.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center gap-3 rounded-lg border border-zinc-200 bg-white py-12 text-center">
            <p className="text-sm font-medium text-zinc-700">No activity yet</p>
            <p className="text-sm text-zinc-500">Create a bucket to start storing objects</p>
            <Button variant="filled" icon={PlusIcon} href="/buckets">
              Create bucket
            </Button>
          </div>
        ) : (
          /* Activity table */
          <div className="rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Action
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Resource
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {activities.map((activity) => {
                  const config = ACTIVITY_CONFIG[activity.action];
                  const Icon = config.icon;
                  return (
                    <tr key={activity.id} className="border-b border-zinc-100 last:border-0">
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <Icon size={16} className={config.colorClass} aria-hidden="true" />
                          <span className="text-zinc-700">{config.label}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{activity.resourceName}</td>
                      <td className="px-4 py-3 text-right text-zinc-400">
                        {timeAgo(activity.timestamp)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
