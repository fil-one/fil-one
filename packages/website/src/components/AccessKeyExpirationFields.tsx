import { RadioOption } from './RadioOption.js';

export type ExpirationOption = 'never' | '30d' | 'custom';

type AccessKeyExpirationFieldsProps = {
  value: ExpirationOption;
  customDate: string | null;
  onChange: (value: ExpirationOption) => void;
  onDateChange: (date: string | null) => void;
};

const OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: 'never', label: 'Never expires' },
  { value: '30d', label: '30 days' },
  { value: 'custom', label: 'Custom' },
];

export function AccessKeyExpirationFields({
  value,
  customDate,
  onChange,
  onDateChange,
}: AccessKeyExpirationFieldsProps) {
  function handleOptionChange(option: ExpirationOption) {
    onChange(option);
    if (option !== 'custom') {
      onDateChange(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map((option) => (
          <RadioOption
            key={option.value}
            name="expiration"
            value={option.value}
            checked={value === option.value}
            onChange={() => handleOptionChange(option.value)}
          >
            {option.label}
          </RadioOption>
        ))}
      </div>

      {value === 'custom' && (
        <input
          type="date"
          aria-label="Custom expiration date"
          value={customDate ?? ''}
          min={new Date().toISOString().split('T')[0]}
          onChange={(e) => onDateChange(e.target.value || null)}
          className="mt-1 block w-full rounded-lg border border-zinc-200 p-2.5 text-sm text-zinc-900 focus:outline-2 focus:outline-brand-600"
        />
      )}
    </div>
  );
}
