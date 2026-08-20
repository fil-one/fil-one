import { Input as HeadlessInput, type InputProps as HeadlessInputProps } from '@headlessui/react';
import { clsx } from 'clsx';
import { type AccessibleControlName, warnIfUnnamedControl } from './accessible-control.js';

type InputProps = {
  onChange: (value: string) => void;
  invalid?: boolean;
} & Omit<HeadlessInputProps, 'onChange' | 'id' | 'aria-label' | 'aria-labelledby'> &
  AccessibleControlName;

export function Input({ onChange, invalid, className, ...rest }: InputProps) {
  warnIfUnnamedControl('Input', rest.id ?? rest['aria-label']);
  return (
    <HeadlessInput
      {...rest}
      aria-invalid={invalid}
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
