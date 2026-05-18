import { Radio } from './Radio.js';

type RadioOptionProps = {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
};

export function RadioOption({ name, value, checked, onChange, children }: RadioOptionProps) {
  return (
    <label className="flex flex-1 cursor-pointer items-center gap-2.5 rounded-lg border border-zinc-200 px-4 py-3 text-sm font-normal text-zinc-900 transition-all hover:border-zinc-400 hover:bg-zinc-50 has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50">
      <Radio name={name} value={value} checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}
