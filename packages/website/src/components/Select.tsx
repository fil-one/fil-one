import {
  Select as HeadlessSelect,
  type SelectProps as HeadlessSelectProps,
} from '@headlessui/react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';
import { type AccessibleControlName, warnIfUnnamedControl } from './accessible-control.js';

import type { InputSize } from './Input';

/** Matches Input's sizes so a filter row lines up with its search field. */
const SIZES: Record<InputSize, { control: string; caret: { inset: string; size: number } }> = {
  sm: { control: 'h-8 pr-7 pl-2.5 text-[13px]', caret: { inset: 'right-2', size: 12 } },
  md: { control: 'py-2.5 pr-9 pl-3 text-sm', caret: { inset: 'right-3', size: 14 } },
};

type SelectProps = {
  onChange: (value: string) => void;
  invalid?: boolean;
  selectSize?: InputSize;
} & Omit<HeadlessSelectProps, 'onChange' | 'id' | 'aria-label' | 'aria-labelledby'> &
  AccessibleControlName;

export function Select({
  onChange,
  invalid,
  selectSize = 'md',
  className,
  children,
  ...rest
}: SelectProps) {
  warnIfUnnamedControl('Select', rest.id ?? rest['aria-label']);
  const { control, caret } = SIZES[selectSize];

  return (
    <div className="relative">
      <HeadlessSelect
        {...rest}
        invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(
          'flex w-full appearance-none rounded-md border bg-white text-(--color-text-base)',
          control,
          'transition-colors',
          invalid
            ? 'border-red-400 focus-visible:outline-2 focus-visible:outline-red-500 focus-visible:outline-offset-0'
            : 'border-(--input-border-color) focus-visible:brand-outline',
          'disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400',
          className,
        )}
      >
        {children}
      </HeadlessSelect>
      <span
        className={clsx(
          'pointer-events-none absolute inset-y-0 flex items-center text-zinc-400',
          caret.inset,
        )}
      >
        <CaretDownIcon size={caret.size} weight="bold" />
      </span>
    </div>
  );
}
