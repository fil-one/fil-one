import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '../../lib/utils';

export type IconButtonProps = {
  children: ReactNode;
} & ComponentPropsWithoutRef<'button'>;

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, children, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-all duration-150 ease-out hover:bg-zinc-100 hover:text-zinc-900',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
);
IconButton.displayName = 'IconButton';

export { IconButton };
