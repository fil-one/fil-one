import { clsx } from 'clsx';

export type TextareaProps = {
  onChange: (value: string) => void;
  invalid?: boolean;
  rows?: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<'textarea'>, 'onChange'>;

/** @deprecated Use `Textarea` instead */
export const TextArea = (props: TextareaProps) => <Textarea {...props} />;

export function Textarea({ onChange, invalid, rows = 4, className, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      rows={rows}
      aria-invalid={invalid}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'flex w-full resize-none rounded-md border bg-white px-3 py-2.5 text-sm text-(--color-text-base)',
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
