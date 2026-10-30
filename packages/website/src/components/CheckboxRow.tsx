import { Checkbox } from './Checkbox.js';
import { Tooltip } from './Tooltip.js';

export type CheckboxRowProps = {
  testId: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  /** Shown over the row; the reason it is disabled, when it is. */
  tooltip?: string;
  onChange?: () => void;
};

/** One option in a checklist: a checkbox, its name, and the line under it. */
export function CheckboxRow({
  testId,
  label,
  description,
  checked,
  disabled = false,
  tooltip,
  onChange,
}: CheckboxRowProps) {
  // A `<label>` cannot reach the `<span role="checkbox">` Headless UI renders,
  // so the row toggles on its own click, and the checkbox keeps its click to
  // itself rather than toggling twice.
  const row = (
    <div
      data-testid={testId}
      className={
        'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-150 ' +
        (disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-zinc-50')
      }
      onClick={disabled ? undefined : onChange}
    >
      <Checkbox
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-zinc-900">{label}</span>
        <span className="text-meta text-zinc-500">{description}</span>
      </div>
    </div>
  );

  if (!tooltip) return row;
  // `self-start` keeps the trigger as wide as the row's content, so the tooltip
  // opens beside the label rather than past the end of the whole list. Beside
  // rather than above, so it does not cover the row or heading over it.
  return (
    <Tooltip content={tooltip} side="right" className="self-start">
      {row}
    </Tooltip>
  );
}
