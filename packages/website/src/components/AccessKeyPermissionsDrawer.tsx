import { useEffect, useState } from 'react';
import { CheckIcon, XIcon } from '@phosphor-icons/react/dist/ssr';

import type { AccessKey } from '@filone/shared';
import {
  BUCKET_INFO_PERMISSION_LABELS,
  BUCKET_PERMISSION_LABELS,
  GRANULAR_PERMISSION_LABELS,
  GRANULAR_PERMISSION_MAP,
  isBucketInfoPermission,
  isBucketPermission,
} from '@filone/shared';

import { PERMISSION_OPTIONS } from '../lib/access-key-permission-options.js';

export type AccessKeyPermissionsDrawerProps = {
  accessKey: AccessKey;
  onClose: () => void;
};

/**
 * The full breakdown of what a key can do, in the same layout the create form
 * uses to grant it — so reviewing a key and minting one read the same way.
 * Exists because the table row has no room to be both scannable across many
 * keys and exhaustive about one of them; this is where exhaustive lives.
 */
export function AccessKeyPermissionsDrawer({
  accessKey,
  onClose,
}: AccessKeyPermissionsDrawerProps) {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  function handleClose() {
    setClosing(true);
    setTimeout(onClose, 200);
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const shown = visible && !closing;

  // PERMISSION_OPTIONS' order, not the array's: the create form always
  // presents Read/Write/List/Delete in that fixed order, and a key stores
  // whatever order they were toggled in, which is not a fact worth showing.
  const objectPermissions = PERMISSION_OPTIONS.map((o) => o.value).filter((p) =>
    accessKey.permissions.includes(p),
  );
  const bucketManagement = accessKey.permissions.filter(isBucketPermission);
  const bucketInfo = accessKey.permissions.filter(isBucketInfoPermission);
  const granularPermissions = accessKey.granularPermissions ?? [];

  return (
    <div data-testid="access-key-permissions-drawer">
      <div
        data-testid="access-key-permissions-drawer-overlay"
        aria-hidden="true"
        onClick={handleClose}
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <div
        data-testid="access-key-permissions-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Permissions for ${accessKey.keyName}`}
        className={`fixed inset-y-0 right-0 z-40 flex w-[400px] flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-200 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex flex-shrink-0 items-start justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-zinc-900">{accessKey.keyName}</p>
            <p className="font-mono text-xs text-zinc-500">{accessKey.accessKeyId}</p>
          </div>
          <button
            data-testid="access-key-permissions-drawer-close"
            onClick={handleClose}
            aria-label="Close"
            className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          >
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-6">
            {objectPermissions.length > 0 && (
              <DrawerSection title="Object permissions" testId="object">
                {objectPermissions.map((permission) => {
                  const option = PERMISSION_OPTIONS.find((o) => o.value === permission);
                  if (!option) return null;
                  const extras = GRANULAR_PERMISSION_MAP[permission].filter((g) =>
                    granularPermissions.includes(g),
                  );
                  return (
                    <div key={permission}>
                      <PermissionRow label={option.label} description={option.description} />
                      {extras.length > 0 && (
                        <div className="mt-1 ml-6 flex flex-col gap-2 border-l-2 border-zinc-100 pl-3">
                          {extras.map((g) => (
                            <PermissionRow
                              key={g}
                              label={GRANULAR_PERMISSION_LABELS[g].label}
                              description={GRANULAR_PERMISSION_LABELS[g].description}
                              subtle
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </DrawerSection>
            )}

            {(bucketManagement.length > 0 || bucketInfo.length > 0) && (
              // Same section, same order as AccessKeyPermissionsFields: the
              // always-on fact first, then the bucket-info reads, then the
              // region-gated management writes. Two sections here would say
              // this is a different taxonomy from the one the key was built
              // with, and it isn't.
              <DrawerSection title="Bucket management" testId="bucket-management">
                <PermissionRow
                  label="List all buckets"
                  description="List all buckets in the account"
                />
                {bucketInfo.map((permission) => (
                  <PermissionRow
                    key={permission}
                    label={BUCKET_INFO_PERMISSION_LABELS[permission].label}
                    description={BUCKET_INFO_PERMISSION_LABELS[permission].description}
                  />
                ))}
                {bucketManagement.map((permission) => (
                  <PermissionRow
                    key={permission}
                    label={BUCKET_PERMISSION_LABELS[permission].label}
                    description={BUCKET_PERMISSION_LABELS[permission].description}
                  />
                ))}
              </DrawerSection>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DrawerSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={`access-key-permissions-drawer-section-${testId}`}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</p>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

function PermissionRow({
  label,
  description,
  subtle,
}: {
  label: string;
  description: string;
  subtle?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <CheckIcon
        size={14}
        weight="bold"
        className={`mt-0.5 shrink-0 ${subtle ? 'text-brand-400' : 'text-brand-600'}`}
      />
      <div className="flex flex-col">
        <span className={`text-xs font-medium ${subtle ? 'text-zinc-700' : 'text-zinc-900'}`}>
          {label}
        </span>
        <span className="text-xs text-zinc-500">{description}</span>
      </div>
    </div>
  );
}
