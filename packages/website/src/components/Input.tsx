import { Input as HeadlessInput, type InputProps as HeadlessInputProps } from '@headlessui/react';
import { clsx } from 'clsx';

/**
 * `md` is the form field. `sm` is toolbar chrome: shorter and quieter, for
 * filters that sit alongside content rather than inside a form.
 */
export type InputSize = 'sm' | 'md';

const SIZES: Record<InputSize, string> = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'px-3 py-2.5 text-sm',
};

type InputProps = {
  onChange: (value: string) => void;
  invalid?: boolean;
  inputSize?: InputSize;
} & Omit<HeadlessInputProps, 'onChange'>;

export function Input({ onChange, invalid, inputSize = 'md', className, ...rest }: InputProps) {
  return (
    <HeadlessInput
      {...rest}
      aria-invalid={invalid}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'flex w-full rounded-md border bg-white text-(--color-text-base)',
        SIZES[inputSize],
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
