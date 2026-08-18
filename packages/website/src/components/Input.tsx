import { Input as HeadlessInput, type InputProps as HeadlessInputProps } from '@headlessui/react';
import { clsx } from 'clsx';
import { type AccessibleControlName, warnIfUnnamedControl } from './accessible-control.js';
import type { Ref } from 'react';

type InputProps = {
  onChange: (value: string) => void;
  invalid?: boolean;
  /** For a form that has to put focus back on the field it refused. */
  ref?: Ref<HTMLElement>;
} & Omit<HeadlessInputProps, 'onChange' | 'id' | 'aria-label' | 'aria-labelledby'> &
  AccessibleControlName;

export function Input({ onChange, invalid, className, ref, ...rest }: InputProps) {
  warnIfUnnamedControl('Input', rest.id ?? rest['aria-label']);
  return (
    // `invalid` rather than a hand-set `aria-invalid`: Headless UI owns that
    // attribute and writes its own value over anything passed in, so setting it
    // here left every invalid input announcing itself as valid. The same merge
    // owns `aria-describedby`, which is why the error message a field is
    // described by is registered through `FormField` rather than passed down.
    <HeadlessInput
      {...rest}
      ref={ref}
      invalid={invalid}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'flex w-full rounded-md border bg-white px-3 py-2.5 text-sm text-(--color-text-base)',
        'placeholder:text-(--input-placeholder-color)',
        'transition-colors',
        invalid
          ? 'border-red-400 focus-visible:outline-2 focus-visible:outline-red-500 focus-visible:outline-offset-0'
          : 'border-(--input-border-color) focus-visible:brand-outline',
        'disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400',
        className,
      )}
    />
  );
}
