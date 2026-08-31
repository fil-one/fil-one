import type { OrgRole } from '@filone/shared';

import { ROLE_LABELS } from '../lib/use-member-scope.js';
import type { InputSize } from './Input';
import { Select } from './Select';

export type RoleSelectProps = {
  id?: string;
  value: OrgRole;
  onChange: (role: OrgRole) => void;
  /**
   * The roles this caller may hand out — their ceiling, as a list. An Admin's
   * list has no Owner in it, which is the whole point: the option is absent
   * rather than present-and-refused.
   */
  roles: readonly OrgRole[];
  disabled?: boolean;
  invalid?: boolean;
  size?: InputSize;
  className?: string;
  'aria-label'?: string;
};

/**
 * A role picker bounded by what the caller may assign.
 *
 * `RegionSelect`'s shape, including its disable-when-there-is-one-option touch:
 * a list of one is not a choice, and a select that cannot change is clearer
 * disabled than live. The server still enforces the ceiling — this only keeps a
 * refusal off the screen.
 */
export function RoleSelect({
  id,
  value,
  onChange,
  roles,
  disabled,
  invalid,
  size,
  className,
  'aria-label': ariaLabel,
}: RoleSelectProps) {
  const onlyOne = roles.length === 1;

  return (
    <Select
      {...(id ? { id } : { 'aria-label': ariaLabel ?? 'Role' })}
      value={value}
      invalid={invalid}
      selectSize={size}
      className={className}
      onChange={(next) => onChange(next as OrgRole)}
      disabled={disabled || onlyOne}
    >
      {/* The member's current role is always an option even when the caller
          cannot assign it, so the select shows what they hold rather than
          silently falling back to the first role they could be moved to. */}
      {!roles.includes(value) && <option value={value}>{ROLE_LABELS[value]}</option>}
      {roles.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </Select>
  );
}
