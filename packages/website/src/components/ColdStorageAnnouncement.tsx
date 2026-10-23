import { useEffect, useState } from 'react';
import { DialogTitle } from '@headlessui/react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowCounterClockwiseIcon, ThermometerIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

import { Badge } from './Badge';
import { Button } from './Button';
import { ColdStorageStatus } from './ColdStorageStatus';
import { IconBox } from './IconBox';
import { IconButton } from './IconButton';
import { Modal } from './Modal';
import {
  COLD_PRICE_PER_TB_MONTH,
  MIN_TERM_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  formatUsd,
  markAnnouncementSeen,
  useAnnouncementSeen,
  trackColdStorage,
} from '../lib/cold-storage-prototype.js';

/**
 * Introduces cold storage once, on the first visit after launch, then never
 * again. Freezing itself lives on the Buckets page, so the tour only has to
 * sell the idea and point there. Mounted in the app layout, so it greets the
 * user on whichever page they land on.
 */
export function ColdStorageAnnouncement() {
  const seen = useAnnouncementSeen();
  const navigate = useNavigate();

  useEffect(() => {
    if (!seen) trackColdStorage('announcement viewed');
  }, [seen]);

  return (
    <ColdStorageAnnouncementDialog
      open={!seen}
      onClose={(step) => {
        trackColdStorage('announcement dismissed', { step: String(step + 1) });
        markAnnouncementSeen();
      }}
      onViewBuckets={() => {
        trackColdStorage('announcement buckets clicked');
        markAnnouncementSeen();
        void navigate({ to: '/buckets' });
      }}
    />
  );
}

type Step = { title: string; body: string; visual: React.ReactNode };

const STEPS: Step[] = [
  {
    title: 'Cold storage is here',
    body: `Keep the archives you rarely open for ${formatUsd(COLD_PRICE_PER_TB_MONTH)}/TB-month, a third of standard storage. No retrieval or egress fees.`,
    visual: <PriceVisual />,
  },
  {
    title: 'Freeze a bucket in a click',
    body: `Choose Freeze bucket from the menu of any bucket of 1 TB or more. Its objects stay listed, and it stays frozen for at least ${MIN_TERM_DAYS} days.`,
    visual: <BucketsVisual />,
  },
  {
    title: 'Restore it when you need it',
    body: 'Restore a bucket for 2 weeks and keep your frozen price, or restore it permanently. Either way, your data is ready in about an hour.',
    visual: <GetBackVisual />,
  },
];

export function ColdStorageAnnouncementDialog({
  open,
  onClose,
  onViewBuckets,
}: {
  open: boolean;
  /** Receives the step the tour was closed on, which the demand test tracks. */
  onClose: (step: number) => void;
  onViewBuckets: () => void;
}) {
  const [step, setStep] = useState(0);
  // Each opening starts the tour from the beginning.
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <Modal open={open} onClose={() => onClose(step)} size="md" testId="cold-storage-announcement">
      <div className="relative">
        <div className="flex h-44 items-center justify-center overflow-hidden rounded-t-xl border-b border-brand-100 bg-brand-50 px-8">
          {current.visual}
        </div>
        <IconButton
          icon={XIcon}
          size="sm"
          aria-label="Close"
          onClick={() => onClose(step)}
          className="absolute top-3 right-3"
        />
      </div>
      <div className="flex flex-col gap-2 px-6 pt-5 pb-2">
        <Badge color="blue" size="xs" className="self-start">
          New
        </Badge>
        <DialogTitle as="h2" className="text-base font-medium text-zinc-900">
          {current.title}
        </DialogTitle>
        <p className="min-h-15 text-sm text-zinc-600">{current.body}</p>
      </div>
      <div className="flex items-center justify-between gap-3 px-6 pt-2 pb-6">
        <StepDots count={STEPS.length} current={step} />
        <div className="flex gap-2">
          {step === 0 ? (
            <Button id="cold-storage-tour-later" variant="ghost" onClick={() => onClose(step)}>
              Not now
            </Button>
          ) : (
            <Button id="cold-storage-tour-back" variant="ghost" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          {isLast ? (
            <Button id="cold-storage-tour-buckets" variant="primary" onClick={onViewBuckets}>
              View buckets
            </Button>
          ) : (
            <Button id="cold-storage-tour-next" variant="primary" onClick={() => setStep(step + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function StepDots({ count, current }: { count: number; current: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${current + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={clsx(
            'h-1.5 rounded-full transition-all duration-200',
            i === current ? 'w-4 bg-brand-600' : 'w-1.5 bg-zinc-300',
          )}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Illustrations: small pieces of the product, drawn with the console's own
// components, so the tour shows what the user will actually see.
// ---------------------------------------------------------------------------

function PriceVisual() {
  const rows = [
    { label: 'Standard', price: WARM_PRICE_PER_TB_MONTH, bar: 'w-full bg-zinc-300' },
    { label: 'Cold', price: COLD_PRICE_PER_TB_MONTH, bar: 'w-1/3 bg-brand-600' },
  ];
  return (
    <div className="flex w-full max-w-72 flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-xs">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-zinc-600">{row.label}</span>
            <span className="font-medium text-zinc-900 tabular-nums">
              {formatUsd(row.price)}
              <span className="font-normal text-zinc-500">/TB-month</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-zinc-100">
            <div className={clsx('h-2 rounded-full', row.bar)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function BucketsVisual() {
  const rows = [
    { name: 'raw-footage-2021', size: '70 TB', frozen: true },
    { name: 'client-projects', size: '8 TB', frozen: false },
  ];
  return (
    <div className="w-full max-w-72 divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white shadow-xs">
      {rows.map((row) => (
        <div key={row.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-zinc-900">{row.name}</span>
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              {row.size}
              {row.frozen && (
                <>
                  <span aria-hidden="true">·</span>
                  <ColdStorageStatus
                    state={{ status: 'frozen', frozenAt: 0, termEndsAt: 0, bytes: 70e12 }}
                  />
                </>
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function GetBackVisual() {
  const options = [
    { icon: ThermometerIcon, title: 'Restore for 2 weeks', note: 'Frozen price stays' },
    { icon: ArrowCounterClockwiseIcon, title: 'Restore permanently', note: 'Back to standard' },
  ];
  return (
    <div className="grid w-full max-w-80 grid-cols-2 gap-3">
      {options.map((option) => (
        <div
          key={option.title}
          className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3 shadow-xs"
        >
          <IconBox icon={option.icon} color="blue" size="sm" className="self-start" />
          <div className="flex flex-col">
            <span className="text-xs font-medium text-zinc-900">{option.title}</span>
            <span className="text-meta text-zinc-500">{option.note}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
