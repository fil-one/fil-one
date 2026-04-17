import { useState, useEffect } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

type DurationUnit = { value: string; label: string };

type DurationInputProps = {
  value: number;
  onValueChange: (value: number) => void;
  unit: string;
  onUnitChange: (unit: string) => void;
  units: DurationUnit[];
  min?: number;
  max?: number;
  invalid?: boolean;
  disabled?: boolean;
  numberInputId?: string;
  /** Optional expiry date label shown to the right, e.g. "Expires Apr 24, 2026" */
  expiresLabel?: string;
};

export function DurationInput({
  value,
  onValueChange,
  unit,
  onUnitChange,
  units,
  min = 1,
  max,
  invalid = false,
  disabled = false,
  numberInputId,
  expiresLabel,
}: DurationInputProps) {
  // Local string state so the user can clear/type freely; commits on blur or valid change
  const [localValue, setLocalValue] = useState(String(value));

  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  function handleChange(raw: string) {
    setLocalValue(raw);
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= min && (max === undefined || val <= max)) {
      onValueChange(val);
    }
  }

  function handleBlur() {
    const val = parseInt(localValue, 10);
    if (isNaN(val) || val < min) {
      setLocalValue(String(min));
      onValueChange(min);
    } else if (max !== undefined && val > max) {
      setLocalValue(String(max));
      onValueChange(max);
    }
  }

  const borderColor = invalid ? 'border-amber-400' : 'border-(--input-border-color)';

  return (
    <div className="flex items-center gap-2.5">
      <div
        className={clsx(
          'inline-flex w-fit overflow-hidden rounded-md border bg-white transition-colors',
          'focus-within:brand-outline',
          borderColor,
          disabled && 'cursor-not-allowed bg-zinc-100 opacity-60',
          invalid && 'bg-amber-50',
        )}
      >
        {/* Number input */}
        <input
          id={numberInputId}
          type="number"
          min={min}
          max={max}
          step={1}
          value={localValue}
          disabled={disabled}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          className={clsx(
            'w-14 bg-transparent py-2 pl-3 pr-1 text-sm text-(--color-text-base)',
            'focus:outline-none',
            'disabled:cursor-not-allowed',
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          )}
        />

        {/* Divider */}
        <div className="my-2 w-px bg-zinc-200" />

        {/* Unit select */}
        <div className="relative flex items-center">
          <select
            value={unit}
            disabled={disabled}
            onChange={(e) => onUnitChange(e.target.value)}
            className={clsx(
              'appearance-none bg-transparent py-2 pl-3 pr-7 text-sm text-(--color-text-base)',
              'focus:outline-none',
              'disabled:cursor-not-allowed',
            )}
          >
            {units.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
          <CaretDownIcon
            className="pointer-events-none absolute right-2 text-zinc-400"
            size={13}
            aria-hidden="true"
          />
        </div>
      </div>
      {expiresLabel && <span className="text-[11px] text-zinc-500">{expiresLabel}</span>}
    </div>
  );
}
