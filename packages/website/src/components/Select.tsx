import {
  Select as HeadlessSelect,
  type SelectProps as HeadlessSelectProps,
} from '@headlessui/react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

type SelectProps = {
  onChange?: (value: string) => void;
  invalid?: boolean;
} & Omit<HeadlessSelectProps, 'onChange'>;

export function Select({ onChange, invalid, className, children, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <HeadlessSelect
        {...rest}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className={clsx(
          'w-full appearance-none rounded-md border bg-white px-3 py-2.5 pr-8 text-sm text-(--color-text-base)',
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
      <CaretDownIcon
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400"
        size={14}
        aria-hidden="true"
      />
    </div>
  );
}
