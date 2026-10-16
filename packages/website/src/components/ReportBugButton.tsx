import { useState } from 'react';
import { BugBeetleIcon } from '@phosphor-icons/react/dist/ssr';

import { IconButton } from './IconButton.js';
import { ReportBugDialog } from './ReportBugDialog.js';

type ReportBugButtonProps = {
  /**
   * `icon` is the desktop utility bar's quiet icon button, with a tooltip since
   * it carries no label of its own. `row` is the labelled line in the mobile
   * drawer, which has no utility bar.
   */
  variant: 'icon' | 'row';
};

/** The control that opens the bug-report dialog. */
export function ReportBugButton({ variant }: ReportBugButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {variant === 'icon' ? (
        <IconButton
          icon={BugBeetleIcon}
          aria-label="Report a bug"
          tooltip="Report a bug"
          tooltipSide="top"
          data-testid="report-bug-button"
          onClick={() => setOpen(true)}
          className="flex size-7 items-center justify-center rounded-md p-0 text-zinc-400 hover:text-zinc-600 focus-visible:brand-outline"
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:brand-outline"
        >
          <BugBeetleIcon size={16} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
          Report a bug
        </button>
      )}
      <ReportBugDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
