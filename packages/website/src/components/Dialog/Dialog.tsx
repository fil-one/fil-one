import { Fragment } from 'react';
import type { ReactNode } from 'react';

import {
  Dialog as HeadlessDialog,
  DialogPanel,
  DialogTitle as HeadlessDialogTitle,
  DialogBackdrop,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { XIcon } from '@phosphor-icons/react/dist/ssr';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';
import { IconButton } from '../IconButton';

// ---------------------------------------------------------------------------
// Dialog (root)
// ---------------------------------------------------------------------------

const dialogPanelVariants = cva('relative w-full rounded-xl bg-white shadow-xl', {
  variants: {
    size: {
      sm: 'max-w-[400px]',
      md: 'max-w-[560px]',
      lg: 'max-w-[720px]',
    },
  },
  defaultVariants: { size: 'md' },
});

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: VariantProps<typeof dialogPanelVariants>['size'];
};

function Dialog({ open, onClose, children, size }: DialogProps) {
  return (
    <Transition show={open} as={Fragment}>
      <HeadlessDialog className="relative z-50" onClose={onClose}>
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="transition ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <DialogBackdrop className="fixed inset-0 bg-zinc-950/40 backdrop-blur-sm" />
        </TransitionChild>

        {/* Panel container */}
        <div className="fixed inset-0 z-10 flex items-center justify-center p-4">
          <TransitionChild
            as={Fragment}
            enter="transition ease-out duration-200"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="transition ease-in duration-150"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel className={dialogPanelVariants({ size })}>{children}</DialogPanel>
          </TransitionChild>
        </div>
      </HeadlessDialog>
    </Transition>
  );
}

// ---------------------------------------------------------------------------
// DialogHeader
// ---------------------------------------------------------------------------

export type DialogHeaderProps = {
  children: ReactNode;
  onClose?: () => void;
  className?: string;
};

function DialogHeader({ children, onClose, className }: DialogHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between border-b border-zinc-200 px-6 py-4',
        className,
      )}
    >
      <HeadlessDialogTitle className="text-base font-semibold text-zinc-950">
        {children}
      </HeadlessDialogTitle>
      {onClose && (
        <IconButton onClick={onClose} aria-label="Close">
          <XIcon size={20} />
        </IconButton>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DialogBody
// ---------------------------------------------------------------------------

export type DialogBodyProps = {
  children: ReactNode;
  className?: string;
};

function DialogBody({ children, className }: DialogBodyProps) {
  return <div className={cn('px-6 py-4 text-zinc-600', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// DialogFooter
// ---------------------------------------------------------------------------

export type DialogFooterProps = {
  children: ReactNode;
  className?: string;
};

function DialogFooter({ children, className }: DialogFooterProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-3 border-t border-zinc-200 px-6 py-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export { Dialog, dialogPanelVariants, DialogHeader, DialogBody, DialogFooter };
