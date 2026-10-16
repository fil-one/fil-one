import { Fragment, useState } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { XIcon } from '@phosphor-icons/react/dist/ssr';

import { Link } from '@tanstack/react-router';

import type { AccessKey, GranularPermission, S3Region, ServiceAccessKey } from '@filone/shared';
import {
  BUCKET_INFO_PERMISSION_LABELS,
  BUCKET_PERMISSION_LABELS,
  GRANULAR_PERMISSION_LABELS,
  GRANULAR_PERMISSION_MAP,
  S3_REGION,
  getRegionLabel,
  isBucketInfoPermission,
  isBucketPermission,
} from '@filone/shared';

import { KeyStatus, keyMenuActions } from './AccessKeyCells';
import { CopyButton } from './CopyButton';
import { RegionFlag } from './RegionFlag';
import { RowActionsMenu, type RowAction } from './RowActionsMenu';
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
  /**
   * Whether each bucket name links to its page. Off where the drawer opens on a
   * bucket's own page, which would only link to itself.
   */
  linkBuckets?: boolean;
};

/**
 * Everything about one key. The table keeps what is worth comparing across
 * rows; the rest (the full bucket list, every permission, who created it and
 * when) lives here.
 *
 * Built on Headless UI's `Dialog`, as `Modal` is, for what a modal panel owes a
 * keyboard: focus moves in when it opens, Tab stays inside, Escape and the
 * backdrop close it, and focus goes back to the row that opened it.
 */
export function AccessKeyDetailsDrawer({
  accessKey,
  onClose,
  creatorFor,
  onRotate,
  onDelete,
  linkBuckets = false,
}: AccessKeyDetailsDrawerProps) {
  // Mounted open; closing plays the slide-out, then tells the table to unmount.
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);

  return (
    <Transition show={open} appear as={Fragment} afterLeave={onClose}>
      <Dialog data-testid="access-key-details-drawer" className="relative z-40" onClose={close}>
        <TransitionChild
          as={Fragment}
          enter="transition-opacity duration-200 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity duration-200 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <DialogBackdrop
            data-testid="access-key-details-drawer-overlay"
            className="fixed inset-0 bg-black/40"
          />
        </TransitionChild>
        <div className="fixed inset-y-0 right-0 flex w-full sm:w-100">
          {/* No resting transform: the classes that slide the panel apply only
              while it moves, so nothing inside is positioned against a
              transformed ancestor once it is open. */}
          <TransitionChild
            as={Fragment}
            enter="transition-transform duration-200 ease-out"
            enterFrom="translate-x-full"
            leave="transition-transform duration-200 ease-in"
            leaveTo="translate-x-full"
          >
            <DialogPanel
              data-testid="access-key-details-drawer-panel"
              className="flex w-full flex-col bg-white shadow-xl"
            >
              <DrawerHeader
                accessKey={accessKey}
                onClose={close}
                actions={keyMenuActions({ onRotate, onDelete })}
              />
              <div className="flex-1 overflow-y-auto">
                {/* Facts, object permissions and bucket management each sit in a
                    band of their own, divided by the same full-width hairline as
                    the header above them. */}
                <div className="flex flex-col divide-y divide-zinc-100 text-ui *:px-5 *:py-5">
                  <KeyFacts accessKey={accessKey} creatorFor={creatorFor} />
                  <BucketsSection accessKey={accessKey} linkBuckets={linkBuckets} />
                  {accessKey.type === 'principal' ? (
                    <DrawerSection title="Permissions" testId="follows-bucket-policy">
                      <p className="text-zinc-500">
                        This key acts as its owner. Each bucket&apos;s policy decides what it can
                        reach.
                      </p>
                    </DrawerSection>
                  ) : (
                    <ServiceKeyPermissions accessKey={accessKey} />
                  )}
                </div>
              </div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}

function DrawerHeader({
  accessKey,
  onClose,
  actions,
}: {
  accessKey: AccessKey;
  onClose: () => void;
  actions: RowAction[];
}) {
  return (
    <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
      {/* min-w-0 so a long name wraps, and a long ID truncates, inside the
          header rather than pushing the buttons off the panel. */}
      <div className="min-w-0">
        <DialogTitle className="text-base font-medium break-words text-zinc-900">
          {accessKey.keyName}
        </DialogTitle>
        {/* One line, as in the table: wrapped, a long ID turned the header into
            a block of characters. `title` and the copy button keep the full value. */}
        <div className="mt-0.5 flex items-center gap-1">
          <p className="truncate font-mono text-xs text-zinc-500" title={accessKey.accessKeyId}>
            {accessKey.accessKeyId}
          </p>
          <CopyButton value={accessKey.accessKeyId} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* One step away, as in the row: this panel is for reading, and a red
            button pinned under it was the loudest thing on it. */}
        {actions.length > 0 && (
          <RowActionsMenu
            actions={actions}
            aria-label="Key actions"
            testId="access-key-details-drawer-actions"
          />
        )}
        <button
          type="button"
          data-testid="access-key-details-drawer-close"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:brand-outline"
        >
          <XIcon size={16} weight="bold" />
        </button>
      </div>
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
      className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3"
    >
      <Fact label="Status">
        <KeyStatus accessKey={accessKey} />
      </Fact>
      {/* The dates sit together under the status they explain. "Expired" for a
          date already passed, so the label agrees with the status above it. */}
      <Fact label={accessKey.status === 'expired' ? 'Expired' : 'Expires'}>
        {accessKey.expiresAt ? formatCalendarDate(accessKey.expiresAt) : 'Never'}
      </Fact>
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

const BUCKETS_SHOWN_MAX = 5;

/**
 * Which buckets the key reaches, in a band of its own: a list, unlike the
 * single values in the facts above, and beside the permissions it scopes. A
 * scope (every bucket, or whatever bucket policies grant) is one muted line.
 */
function BucketsSection({
  accessKey,
  linkBuckets,
}: {
  accessKey: AccessKey;
  linkBuckets: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  if (accessKey.type === 'principal') {
    return (
      <DrawerSection title="Buckets" testId="buckets">
        <p className="text-zinc-500">
          Per bucket policy: any bucket whose policy grants its owner access.
        </p>
      </DrawerSection>
    );
  }
  if (accessKey.bucketScope === 'all') {
    return (
      <DrawerSection title="Buckets" testId="buckets">
        <p className="text-zinc-500">All buckets in this region</p>
      </DrawerSection>
    );
  }

  const buckets = accessKey.buckets ?? [];
  const region = (accessKey.region ?? S3_REGION) as S3Region;
  const shown = showAll ? buckets : buckets.slice(0, BUCKETS_SHOWN_MAX);
  return (
    <DrawerSection
      title={
        <>
          Buckets <span className="text-zinc-400 tabular-nums">{buckets.length}</span>
        </>
      }
      testId="buckets"
    >
      {buckets.length === 0 ? (
        <p className="text-zinc-500">None</p>
      ) : (
        <ul data-testid="access-key-details-buckets" className="flex flex-col gap-1.5">
          {shown.map((bucket) => (
            <li key={bucket} className="break-all">
              {linkBuckets ? (
                <Link
                  to="/buckets/$bucketName"
                  params={{ bucketName: bucket }}
                  search={{ region }}
                  className="rounded-sm text-zinc-900 hover:text-brand-600 focus-visible:brand-outline"
                >
                  {bucket}
                </Link>
              ) : (
                <span className="text-zinc-900">{bucket}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {buckets.length > BUCKETS_SHOWN_MAX && (
        <button
          type="button"
          onClick={() => setShowAll((all) => !all)}
          className="mt-2 cursor-pointer rounded-sm text-xs text-zinc-500 hover:text-zinc-900 focus-visible:brand-outline"
        >
          {showAll ? 'Show fewer' : `Show all ${buckets.length}`}
        </button>
      )}
    </DrawerSection>
  );
}

function PermissionList({ children }: { children: React.ReactNode }) {
  return <ul className="flex flex-col gap-2.5">{children}</ul>;
}

function ServiceKeyPermissions({ accessKey }: { accessKey: ServiceAccessKey }) {
  // PERMISSION_OPTIONS' order, not the array's: the create form always
  // presents Read/Write/List/Delete in that fixed order, and a key stores
  // whatever order they were toggled in, which is not a fact worth showing.
  const permissions = accessKey.permissions ?? [];
  const objectPermissions = PERMISSION_OPTIONS.filter((o) => permissions.includes(o.value));
  const bucketManagement = permissions.filter(isBucketPermission);
  const bucketInfo = permissions.filter(isBucketInfoPermission);
  const granularPermissions = accessKey.granularPermissions ?? [];

  return (
    <>
      {objectPermissions.length > 0 && (
        <DrawerSection title="Object permissions" testId="object">
          <PermissionList>
            {objectPermissions.map((option) => (
              <PermissionRow
                key={option.value}
                label={option.label}
                extras={GRANULAR_PERMISSION_MAP[option.value].filter((g) =>
                  granularPermissions.includes(g),
                )}
              />
            ))}
          </PermissionList>
        </DrawerSection>
      )}

      {(bucketManagement.length > 0 || bucketInfo.length > 0) && (
        // Same section, same order as AccessKeyPermissionsFields: the
        // always-on fact first, then the bucket-info reads, then the
        // region-gated management writes. Two sections here would say
        // this is a different taxonomy from the one the key was built
        // with, and it isn't.
        <DrawerSection title="Bucket management" testId="bucket-management">
          <PermissionList>
            <PermissionRow label="List all buckets" />
            {bucketInfo.map((permission) => (
              <PermissionRow
                key={permission}
                label={BUCKET_INFO_PERMISSION_LABELS[permission].label}
              />
            ))}
            {bucketManagement.map((permission) => (
              <PermissionRow key={permission} label={BUCKET_PERMISSION_LABELS[permission].label} />
            ))}
          </PermissionList>
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
  title: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={`access-key-details-drawer-section-${testId}`}>
      <h3 className="mb-2 text-xs font-medium text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * One granted permission, with the extras it carries on a quieter line beneath.
 * Run together on one line, the two levels read as a single dense string and
 * wrapped raggedly. Only granted permissions are listed, so no check marks, and
 * the labels stand on their own without tooltips.
 */
function PermissionRow({ label, extras = [] }: { label: string; extras?: GranularPermission[] }) {
  return (
    <li>
      <p className="text-zinc-900">{label}</p>
      {extras.length > 0 && (
        // Each label is kept whole, so a long list wraps between permissions
        // rather than leaving the last word of one alone on a line.
        <p className="mt-0.5 text-xs text-zinc-500">
          {extras.map((extra, index) => (
            <Fragment key={extra}>
              {index > 0 && ', '}
              <span className="whitespace-nowrap">{GRANULAR_PERMISSION_LABELS[extra].label}</span>
            </Fragment>
          ))}
        </p>
      )}
    </li>
  );
}
