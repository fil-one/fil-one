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
      <div className="flex gap-3">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2.5 text-sm hover:bg-zinc-50 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50"
          >
            <input
              type="radio"
              name="expiration"
              value={option.value}
              checked={value === option.value}
              onChange={() => handleOptionChange(option.value)}
              className="accent-brand-600"
            />
            <span className="font-medium text-zinc-900">{option.label}</span>
          </label>
        ))}
      </div>

      {value === 'custom' && (
        <input
          type="date"
          value={customDate ?? ''}
          min={new Date().toISOString().split('T')[0]}
          onChange={(e) => onDateChange(e.target.value || null)}
          className="block w-full rounded-lg border border-zinc-200 p-2.5 text-sm text-zinc-900 focus:outline-2 focus:outline-brand-600"
        />
      )}
    </div>
  );
}
