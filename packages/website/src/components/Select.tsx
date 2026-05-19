import {
  Select as HeadlessSelect,
  type SelectProps as HeadlessSelectProps,
} from '@headlessui/react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

type SelectProps = {
  onChange: (value: string) => void;
  invalid?: boolean;
} & Omit<HeadlessSelectProps, 'onChange'>;

export function Select({ onChange, invalid, className, children, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <HeadlessSelect
        {...rest}
        invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(
          'flex w-full appearance-none rounded-md border bg-white px-3 py-2.5 text-sm text-(--color-text-base)',
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
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-400">
        <CaretDownIcon size={14} weight="bold" />
      </span>
    </div>
  );
}
