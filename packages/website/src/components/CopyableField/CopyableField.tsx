import { cn } from '../../lib/utils';
import { CopyButton } from '../CopyButton';

export type CopyableFieldProps = {
  label: string;
  value: string;
  className?: string;
};

export function CopyableField({ label, value, className }: CopyableFieldProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="w-24 shrink-0 text-sm text-zinc-500">{label}</span>
      <div className="flex flex-1 items-center overflow-hidden rounded-md bg-zinc-100 px-3.5 py-2.5">
        <span className="font-mono text-sm leading-none text-zinc-900">{value}</span>
      </div>
      <CopyButton value={value} ariaLabel={`Copy ${label}`} />
    </div>
  );
}
