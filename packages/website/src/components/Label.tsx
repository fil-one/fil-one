import { clsx } from 'clsx';

type LabelProps = {
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
};

export function Label({ children, htmlFor, className }: LabelProps) {
  return (
    <label htmlFor={htmlFor} className={clsx('text-xs font-medium text-zinc-900', className)}>
      {children}
    </label>
  );
}
