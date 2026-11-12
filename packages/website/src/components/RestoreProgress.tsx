import { Spinner } from './Spinner';
import { ProgressBar } from './ProgressBar';
import type { JobProgress, RestoreJob } from '../lib/cold-storage-files.js';

/** "The whole bucket" becomes "the whole bucket", to follow "Restoring". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Cold storage prototype (FIL-1608): a restore of several files, counted as
 * its files become readable. Each runs as one job, so a folder or a bucket
 * gets one line rather than a pill per file to scan. Gone once every file is
 * ready; the Storage column carries each file from there.
 */
export function RestoreProgress({ jobs }: { jobs: { job: RestoreJob; progress: JobProgress }[] }) {
  if (jobs.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="restore-progress">
      {jobs.map(({ job, progress }) => (
        <div
          key={job.id}
          className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3"
        >
          <div className="flex flex-col gap-0.5 text-ui sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="flex min-w-0 items-center gap-2 text-zinc-900">
              {/* A spinner is the one loop the motion rules allow: this is real progress. */}
              <Spinner ariaLabel="Restoring" size={12} />
              <span className="truncate">Restoring {lowerFirst(job.label)}</span>
            </span>
            <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
              {progress.ready.toLocaleString()} of {progress.total.toLocaleString()} files ready
            </span>
          </div>
          <ProgressBar
            value={(progress.ready / progress.total) * 100}
            size="sm"
            label={`Restore progress for ${lowerFirst(job.label)}`}
          />
        </div>
      ))}
    </div>
  );
}
