import { Fragment } from 'react';

import {
  Dialog,
  DialogPanel,
  DialogBackdrop,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { XIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  panelClassName?: string;
};

export type ModalHeaderProps = {
  children: React.ReactNode;
  onClose?: () => void;
};

export type ModalBodyProps = {
  children: React.ReactNode;
};

export type ModalFooterProps = {
  children: React.ReactNode;
};

const sizeClasses = {
  sm: 'modal-panel--sm',
  md: 'modal-panel--md',
  lg: 'modal-panel--lg',
} as const;

export function Modal({ open, onClose, children, size = 'md', panelClassName }: ModalProps) {
  return (
    <Transition show={open} as={Fragment}>
      <Dialog className="relative z-50" onClose={onClose}>
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
          <DialogBackdrop className="modal-backdrop" />
        </TransitionChild>

        {/* Panel container */}
        <div className="modal-container">
          <TransitionChild
            as={Fragment}
            enter="transition ease-out duration-200"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="transition ease-in duration-150"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel className={clsx('modal-panel', sizeClasses[size], panelClassName)}>
              {children}
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}

export function ModalHeader({ children, onClose }: ModalHeaderProps) {
  return (
    <div className="modal-header">
      <span className="modal-header-title">{children}</span>
      {onClose && (
        <button type="button" className="modal-header-close" onClick={onClose} aria-label="Close">
          <XIcon width={20} height={20} />
        </button>
      )}
    </div>
  );
}

export function ModalBody({ children }: ModalBodyProps) {
  return <div className="modal-body">{children}</div>;
}

export function ModalFooter({ children }: ModalFooterProps) {
  return <div className="modal-footer">{children}</div>;
}
