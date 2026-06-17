import type { GranularPermission } from '@filone/shared';
import {
  GRANULAR_PERMISSIONS,
  GRANULAR_PERMISSION_GROUP_ORDER,
  GRANULAR_PERMISSION_LABELS,
} from '@filone/shared';

import { Checkbox } from './Checkbox';

type AccessKeyPermissionsFieldsProps = {
  value: GranularPermission[];
  onChange: (value: GranularPermission[]) => void;
};

export function AccessKeyPermissionsFields({ value, onChange }: AccessKeyPermissionsFieldsProps) {
  function toggleGranular(granular: GranularPermission) {
    if (value.includes(granular)) {
      onChange(value.filter((g) => g !== granular));
    } else {
      onChange([...value, granular]);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {GRANULAR_PERMISSION_GROUP_ORDER.map((group) => {
        const permissions = GRANULAR_PERMISSIONS.filter(
          (granular) => GRANULAR_PERMISSION_LABELS[granular].group === group,
        );
        if (permissions.length === 0) return null;
        return (
          <div key={group} className="flex flex-col">
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {group}
            </p>
            {permissions.map((granular) => {
              const meta = GRANULAR_PERMISSION_LABELS[granular];
              return (
                <label
                  key={granular}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-50"
                >
                  <Checkbox
                    aria-label={meta.label}
                    checked={value.includes(granular)}
                    onChange={() => toggleGranular(granular)}
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
