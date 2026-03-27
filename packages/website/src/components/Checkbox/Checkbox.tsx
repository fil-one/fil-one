import { forwardRef } from 'react';
import type { ComponentProps } from 'react';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';

import { cn } from '../../lib/utils';

export type CheckboxProps = Omit<ComponentProps<'input'>, 'type'>;

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(({ className, ...props }, ref) => {
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center">
      <input
        type="checkbox"
        className={cn(
          'peer h-4 w-4 cursor-pointer appearance-none rounded-sm border border-zinc-300 bg-white',
          'checked:border-brand-700 checked:bg-brand-700',
          'hover:bg-zinc-100 checked:hover:bg-brand-600',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={ref}
        {...props}
      />
      <CheckIcon
        size={12}
        weight="bold"
        className="pointer-events-none absolute hidden text-white peer-checked:block"
      />
    </div>
  );
});
Checkbox.displayName = 'Checkbox';

export { Checkbox };
