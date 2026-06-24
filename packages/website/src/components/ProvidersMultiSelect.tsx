import { Checkbox } from './Checkbox.js';

type ProvidersMultiSelectProps = {
  label: string;
  providers: string[];
  selected: string[];
  onToggle: (value: string) => void;
  otherValue: string;
  onOtherChange: (value: string) => void;
};

export function ProvidersMultiSelect({
  label,
  providers,
  selected,
  onToggle,
  otherValue,
  onOtherChange,
}: ProvidersMultiSelectProps) {
  return (
    <div className="mt-5">
      <p className="mb-2 text-xs font-medium text-zinc-900">{label}</p>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {providers.map((p) => {
          const checked = selected.includes(p);

          if (p === 'Other') {
            return (
              <div
                key={p}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-zinc-50 sm:col-span-2"
              >
                <label className="flex flex-shrink-0 cursor-pointer items-center gap-3">
                  <Checkbox aria-label={p} checked={checked} onChange={() => onToggle(p)} />
                  <span className="text-sm text-zinc-700">{p}</span>
                </label>
                {checked && (
                  <input
                    type="text"
                    autoFocus
                    aria-label="Which other tool?"
                    placeholder="Which one?"
                    value={otherValue}
                    onChange={(e) => onOtherChange(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-(--input-border-color) bg-white px-2.5 py-1.5 text-sm text-zinc-900 transition-colors placeholder:text-(--input-placeholder-color) focus-visible:brand-outline"
                  />
                )}
              </div>
            );
          }

          return (
            <label
              key={p}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-zinc-50"
            >
              <Checkbox aria-label={p} checked={checked} onChange={() => onToggle(p)} />
              <span className="text-sm text-zinc-700">{p}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
