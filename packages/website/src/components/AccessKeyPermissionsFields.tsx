import { useId, useState } from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react/dist/ssr';

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
  const [expandedPermissions, setExpandedPermissions] = useState<Set<AccessKeyPermission>>(
    new Set(),
  );
  const granularSectionIdPrefix = useId();

  function toggleBasic(permission: AccessKeyPermission) {
    if (value.includes(permission)) {
      onChange(value.filter((p) => p !== permission));
      // Remove granular permissions for the unchecked basic permission
      const toRemove = new Set(GRANULAR_PERMISSION_MAP[permission]);
      onGranularPermissionsChange(granularPermissions.filter((g) => !toRemove.has(g)));
      setExpandedPermissions((prev) => {
        const next = new Set(prev);
        next.delete(permission);
        return next;
      });
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

  function toggleExpanded(permission: AccessKeyPermission) {
    setExpandedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) {
        next.delete(permission);
      } else {
        next.add(permission);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-1">
      {PERMISSION_OPTIONS.map((option) => {
        const isChecked = value.includes(option.value);
        const granularOptions = GRANULAR_PERMISSION_MAP[option.value];
        const isExpanded = expandedPermissions.has(option.value);
        const includedCount = granularOptions.filter((g) => granularPermissions.includes(g)).length;

        return (
          <div key={option.value}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-zinc-50">
              <Checkbox
                aria-label={option.label}
                checked={isChecked}
                onChange={() => toggleBasic(option.value)}
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-zinc-900">{option.label}</span>
                <span className="text-xs text-zinc-600">{option.description}</span>
              </div>
            </label>

            {isChecked && granularOptions.length > 0 && (
              <div className="ml-11">
                <button
                  type="button"
                  onClick={() => toggleExpanded(option.value)}
                  aria-expanded={isExpanded}
                  aria-controls={`${granularSectionIdPrefix}-${option.value}`}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700"
                >
                  {isExpanded ? (
                    <CaretDownIcon size={12} aria-hidden="true" />
                  ) : (
                    <CaretRightIcon size={12} aria-hidden="true" />
                  )}
                  <span>
                    Data protection ({includedCount} of {granularOptions.length})
                  </span>
                </button>

                {isExpanded && (
                  <div
                    id={`${granularSectionIdPrefix}-${option.value}`}
                    className="flex flex-col gap-0.5 pb-1 pt-0.5"
                  >
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
                          <div className="flex flex-col">
                            <span className="text-xs font-medium text-zinc-800">{meta.label}</span>
                            <span className="text-[11px] text-zinc-500">{meta.description}</span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
