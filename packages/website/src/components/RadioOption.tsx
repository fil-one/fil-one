import { clsx } from 'clsx';

import { Radio } from './Radio.js';

type RadioOptionProps = {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
  description?: string;
  testId?: string;
};

export function RadioOption({
  name,
  value,
  checked,
  onChange,
  children,
  description,
  testId,
}: RadioOptionProps) {
  return (
    <label
      data-testid={testId}
      className={clsx(
        'flex flex-1 cursor-pointer gap-2.5 rounded-lg border border-zinc-200 px-4 py-3 transition-all hover:border-zinc-400 hover:bg-zinc-50 has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50',
        // With a description the radio sits on the title's line, so options of
        // different heights keep their titles level.
        description ? 'items-start' : 'items-center',
      )}
    >
      <Radio name={name} value={value} checked={checked} onChange={onChange} />
      {description ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-zinc-900">{children}</span>
          <span className="text-meta leading-relaxed text-zinc-500">{description}</span>
        </div>
      ) : (
        <span className="text-xs font-normal text-zinc-900">{children}</span>
      )}
    </label>
  );
}
