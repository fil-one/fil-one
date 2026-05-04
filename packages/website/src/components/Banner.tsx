import { useState } from 'react';
import { ArrowRightIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

import { Button } from './Button';

export type BannerVariant = 'error' | 'warning' | 'info';

export type BannerProps = {
  variant?: BannerVariant;
  children: React.ReactNode;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  onClose?: () => void;
};

const containerStyles: Record<BannerVariant, string> = {
  error: 'border-red-200 bg-red-50',
  warning: 'border-amber-200 bg-amber-50',
  info: 'border-zinc-200 bg-zinc-100',
};

const textStyles: Record<BannerVariant, string> = {
  error: 'text-red-800',
  warning: 'text-amber-800',
  info: 'text-zinc-600',
};

export function Banner({ variant = 'info', children, action, onClose }: BannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (variant !== 'error' && dismissed) return null;

  function handleClose() {
    setDismissed(true);
    onClose?.();
  }

  return (
    <div
      className={clsx(
        'relative flex w-full shrink-0 items-center justify-center gap-3 border-b px-6 py-2',
        containerStyles[variant],
      )}
      role="alert"
    >
      <p className={clsx('text-xs font-medium', textStyles[variant])}>{children}</p>
      {action && (
        <Button
          variant={variant === 'error' ? 'destructive' : 'tertiary'}
          size="sm"
          href={action.href}
          onClick={action.onClick}
          icon={variant !== 'error' ? ArrowRightIcon : undefined}
          iconPosition="right"
          className={
            variant === 'warning'
              ? 'text-amber-700 hover:text-amber-900 hover:bg-amber-100 [&_.button-custom-icon]:text-amber-700'
              : undefined
          }
        >
          {action.label}
        </Button>
      )}
      {variant !== 'error' && (
        <button
          type="button"
          onClick={handleClose}
          aria-label="Dismiss"
          className={clsx(
            'absolute right-4 transition-colors',
            variant === 'warning'
              ? 'text-amber-400 hover:text-amber-700'
              : 'text-zinc-400 hover:text-zinc-600',
          )}
        >
          <XIcon width={14} height={14} />
        </button>
      )}
    </div>
  );
}
