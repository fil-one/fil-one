import { Radio } from './Radio.js';

type RadioOptionProps = {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
  description?: string;
};

export function RadioOption({
  name,
  value,
  checked,
  onChange,
  children,
  description,
}: RadioOptionProps) {
  return (
    <label className="flex flex-1 cursor-pointer items-center gap-2.5 rounded-lg border border-zinc-200 px-3.5 py-2.5 transition-all hover:border-zinc-300 hover:bg-zinc-50 has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50">
      <Radio name={name} value={value} checked={checked} onChange={onChange} />
      {description ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-(--color-text-base)">{children}</span>
          <span className="text-[11px] leading-relaxed text-(--color-paragraph-text-subtle)">
            {description}
          </span>
        </div>
      ) : (
        <span className="text-xs font-normal text-(--color-text-base)">{children}</span>
      )}
    </label>
  );
}
