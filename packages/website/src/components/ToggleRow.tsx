import { useId } from 'react';

export function ToggleRow({
  label,
  description,
  enabled,
  disabled,
  onChange,
  saving,
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onChange?: () => void;
  saving?: boolean;
}) {
  const labelId = useId();
  const interactive = !disabled && !!onChange && !saving;
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p id={labelId} className="text-[13px] font-medium text-zinc-900">
          {label}
        </p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={labelId}
        disabled={!interactive}
        onClick={interactive ? onChange : undefined}
        className={`flex h-6 w-11 items-center rounded-full border-2 border-transparent p-0.5 transition-colors ${enabled ? 'bg-blue-500' : 'bg-zinc-300'} ${interactive ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
      >
        <div
          className={`size-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}
