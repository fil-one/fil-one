import { useEffect, useRef, useState } from 'react';

import type { AccessKeyPermission, PermissionPreset } from '@filone/shared';
import {
  ACCESS_KEY_PERMISSIONS,
  ACCESS_KEY_PERMISSION_GROUP_ORDER,
  ACCESS_KEY_PERMISSION_LABELS,
  PERMISSION_PRESETS,
} from '@filone/shared';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

import { Checkbox } from './Checkbox';
import { Icon } from './Icon';

type AccessKeyPermissionsFieldsProps = {
  value: AccessKeyPermission[];
  onChange: (value: AccessKeyPermission[]) => void;
};

export function AccessKeyPermissionsFields({ value, onChange }: AccessKeyPermissionsFieldsProps) {
  function togglePermission(permission: AccessKeyPermission) {
    if (value.includes(permission)) {
      onChange(value.filter((p) => p !== permission));
    } else {
      onChange([...value, permission]);
    }
  }

  function toggleGroup(groupPermissions: AccessKeyPermission[]) {
    const allChecked = groupPermissions.every((p) => value.includes(p));
    if (allChecked) {
      onChange(value.filter((p) => !groupPermissions.includes(p)));
    } else {
      const toAdd = groupPermissions.filter((p) => !value.includes(p));
      onChange([...value, ...toAdd]);
    }
  }

  function applyPreset(permissions: readonly AccessKeyPermission[]) {
    onChange([...permissions]);
  }

  const activePreset =
    (Object.keys(PERMISSION_PRESETS) as PermissionPreset[]).find((label) => {
      const presetPerms = PERMISSION_PRESETS[label];
      return presetPerms.length === value.length && presetPerms.every((p) => value.includes(p));
    }) ?? null;

  // The detailed action list is collapsed when the selection matches a preset.
  // It is force-opened whenever the selection becomes custom, so we never hide a
  // grant the user can't infer from the collapsed state (e.g. editing a key with
  // hand-picked permissions). The user can still collapse manually afterwards.
  const [expanded, setExpanded] = useState(activePreset === null);
  const prevPresetRef = useRef(activePreset);
  useEffect(() => {
    if (activePreset === null && prevPresetRef.current !== null) {
      setExpanded(true);
    }
    prevPresetRef.current = activePreset;
  }, [activePreset]);

  return (
    <div className="flex flex-col gap-4">
      {/* Presets */}
      <div className="flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Presets</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PERMISSION_PRESETS) as PermissionPreset[]).map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => applyPreset(PERMISSION_PRESETS[label])}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                activePreset === label
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Toggle for the detailed, per-action list */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-fit items-center gap-1.5 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900"
      >
        <span className={clsx('inline-flex transition-transform', !expanded && '-rotate-90')}>
          <Icon component={CaretDownIcon} size={14} weight="bold" />
        </span>
        Customize permissions
        <span className="text-zinc-400">· {value.length} selected</span>
      </button>

      {/* Grouped permissions */}
      {expanded &&
        ACCESS_KEY_PERMISSION_GROUP_ORDER.map((group) => {
          const groupPermissions = ACCESS_KEY_PERMISSIONS.filter(
            (permission) => ACCESS_KEY_PERMISSION_LABELS[permission].group === group,
          );
          if (groupPermissions.length === 0) return null;

          const checkedCount = groupPermissions.filter((p) => value.includes(p)).length;
          const allChecked = checkedCount === groupPermissions.length;

          return (
            <div key={group} className="flex flex-col">
              <div className="mb-1 flex items-center justify-between py-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    {group}
                  </span>
                  <span className="text-[10px] font-medium tabular-nums text-zinc-400">
                    {checkedCount}/{groupPermissions.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => toggleGroup(groupPermissions)}
                  className="text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-600"
                >
                  {allChecked ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              {groupPermissions.map((permission) => {
                const meta = ACCESS_KEY_PERMISSION_LABELS[permission];
                return (
                  <label
                    key={permission}
                    className="-mx-3 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-50"
                  >
                    <Checkbox
                      aria-label={meta.label}
                      checked={value.includes(permission)}
                      onChange={() => togglePermission(permission)}
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-zinc-900">{meta.label}</span>
                      <span className="text-[11px] text-zinc-500">{meta.description}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          );
        })}

      {expanded && (
        <p className="text-[11px] text-zinc-400">
          Additional permissions required for Object Lock and versioning are always included.
        </p>
      )}
    </div>
  );
}
