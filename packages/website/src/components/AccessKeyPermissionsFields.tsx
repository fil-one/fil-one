import type {
  AccessKeyPermission,
  BucketInfoPermission,
  BucketPermission,
  GranularPermission,
  ObjectPermission,
  S3Region,
} from '@filone/shared';
import {
  BUCKET_INFO_PERMISSIONS,
  BUCKET_INFO_PERMISSION_LABELS,
  BUCKET_PERMISSIONS,
  BUCKET_PERMISSION_LABELS,
  GRANULAR_PERMISSION_MAP,
  GRANULAR_PERMISSION_LABELS,
  getRegionLabel,
  supportsBucketManagement,
} from '@filone/shared';

import { Checkbox } from './Checkbox';
import { Tooltip } from './Tooltip';

type PermissionOption = {
  value: ObjectPermission;
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
  region: S3Region;
};

export function AccessKeyPermissionsFields({
  value,
  onChange,
  granularPermissions,
  onGranularPermissionsChange,
  region,
}: AccessKeyPermissionsFieldsProps) {
  function toggleBasic(permission: ObjectPermission) {
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

  function toggleBucket(permission: BucketPermission | BucketInfoPermission) {
    if (value.includes(permission)) {
      onChange(value.filter((p) => p !== permission));
    } else {
      onChange([...value, permission]);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="access-key-permissions">
      <Section title="Object permissions" testId="permissions-section-object">
        {PERMISSION_OPTIONS.map((option) => {
          const isChecked = value.includes(option.value);
          const granularOptions = GRANULAR_PERMISSION_MAP[option.value];

          return (
            <div key={option.value}>
              <label
                data-testid={`permission-${option.value}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-50"
              >
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
                        data-testid={`granular-permission-${granular}`}
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
      </Section>

      <Section title="Bucket management" testId="permissions-section-bucket">
        <BucketManagementFields permissions={value} onToggle={toggleBucket} region={region} />
      </Section>
    </div>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col" data-testid={testId}>
      <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        {title}
      </p>
      {children}
    </div>
  );
}

type BucketManagementFieldsProps = {
  permissions: AccessKeyPermission[];
  onToggle: (permission: BucketPermission | BucketInfoPermission) => void;
  region: S3Region;
};

function BucketManagementFields({ permissions, onToggle, region }: BucketManagementFieldsProps) {
  const supported = supportsBucketManagement(region);
  const unsupportedReason = `Not supported in ${getRegionLabel(region)}`;

  return (
    <>
      {/* List all buckets — always granted, not configurable. */}
      <PermissionRow
        testId="permission-list-buckets"
        label="List all buckets"
        description="List all buckets in the account"
        checked
        disabled
        tooltip="Always enabled — this permission is currently not configurable."
      />

      {/* Bucket-info reads — selectable in every region, not region-gated. */}
      {BUCKET_INFO_PERMISSIONS.map((permission: BucketInfoPermission) => {
        const meta = BUCKET_INFO_PERMISSION_LABELS[permission];
        return (
          <PermissionRow
            key={permission}
            testId={`permission-${permission}`}
            label={meta.label}
            description={meta.description}
            checked={permissions.includes(permission)}
            onChange={() => onToggle(permission)}
          />
        );
      })}

      {BUCKET_PERMISSIONS.map((permission: BucketPermission) => {
        const meta = BUCKET_PERMISSION_LABELS[permission];
        return (
          <PermissionRow
            key={permission}
            testId={`permission-${permission}`}
            label={meta.label}
            description={meta.description}
            checked={supported && permissions.includes(permission)}
            disabled={!supported}
            tooltip={supported ? undefined : unsupportedReason}
            onChange={() => onToggle(permission)}
          />
        );
      })}
    </>
  );
}

type PermissionRowProps = {
  testId: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  tooltip?: string;
  onChange?: () => void;
};

function PermissionRow({
  testId,
  label,
  description,
  checked,
  disabled = false,
  tooltip,
  onChange,
}: PermissionRowProps) {
  const row = (
    <label
      data-testid={testId}
      className={
        'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ' +
        (disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-zinc-50')
      }
    >
      <Checkbox aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-zinc-900">{label}</span>
        <span className="text-[11px] text-zinc-500">{description}</span>
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
