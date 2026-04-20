import type { AccessKeyPermission } from '@filone/shared';
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
};

export function AccessKeyPermissionsFields({ value, onChange }: AccessKeyPermissionsFieldsProps) {
  function toggle(permission: AccessKeyPermission) {
    if (value.includes(permission)) {
      onChange(value.filter((p) => p !== permission));
    } else {
      onChange([...value, permission]);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {PERMISSION_OPTIONS.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-zinc-50"
        >
          <Checkbox
            aria-label={option.label}
            checked={value.includes(option.value)}
            onChange={() => toggle(option.value)}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-zinc-900">{option.label}</span>
            <span className="text-xs text-zinc-600">{option.description}</span>
          </div>
        </label>
      ))}
    </div>
  );
}
