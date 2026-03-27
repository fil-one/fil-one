import { forwardRef } from 'react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

export type TextAreaProps = ComponentProps<'textarea'>;

const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900',
        'placeholder:text-zinc-400',
        'transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
TextArea.displayName = 'TextArea';

export { TextArea };
