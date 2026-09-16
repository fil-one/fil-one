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

/**
 * One option in a permission or action list: a checkbox, its name, and the
 * line under it. Shared by the key form's permission fields and the policy
 * editor's action fields, so the two lists cannot drift apart.
 */
export function CheckboxRow({
  testId,
  label,
  description,
  checked,
  disabled = false,
  tooltip,
  onChange,
}: CheckboxRowProps) {
  const row = (
    <label
      data-testid={testId}
      className={
        'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-150 ' +
        (disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-zinc-50')
      }
    >
      <Checkbox aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-zinc-900">{label}</span>
        <span className="text-meta text-zinc-500">{description}</span>
      </div>
    </label>
  );

  if (!tooltip) return row;
  return (
    <Tooltip content={tooltip} side="top">
      {row}
    </Tooltip>
  );
}
