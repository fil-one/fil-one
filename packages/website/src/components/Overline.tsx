import { clsx } from 'clsx';

type OverlineProps = {
  children: React.ReactNode;
  className?: string;
};

export function Overline({ children, className }: OverlineProps) {
  return (
    <p
      className={clsx(
        'text-[10px] font-semibold uppercase tracking-widest text-zinc-500',
        className,
      )}
    >
      {children}
    </p>
  );
}
