import { clsx } from 'clsx';

export type DividerWithLabelProps = {
  label: string;
  className?: string;
};

export function DividerWithLabel({ label, className }: DividerWithLabelProps) {
  return (
    <div className={clsx('flex items-center gap-3', className)}>
      <hr className="flex-1 border-t border-zinc-200" />
      <span className="text-sm text-zinc-500">{label}</span>
      <hr className="flex-1 border-t border-zinc-200" />
    </div>
  );
}
