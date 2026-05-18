/**
 * Filecoin sealing status card for the dashboard.
 *
 * Hidden until we have an event system with Aurora to track object uploads
 * outside our platform.
 * https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard
 */
import { HardDrivesIcon } from '@phosphor-icons/react/dist/ssr';
import { DOCS_URL } from '@filone/shared';

import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { IconBox } from './IconBox.js';

export function SealingStatus() {
  return (
    <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Filecoin Sealing Status
          </h2>
          <Badge color="blue" size="sm" weight="medium">
            On-chain verification
          </Badge>
        </div>
        <Button variant="tertiary" size="sm" href={DOCS_URL}>
          Learn more
        </Button>
      </div>
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <IconBox icon={HardDrivesIcon} color="grey" size="md" />
        <p className="text-sm font-medium text-zinc-900">No objects sealing yet</p>
        <p className="max-w-xs text-xs text-zinc-500">
          Upload your first object to see real-time Filecoin sealing status and on-chain
          verification
        </p>
        <Button variant="tertiary" size="sm" href="/buckets">
          Go to buckets →
        </Button>
      </div>
    </div>
  );
}
