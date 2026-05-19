import type { AccessKeyPermission, GranularPermission } from '@filone/shared';
import { GRANULAR_PERMISSION_MAP, GRANULAR_PERMISSION_LABELS } from '@filone/shared';

import { Checkbox } from './Checkbox';

type PermissionOption = {
  value: AccessKeyPermission;
  label: string;
  description: string;
};

const PERMISSION_OPTIONS: PermissionOption[] = [
  { value: 'read', label: 'Read', description: 'Download and retrieve objects' },
  { value: 'write', label: 'Write', description: 'Upload and overwrite objects' },
  { value: 'list', label: 'List', description: 'Browse and list objects' },
  { value: 'delete', label: 'Delete', description: 'Permanently remove objects' },
];

type AccessKeyPermissionsFieldsProps = {
  value: AccessKeyPermission[];
  onChange: (value: AccessKeyPermission[]) => void;
  granularPermissions: GranularPermission[];
  onGranularPermissionsChange: (value: GranularPermission[]) => void;
};

export function AccessKeyPermissionsFields({
  value,
  onChange,
  granularPermissions,
  onGranularPermissionsChange,
}: AccessKeyPermissionsFieldsProps) {
  function toggleBasic(permission: AccessKeyPermission) {
    if (value.includes(permission)) {
      onChange(value.filter((p) => p !== permission));
      const toRemove = new Set(GRANULAR_PERMISSION_MAP[permission]);
      onGranularPermissionsChange(granularPermissions.filter((g) => !toRemove.has(g)));
    } else {
      onChange([...value, permission]);
    }
  }

  function toggleGranular(granular: GranularPermission) {
    if (granularPermissions.includes(granular)) {
      onGranularPermissionsChange(granularPermissions.filter((g) => g !== granular));
    } else {
      onGranularPermissionsChange([...granularPermissions, granular]);
    }
  }

  return (
    <div className="flex flex-col">
      {PERMISSION_OPTIONS.map((option) => {
        const isChecked = value.includes(option.value);
        const granularOptions = GRANULAR_PERMISSION_MAP[option.value];

        return (
          <div key={option.value}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-50">
              <Checkbox
                aria-label={option.label}
                checked={isChecked}
                onChange={() => toggleBasic(option.value)}
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-zinc-900">{option.label}</span>
                <span className="text-[11px] text-zinc-500">{option.description}</span>
              </div>
            </label>

            {isChecked && granularOptions.length > 0 && (
              <div className="ml-9 mb-1 flex flex-col border-l-2 border-zinc-100 pl-2">
                {granularOptions.map((granular) => {
                  const meta = GRANULAR_PERMISSION_LABELS[granular];
                  return (
                    <label
                      key={granular}
                      className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-50"
                    >
                      <Checkbox
                        checked={granularPermissions.includes(granular)}
                        onChange={() => toggleGranular(granular)}
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs font-medium text-zinc-800">{meta.label}</span>
                        <span className="text-[11px] text-zinc-500">{meta.description}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
