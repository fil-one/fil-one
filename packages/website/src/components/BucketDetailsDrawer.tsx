import { Fragment, useState } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { ThermometerIcon, XIcon } from '@phosphor-icons/react/dist/ssr';

import {
  formatBytes,
  getRegionLabel,
  getS3Endpoint,
  type BucketDetails,
  type S3Region,
} from '@filone/shared';

import { Button } from './Button';
import { describeCoverage } from './ColdStorageStatus';
import { CopyButton } from './CopyButton';
import { RegionFlag } from './RegionFlag';
import { FILONE_STAGE } from '../env';
import { formatRetention } from '../lib/retention.js';
import { useBucketColdSummary, useColdFiles } from '../lib/cold-storage-prototype.js';
import { getStorageBreakdown, type Tally } from '../lib/cold-storage-files.js';
import { useCachedListing } from '../lib/use-cached-listing.js';

export type BucketDetailsDrawerProps = {
  bucket: BucketDetails;
  region: S3Region;
  bytesUsed: number | undefined;
  objectCount: number | undefined;
  onClose: () => void;
  /** Cold storage prototype: opens the restore over the whole bucket; absent while nothing is frozen. */
  onRestoreFiles?: () => void;
};

/**
 * Everything about one bucket, including the settings that are off. The page
 * shows only the settings that are on, as cards, since an off setting changes
 * nothing about how the bucket behaves; this panel is where "is versioning on?"
 * gets its answer either way.
 *
 * Built like `AccessKeyDetailsDrawer`, on Headless UI's `Dialog`: focus moves
 * in when it opens, Tab stays inside, Escape and the backdrop close it, and
 * focus goes back to the button that opened it.
 */
export function BucketDetailsDrawer({
  bucket,
  region,
  bytesUsed,
  objectCount,
  onClose,
  onRestoreFiles,
}: BucketDetailsDrawerProps) {
  // Mounted open; closing plays the slide-out, then tells the page to unmount.
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  const endpoint = getS3Endpoint(region, FILONE_STAGE);

  return (
    <Transition show={open} appear as={Fragment} afterLeave={onClose}>
      <Dialog data-testid="bucket-details-drawer" className="relative z-40" onClose={close}>
        <TransitionChild
          as={Fragment}
          enter="transition-opacity duration-200 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity duration-200 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <DialogBackdrop className="fixed inset-0 bg-black/40" />
        </TransitionChild>
        <div className="fixed inset-y-0 right-0 flex w-full sm:w-100">
          <TransitionChild
            as={Fragment}
            enter="transition-transform duration-200 ease-out"
            enterFrom="translate-x-full"
            leave="transition-transform duration-200 ease-in"
            leaveTo="translate-x-full"
          >
            <DialogPanel className="flex w-full flex-col bg-white shadow-xl">
              <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
                <div className="min-w-0">
                  <DialogTitle className="text-base font-medium break-words text-zinc-900">
                    {bucket.bucketName}
                  </DialogTitle>
                  <p className="mt-0.5 text-xs text-zinc-500">Bucket details</p>
                </div>
                <button
                  type="button"
                  data-testid="bucket-details-drawer-close"
                  onClick={close}
                  aria-label="Close"
                  className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:brand-outline"
                >
                  <XIcon size={16} weight="bold" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <div className="flex flex-col divide-y divide-zinc-100 text-ui *:px-5 *:py-5">
                  <Section title="Overview">
                    <Fact label="Region">
                      <span className="flex items-center gap-2">
                        <RegionFlag region={region} />
                        <span>
                          {getRegionLabel(region)} <span className="text-zinc-500">{region}</span>
                        </span>
                      </span>
                    </Fact>
                    <Fact label="Storage used">
                      {bytesUsed === undefined ? '\u2014' : formatBytes(bytesUsed)}
                    </Fact>
                    <Fact label="Objects">
                      {objectCount === undefined ? '\u2014' : objectCount.toLocaleString()}
                    </Fact>
                    <Fact label="Visibility">{bucket.isPublic ? 'Public' : 'Private'}</Fact>
                    <Fact label="S3 endpoint">
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate font-mono text-xs" title={endpoint}>
                          {endpoint}
                        </span>
                        <CopyButton value={endpoint} />
                      </span>
                    </Fact>
                  </Section>
                  <Section title="Data protection">
                    <Fact label="Versioning">{bucket.versioning ? 'Enabled' : 'Disabled'}</Fact>
                    <Fact label="Object Lock">
                      {bucket.objectLockEnabled ? 'Enabled' : 'Disabled'}
                    </Fact>
                    <Fact label="Retention">
                      {formatRetention(
                        bucket.defaultRetention,
                        bucket.retentionDuration,
                        bucket.retentionDurationType,
                      ) ?? 'None'}
                    </Fact>
                  </Section>
                  <ColdStorageSection
                    bucketName={bucket.bucketName}
                    region={region}
                    onRestoreFiles={onRestoreFiles}
                  />
                </div>
              </div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}

/**
 * Cold storage prototype (FIL-1608): which of the bucket's files freeze, and
 * where its bytes bill, by state. States with nothing in them are left out.
 * Sizes only, never costs: the console quotes rates, not totals.
 */
function ColdStorageSection({
  bucketName,
  region,
  onRestoreFiles,
}: {
  bucketName: string;
  region: S3Region;
  onRestoreFiles?: () => void;
}) {
  const summary = useBucketColdSummary(bucketName, region);
  const cold = useColdFiles(bucketName, region);
  const { versions, versioned } = useCachedListing(bucketName, region);
  const rule =
    summary === null ? 'Off' : summary.scope === 'bucket' ? 'All files' : describeCoverage(summary);
  const breakdown =
    cold.record && versions
      ? getStorageBreakdown(cold.record, versions, cold.now, cold.clock)
      : undefined;
  const rows: { label: string; tally: Tally }[] = breakdown
    ? [
        { label: 'Frozen', tally: breakdown.frozen },
        { label: 'Restored', tally: breakdown.restored },
        { label: 'Freezing soon', tally: breakdown.scheduled },
        { label: 'Standard', tally: breakdown.standard },
        ...(versioned ? [{ label: 'Older versions', tally: breakdown.olderVersions }] : []),
      ].filter((row) => row.tally.files > 0)
    : [];
  return (
    <Section title="Cold storage">
      <Fact label="Freezing">{rule}</Fact>
      {rows.map(({ label, tally }) => (
        <Fact key={label} label={label}>
          {formatBytes(tally.bytes)}{' '}
          <span className="text-zinc-500">
            · {tally.files.toLocaleString()} {tally.files === 1 ? 'file' : 'files'}
          </span>
        </Fact>
      ))}
      {onRestoreFiles && (
        // Under the facts, in the value column, so it reads as acting on them.
        <div className="col-start-2">
          <Button variant="ghost" size="sm" icon={ThermometerIcon} onClick={onRestoreFiles}>
            Restore files
          </Button>
        </div>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-zinc-500">{title}</h3>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3">
        {children}
      </dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-zinc-900">{children}</dd>
    </>
  );
}
