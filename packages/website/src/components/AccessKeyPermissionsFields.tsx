import type { AccessKeyPermission } from '@filone/shared';
import {
  ACCESS_KEY_PERMISSIONS,
  ACCESS_KEY_PERMISSION_GROUP_ORDER,
  ACCESS_KEY_PERMISSION_LABELS,
} from '@filone/shared';

import { Checkbox } from './Checkbox';

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

  return (
    <div className="flex flex-col gap-4">
      {ACCESS_KEY_PERMISSION_GROUP_ORDER.map((group) => {
        const permissions = ACCESS_KEY_PERMISSIONS.filter(
          (permission) => ACCESS_KEY_PERMISSION_LABELS[permission].group === group,
        );
        if (permissions.length === 0) return null;
        return (
          <div key={group} className="flex flex-col">
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {group}
            </p>
            {permissions.map((permission) => {
              const meta = ACCESS_KEY_PERMISSION_LABELS[permission];
              return (
                <label
                  key={permission}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-50"
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
    </div>
  );
}
