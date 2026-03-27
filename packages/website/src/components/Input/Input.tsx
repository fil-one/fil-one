import { forwardRef } from 'react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

export type InputProps = ComponentProps<'input'>;

const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9.5 w-full rounded-md border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-900',
        'placeholder:text-zinc-400',
        'transition-colors',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-zinc-900',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
