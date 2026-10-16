import { useEffect, useState } from 'react';
import { ArrowsClockwiseIcon, CheckIcon, TrashIcon, XIcon } from '@phosphor-icons/react/dist/ssr';

import type { AccessKey, ServiceAccessKey } from '@filone/shared';
import {
  BUCKET_INFO_PERMISSION_LABELS,
  BUCKET_PERMISSION_LABELS,
  GRANULAR_PERMISSION_LABELS,
  GRANULAR_PERMISSION_MAP,
  getRegionLabel,
  isBucketInfoPermission,
  isBucketPermission,
} from '@filone/shared';

import { KeyStatus } from './AccessKeyCells';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { RegionFlag } from './RegionFlag';
import { PERMISSION_OPTIONS } from '../lib/access-key-permission-options.js';
import { formatCalendarDate, formatDate } from '../lib/time.js';

type Person = { name: string; email?: string };

export type AccessKeyDetailsDrawerProps = {
  accessKey: AccessKey;
  onClose: () => void;
  /** Resolves a user id to a person; omitted, the drawer names nobody. */
  creatorFor?: (userId: string) => Person | undefined;
  /** Present only when the caller may rotate this key, as in the row's menu. */
  onRotate?: () => void;
  /** Present only when the caller may delete this key, as in the row's menu. */
  onDelete?: () => void;
};

/**
 * Everything about one key. The table keeps what is worth comparing across
 * rows; the rest (the full bucket list, every permission, who created it and
 * when) lives here, in the layout the create form uses, so reviewing a key and
 * minting one read the same way.
 */
export function AccessKeyDetailsDrawer({
  accessKey,
  onClose,
  creatorFor,
  onRotate,
  onDelete,
}: AccessKeyDetailsDrawerProps) {
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

  return (
    <div data-testid="access-key-details-drawer">
      <div
        data-testid="access-key-details-drawer-overlay"
        aria-hidden="true"
        onClick={handleClose}
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <div
        data-testid="access-key-details-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${accessKey.keyName}`}
        className={`fixed inset-y-0 right-0 z-40 flex w-full flex-col bg-white shadow-xl transition-transform duration-200 ease-out sm:w-100 ${shown ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <DrawerHeader accessKey={accessKey} onClose={handleClose} />

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-6">
            <KeyFacts accessKey={accessKey} creatorFor={creatorFor} />
            {accessKey.type === 'principal' ? (
              <DrawerSection title="Permissions" testId="follows-bucket-policy">
                <p className="text-xs text-zinc-500">
                  This key acts as its owner. Each bucket&apos;s policy decides what it can reach.
                </p>
              </DrawerSection>
            ) : (
              <ServiceKeyPermissions accessKey={accessKey} />
            )}
          </div>
        </div>

        {(onRotate ?? onDelete) && (
          // The row's menu offers the same two actions; this is the key's detail
          // view, so acting on it should not mean closing it to find the menu.
          <div
            data-testid="access-key-details-drawer-footer"
            className="flex flex-shrink-0 justify-end gap-2 border-t border-zinc-100 px-5 py-3"
          >
            {onRotate && (
              <Button variant="ghost" size="sm" icon={ArrowsClockwiseIcon} onClick={onRotate}>
                Rotate key
              </Button>
            )}
            {onDelete && (
              <Button variant="destructive" size="sm" icon={TrashIcon} onClick={onDelete}>
                Delete key
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DrawerHeader({ accessKey, onClose }: { accessKey: AccessKey; onClose: () => void }) {
  return (
    <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
      {/* min-w-0 so a long name or ID wraps inside the header rather than
          pushing the close button off the panel. */}
      <div className="min-w-0">
        <p className="text-sm font-semibold break-words text-zinc-900">{accessKey.keyName}</p>
        <div className="flex items-center gap-1">
          <p className="font-mono text-xs break-all text-zinc-500">{accessKey.accessKeyId}</p>
          <CopyButton value={accessKey.accessKeyId} />
        </div>
      </div>
      <button
        data-testid="access-key-details-drawer-close"
        onClick={onClose}
        aria-label="Close"
        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
      >
        <XIcon size={16} weight="bold" />
      </button>
    </div>
  );
}

/** The key's facts as label and value pairs, one per line. */
function KeyFacts({
  accessKey,
  creatorFor,
}: {
  accessKey: AccessKey;
  creatorFor?: (userId: string) => Person | undefined;
}) {
  const creator = accessKey.createdBy ? creatorFor?.(accessKey.createdBy) : undefined;
  const rotator = accessKey.rotatedBy ? creatorFor?.(accessKey.rotatedBy) : undefined;
  return (
    <dl
      data-testid="access-key-details-facts"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs"
    >
      <Fact label="Status">
        <KeyStatus accessKey={accessKey} />
      </Fact>
      <Fact label="Type">{accessKey.type === 'principal' ? 'Personal' : 'Service'}</Fact>
      {accessKey.region && (
        <Fact label="Region">
          <div className="flex items-center gap-2">
            <RegionFlag region={accessKey.region} />
            <span>
              {getRegionLabel(accessKey.region)}{' '}
              <span className="text-zinc-500">{accessKey.region}</span>
            </span>
          </div>
        </Fact>
      )}
      <Fact label="Buckets">
        <BucketList accessKey={accessKey} />
      </Fact>
      {/* An active key's expiry is a date still to come; an expired one already
          shows it under its status. */}
      {accessKey.status === 'active' && (
        <Fact label="Expires">
          {accessKey.expiresAt ? formatCalendarDate(accessKey.expiresAt) : 'Never'}
        </Fact>
      )}
      <Fact label="Created">
        {formatDate(accessKey.createdAt)}
        {creator && <span className="text-zinc-500"> by {creator.name}</span>}
      </Fact>
      {accessKey.rotatedBy && (
        <Fact label="Rotated">
          {accessKey.rotatedAt ? formatDate(accessKey.rotatedAt) : 'Yes'}
          {rotator && <span className="text-zinc-500"> by {rotator.name}</span>}
        </Fact>
      )}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-zinc-900">{children}</dd>
    </>
  );
}

function BucketList({ accessKey }: { accessKey: AccessKey }) {
  if (accessKey.type === 'principal') return <>Per bucket policy</>;
  if (accessKey.bucketScope === 'all') return <>All buckets</>;
  const buckets = accessKey.buckets ?? [];
  if (buckets.length === 0) return <span className="text-zinc-400">None</span>;
  return (
    <ul data-testid="access-key-details-buckets" className="flex flex-col gap-1">
      {buckets.map((bucket) => (
        <li key={bucket} className="break-all">
          {bucket}
        </li>
      ))}
    </ul>
  );
}

function ServiceKeyPermissions({ accessKey }: { accessKey: ServiceAccessKey }) {
  // PERMISSION_OPTIONS' order, not the array's: the create form always
  // presents Read/Write/List/Delete in that fixed order, and a key stores
  // whatever order they were toggled in, which is not a fact worth showing.
  const permissions = accessKey.permissions ?? [];
  const objectPermissions = PERMISSION_OPTIONS.map((o) => o.value).filter((p) =>
    permissions.includes(p),
  );
  const bucketManagement = permissions.filter(isBucketPermission);
  const bucketInfo = permissions.filter(isBucketInfoPermission);
  const granularPermissions = accessKey.granularPermissions ?? [];

  return (
    <>
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
          <PermissionRow label="List all buckets" description="List all buckets in the account" />
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
    </>
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
    <div data-testid={`access-key-details-drawer-section-${testId}`}>
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
