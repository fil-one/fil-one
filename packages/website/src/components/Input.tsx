import { useEffect, useRef } from 'react';
import { Input as HeadlessInput, type InputProps as HeadlessInputProps } from '@headlessui/react';
import { clsx } from 'clsx';

type InputProps = {
  onChange: (value: string) => void;
  invalid?: boolean;
  /** Same pattern as Switch.tsx: declared explicitly for the a11y wiring. */
  'aria-describedby'?: string;
} & Omit<HeadlessInputProps, 'onChange'>;

export function Input({
  onChange,
  invalid,
  className,
  'aria-describedby': ariaDescribedBy,
  ...rest
}: InputProps) {
  const ref = useRef<HTMLInputElement>(null);
  // Headless UI's Input always derives aria-describedby from its own
  // Description context and overwrites any passthrough value (even with
  // undefined), so a caller-supplied one must be applied to the element
  // directly.
  useEffect(() => {
    if (!ref.current) return;
    if (ariaDescribedBy) {
      ref.current.setAttribute('aria-describedby', ariaDescribedBy);
    } else {
      ref.current.removeAttribute('aria-describedby');
    }
  }, [ariaDescribedBy]);
  return (
    <HeadlessInput
      {...rest}
      ref={ref}
      // Passed as Headless UI's own `invalid` prop (not a raw aria-invalid
      // attribute, which its computed props would overwrite) so the rendered
      // input genuinely carries aria-invalid="true".
      invalid={invalid ?? false}
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
