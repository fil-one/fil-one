import { Fragment, useState } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { Link } from '@tanstack/react-router';
import {
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CaretUpIcon,
  DownloadSimpleIcon,
  ExportIcon,
  LinkIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Alert } from './Alert';
import { Badge } from './Badge';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { IconButton } from './IconButton';
import { ObjectFacts } from './ObjectDetailsCard';
import { ObjectPreviewCard } from './ObjectPreview';
import { ShareObjectModal } from './ShareObjectModal';
import { useToast } from './Toast/index.js';
import { Tooltip } from './Tooltip';
import { getDeleteCopy, getListedMetadata, useObjectMetadata } from '../lib/object-metadata.js';
import { getObjectFileName } from '../lib/object-preview.js';
import { SHARE_UNAVAILABLE_TOOLTIP, useCanShareObjects } from '../lib/use-can-share-objects.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { usePermittedDialog } from '../lib/use-permitted-dialog.js';

/** The objects before and after this one in the list, for stepping without closing. */
export type ObjectDrawerSiblings = {
  /** 1-based, as the header shows it. */
  position: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
};

export type ObjectDetailsDrawerProps = {
  bucketName: string;
  region: S3Region;
  objectKey: string;
  /** Set for an older version; absent for the object itself, its latest version. */
  versionId?: string;
  /** The object's row in the bucket listing, shown at once while its own details load. */
  listed?: S3ObjectVersion;
  versioningEnabled: boolean;
  objectLockEnabled: boolean;
  siblings?: ObjectDrawerSiblings;
  onDownload: () => void;
  onDelete: () => Promise<void>;
  onClose: () => void;
};

/**
 * A quick look at one object without leaving the bucket: its preview, its facts
 * and the actions people open an object for. Expand opens the object page, which
 * adds what needs room (version history, the API access details).
 *
 * Built like the access key details panel, on Headless UI's `Dialog`, so focus
 * moves in when it opens, Escape and the backdrop close it, and focus goes back
 * to the row that opened it.
 */
export function ObjectDetailsDrawer(props: ObjectDetailsDrawerProps) {
  // Mounted open; closing plays the slide-out, then tells the page to drop it.
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);

  return (
    <Transition show={open} appear as={Fragment} afterLeave={props.onClose}>
      <Dialog data-testid="object-details-drawer" className="relative z-40" onClose={close}>
        <TransitionChild
          as={Fragment}
          enter="transition-opacity duration-200 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity duration-200 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <DialogBackdrop className="fixed inset-0 bg-black/40" />
        </TransitionChild>
        {/* Wider than the access key panel, so an image preview has room to read */}
        <div className="fixed inset-y-0 right-0 flex w-full sm:w-120">
          <TransitionChild
            as={Fragment}
            enter="transition-transform duration-200 ease-out"
            enterFrom="translate-x-full"
            leave="transition-transform duration-200 ease-in"
            leaveTo="translate-x-full"
          >
            <DialogPanel
              data-testid="object-details-drawer-panel"
              className="flex w-full flex-col bg-white shadow-xl"
              onKeyDown={(e) => handleStepKey(e, props.siblings)}
            >
              <DrawerContent {...props} onClose={close} />
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}

// Where an arrow key or j/k already means something: moving a caret, scrolling a
// text preview, seeking a player. Stepping to another object there would take
// that key away.
const KEYS_KEPT_BY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'PRE', 'VIDEO', 'AUDIO']);
const PREVIOUS_KEYS = new Set(['ArrowUp', 'k']);
const NEXT_KEYS = new Set(['ArrowDown', 'j']);

/** Up and down (or k and j, as in Linear) step to the neighbouring object. */
function handleStepKey(e: React.KeyboardEvent, siblings?: ObjectDrawerSiblings) {
  if (!siblings || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const { target } = e;
  if (
    target instanceof HTMLElement &&
    (KEYS_KEPT_BY_TAGS.has(target.tagName) || target.isContentEditable)
  ) {
    return;
  }
  const step = PREVIOUS_KEYS.has(e.key)
    ? siblings.onPrevious
    : NEXT_KEYS.has(e.key)
      ? siblings.onNext
      : undefined;
  if (!step) return;
  e.preventDefault();
  step();
}

function DrawerContent({
  bucketName,
  region,
  objectKey,
  versionId,
  listed,
  versioningEnabled,
  objectLockEnabled,
  siblings,
  onDownload,
  onDelete,
  onClose,
}: ObjectDetailsDrawerProps) {
  const metadataQuery = useObjectMetadata({ bucketName, region, objectKey, versionId });
  const metadata = metadataQuery.data ?? (listed && getListedMetadata(listed));
  const mayDelete = useHasPermission('objects.delete');
  const canShare = useCanShareObjects();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = usePermittedDialog(false, mayDelete);
  const [shareOpen, setShareOpen] = useState(false);

  const pageSearch = { key: objectKey, region, ...(versionId && { versionId }) };
  const pageHref = `/buckets/${encodeURIComponent(bucketName)}/objects?${new URLSearchParams(pageSearch).toString()}`;

  return (
    <>
      <DrawerHeader
        bucketName={bucketName}
        objectKey={objectKey}
        isOlderVersion={Boolean(versionId)}
        pageSearch={pageSearch}
        siblings={siblings}
        onClose={onClose}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 px-5 py-5 text-ui">
          {metadataQuery.isError && (
            <Alert
              variant="red"
              description={metadataQuery.error.message || 'Failed to load object details'}
            />
          )}
          {metadata && (
            <>
              <ObjectPreviewCard
                bucketName={bucketName}
                region={region}
                objectKey={objectKey}
                versionId={versionId}
                etag={metadata.etag}
                sizeBytes={metadata.sizeBytes}
                contentType={metadata.contentType}
                onDownload={onDownload}
              />
              <ObjectFacts
                metadata={metadata}
                versionId={versionId ?? (versioningEnabled ? listed?.versionId : undefined)}
                objectLockEnabled={objectLockEnabled}
                s3Uri={`s3://${bucketName}/${objectKey}`}
                pending={!metadataQuery.data}
              />
            </>
          )}
        </div>
      </div>
      {/* Pinned under the scrolling body, so Download stays in reach however far
          down the facts the user is, and within thumb reach on a phone. Quiet,
          with no primary button: unlike a modal's footer it submits nothing. */}
      <div
        data-testid="object-details-drawer-actions"
        className="flex flex-shrink-0 items-center border-t border-zinc-100 px-5 py-3"
      >
        <ObjectDrawerActions
          consoleLink={new URL(pageHref, window.location.origin).toString()}
          isVersion={Boolean(versionId)}
          canShare={canShare}
          mayDelete={mayDelete}
          onDownload={onDownload}
          onShare={() => setShareOpen(true)}
          onDelete={() => setConfirmDeleteOpen(true)}
        />
      </div>

      <ShareObjectModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        bucketName={bucketName}
        region={region}
        objectKey={objectKey}
        versionId={versionId}
      />
      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={onDelete}
        {...getDeleteCopy(versionId, versioningEnabled)}
      />
    </>
  );
}

function DrawerHeader({
  bucketName,
  objectKey,
  isOlderVersion,
  pageSearch,
  siblings,
  onClose,
}: {
  bucketName: string;
  objectKey: string;
  isOlderVersion: boolean;
  pageSearch: { key: string; region: S3Region; versionId?: string };
  siblings?: ObjectDrawerSiblings;
  onClose: () => void;
}) {
  const fileName = getObjectFileName(objectKey);
  const folder = objectKey.slice(0, objectKey.length - fileName.length);
  return (
    <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
      {/* min-w-0 so a long name wraps inside the header rather than pushing the
          buttons off the panel */}
      <div className="flex min-w-0 flex-col gap-1">
        <DialogTitle
          className="line-clamp-2 text-base font-medium break-words text-zinc-900"
          title={fileName}
        >
          {fileName}
        </DialogTitle>
        {(folder || isOlderVersion) && (
          <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
            {isOlderVersion && (
              <Badge color="grey" size="sm">
                Older version
              </Badge>
            )}
            {folder && (
              <span className="truncate font-mono" title={folder}>
                {folder}
              </span>
            )}
          </div>
        )}
      </div>
      {/* The 30px buttons centre on the title's 24px first line, 3px over it
          each side, so they set neither the header's height nor its top edge */}
      <div className="-my-0.75 flex shrink-0 items-center gap-1">
        {siblings && <SiblingSteps siblings={siblings} />}
        <Tooltip content="Open full page" side="bottom">
          <Link
            to="/buckets/$bucketName/objects"
            params={{ bucketName }}
            search={pageSearch}
            data-testid="object-details-drawer-expand"
            aria-label="Open full page"
            className="block rounded-md p-1.5 text-zinc-500 transition-colors duration-150 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:brand-outline"
          >
            <ArrowsOutSimpleIcon size={18} aria-hidden="true" />
          </Link>
        </Tooltip>
        <IconButton
          icon={XIcon}
          data-testid="object-details-drawer-close"
          aria-label="Close"
          className="focus-visible:brand-outline"
          onClick={onClose}
        />
      </div>
    </div>
  );
}

function SiblingSteps({ siblings }: { siblings: ObjectDrawerSiblings }) {
  return (
    <div className="mr-1 flex items-center gap-1 border-r border-zinc-100 pr-2">
      {/* Where this object sits in the folder, as Linear's issue view counts its list */}
      <span
        data-testid="object-details-drawer-position"
        className="mr-1 hidden text-xs text-zinc-500 tabular-nums sm:inline"
      >
        {siblings.position} / {siblings.total}
      </span>
      <IconButton
        icon={CaretUpIcon}
        data-testid="object-details-drawer-previous"
        aria-label="Previous object"
        tooltip="Previous object"
        tooltipSide="bottom"
        className="focus-visible:brand-outline"
        disabled={!siblings.onPrevious}
        onClick={siblings.onPrevious}
      />
      <IconButton
        icon={CaretDownIcon}
        data-testid="object-details-drawer-next"
        aria-label="Next object"
        tooltip="Next object"
        tooltipSide="bottom"
        className="focus-visible:brand-outline"
        disabled={!siblings.onNext}
        onClick={siblings.onNext}
      />
    </div>
  );
}

/**
 * Every action on show, with room to spare in the panel. Download, the reason
 * most people open a file, ends the row on the right with Share beside it. The
 * icon-only actions sit at the other end, Delete grey until hovered, so it is
 * never the button next to the one being reached for. The object page keeps its
 * ⋯ menu, where the header has less room.
 */
function ObjectDrawerActions({
  consoleLink,
  isVersion,
  canShare,
  mayDelete,
  onDownload,
  onShare,
  onDelete,
}: {
  consoleLink: string;
  /** True for an older version, so Delete names what it removes. */
  isVersion: boolean;
  canShare: boolean;
  mayDelete: boolean;
  onDownload: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const { toast } = useToast();
  async function copyConsoleLink() {
    try {
      await navigator.clipboard.writeText(consoleLink);
      toast.success('Console link copied');
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      toast.error('Failed to copy to clipboard');
    }
  }

  const shareButton = (
    <Button variant="ghost" size="sm" icon={ExportIcon} disabled={!canShare} onClick={onShare}>
      Share
    </Button>
  );
  const deleteLabel = isVersion ? 'Delete version' : 'Delete object';
  return (
    <div className="flex w-full items-center gap-2">
      {mayDelete && (
        <IconButton
          icon={TrashIcon}
          data-testid="object-details-drawer-delete"
          aria-label={deleteLabel}
          tooltip={deleteLabel}
          className="hover:bg-red-50 hover:text-red-600 focus-visible:brand-outline"
          onClick={onDelete}
        />
      )}
      <IconButton
        icon={LinkIcon}
        data-testid="object-details-drawer-copy-link"
        aria-label="Copy console link"
        tooltip="Copy console link"
        className="focus-visible:brand-outline"
        onClick={() => void copyConsoleLink()}
      />
      <div className="ml-auto flex items-center gap-2">
        {canShare ? (
          shareButton
        ) : (
          <Tooltip content={SHARE_UNAVAILABLE_TOOLTIP}>{shareButton}</Tooltip>
        )}
        <Button variant="primary" size="sm" icon={DownloadSimpleIcon} onClick={onDownload}>
          Download
        </Button>
      </div>
    </div>
  );
}
