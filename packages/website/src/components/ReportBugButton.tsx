import { useState } from 'react';
import { BugBeetleIcon } from '@phosphor-icons/react/dist/ssr';

import { ReportBugDialog } from './ReportBugDialog.js';
import { Tooltip } from './Tooltip.js';

/**
 * The bug-report control for the content window's bottom bar: a quiet icon
 * button that opens the feedback dialog, with a tooltip since it carries no
 * label of its own.
 */
export function ReportBugButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip content="Report a bug" side="top">
        <button
          type="button"
          data-testid="report-bug-button"
          aria-label="Report a bug"
          onClick={() => setOpen(true)}
          className="flex size-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 focus-visible:bg-zinc-100 focus-visible:text-zinc-600 focus-visible:outline-none"
        >
          <BugBeetleIcon size={16} />
        </button>
      </Tooltip>
      <ReportBugDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
