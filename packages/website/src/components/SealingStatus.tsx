/**
 * Filecoin sealing status card for the dashboard.
 *
 * Hidden until we have an event system with Aurora to track object uploads
 * outside our platform.
 * https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard
 */
import { HardDrivesIcon } from '@phosphor-icons/react/dist/ssr';
import { Link } from '@tanstack/react-router';
import { DOCS_URL } from '@filone/shared';

export function SealingStatus() {
  return (
    <div className="mb-6 rounded-xl border border-[#e1e4ea] bg-white p-5 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-[#677183]">
            FILECOIN SEALING STATUS
          </h2>
          <span className="rounded-full bg-[rgba(0,128,255,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[#0080ff]">
            On-chain verification
          </span>
        </div>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-[#677183] hover:text-zinc-900"
        >
          Learn more ↗
        </a>
      </div>
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100">
          <HardDrivesIcon size={20} className="text-[#677183]" />
        </div>
        <p className="text-[13px] font-medium text-zinc-900">No objects sealing yet</p>
        <p className="max-w-xs text-[11px] text-[#677183]">
          Upload your first object to see real-time Filecoin sealing status and on-chain
          verification
        </p>
        <Link to="/buckets" className="mt-1 text-[12px] font-medium text-[#0080ff] hover:underline">
          Go to buckets <span aria-hidden="true">→</span>
        </Link>
      </div>
    </div>
  );
}
