import { clsx } from 'clsx';

export type TextAreaProps = {
  onChange: (value: string) => void;
  rows?: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<'textarea'>, 'onChange'>;

export function TextArea({ onChange, rows = 4, className, ...rest }: TextAreaProps) {
  return (
    <textarea
      {...rest}
      rows={rows}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'focus:brand-outline block w-full resize-y rounded-lg border border-(--input-border-color) p-3 text-(--color-text-base) placeholder:text-(--input-placeholder-color)',
        className,
      )}
    />
  );
}
