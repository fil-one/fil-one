import { CopyButton } from './CopyButton';

type CopyableFieldProps = {
  label: string;
  value: string;
};

export function CopyableField({ label, value }: CopyableFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[13px] text-zinc-500">{label}</span>
      <div className="flex-1 overflow-hidden rounded-md bg-zinc-100 px-2.5 py-1.5">
        <span className="font-mono text-xs text-zinc-900">{value}</span>
      </div>
      <CopyButton value={value} size="md" />
    </div>
  );
}
