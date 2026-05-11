import {
  ClockCounterClockwiseIcon,
  LockIcon,
  LockSimpleIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { Bucket } from '@filone/shared';

function formatRetention(mode?: string, duration?: number, durationType?: string): string | null {
  if (!mode || !duration || !durationType) return null;
  const unit =
    durationType === 'y' ? (duration === 1 ? 'year' : 'years') : duration === 1 ? 'day' : 'days';
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  return `${modeLabel} \u00b7 ${duration} ${unit}`;
}

export function BucketPropertiesCard({ bucket }: { bucket: Bucket }) {
  const columnsClass = bucket.defaultRetention ? 'sm:grid-cols-4' : 'sm:grid-cols-3';
  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <div className={`grid grid-cols-2 gap-x-8 gap-y-4 ${columnsClass}`}>
        <div className="flex items-start gap-2.5">
          <ClockCounterClockwiseIcon
            size={16}
            className="mt-0.5 shrink-0 text-zinc-400"
            aria-hidden="true"
          />
          <div>
            <p className="text-xs font-medium text-zinc-500">Versioning</p>
            <p
              className={`text-sm font-medium ${bucket.versioning ? 'text-green-700' : 'text-zinc-900'}`}
            >
              {bucket.versioning ? 'Enabled' : 'Disabled'}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <LockIcon size={16} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true" />
          <div>
            <p className="text-xs font-medium text-zinc-500">Object Lock</p>
            <p
              className={`text-sm font-medium ${bucket.objectLockEnabled ? 'text-green-700' : 'text-zinc-900'}`}
            >
              {bucket.objectLockEnabled ? 'Enabled' : 'Disabled'}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <ShieldCheckIcon size={16} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true" />
          <div>
            <p className="text-xs font-medium text-zinc-500">Encryption</p>
            <p className="text-sm font-medium text-green-700">Enabled</p>
          </div>
        </div>
        {bucket.defaultRetention && (
          <div className="flex items-start gap-2.5">
            <LockSimpleIcon
              size={16}
              className="mt-0.5 shrink-0 text-zinc-400"
              aria-hidden="true"
            />
            <div>
              <p className="text-xs font-medium text-zinc-500">Default Retention</p>
              <p className="text-sm font-medium text-zinc-900">
                {formatRetention(
                  bucket.defaultRetention,
                  bucket.retentionDuration,
                  bucket.retentionDurationType,
                ) ?? 'N/A'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
