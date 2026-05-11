import { clsx } from 'clsx';

type CardProps = {
  children: React.ReactNode;
  className?: string;
};

export function Card({ children, className }: CardProps) {
  return (
    <div className={clsx('rounded-lg border border-zinc-200 bg-white p-5 shadow-xs', className)}>
      {children}
    </div>
  );
}
