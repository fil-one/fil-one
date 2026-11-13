import { Fragment } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  CopySimpleIcon,
  DownloadSimpleIcon,
  LinkIcon,
  LinkSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { S3Region } from '@filone/shared';

import { Badge } from './Badge';
import { Breadcrumb } from './Breadcrumb';
import { Button } from './Button';
import { Heading } from './Heading/Heading';
import { IconButton } from './IconButton';
import { RowActionsMenu, type RowAction } from './RowActionsMenu';
import { useToast } from './Toast/index.js';
import { Tooltip } from './Tooltip';
import { getFolderPrefixes, getObjectFileName, shortenFileName } from '../lib/object-preview.js';
import type { VersionState } from '../lib/object-versions.js';
import { formatDate, formatDateTime } from '../lib/time.js';
import { SHARE_UNAVAILABLE_TOOLTIP } from '../lib/use-can-share-objects.js';

/**
 * A file name with a line-break opportunity after each `_`, `-` and `.`. Names
 * like `space_station_window_74ac044b-3881.png` have no spaces, so without these
 * the browser either overflows or splits them mid-chunk.
 */
function FileNameWithBreaks({ name }: { name: string }) {
  // The lookbehind splits after each separator and keeps it on the chunk before
  const chunks = name.split(/(?<=[_\-.])/);
  return (
    <>
      {chunks.map((chunk, index) => (
        // A chunk can repeat within a name, so its position is the only stable key
        <Fragment key={index}>
          {chunk}
          {index < chunks.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

export type ObjectDetailHeaderProps = {
  bucketName: string;
  region: S3Region;
  objectKey: string;
  versionState: VersionState;
  onBack: () => void;
  actions: React.ReactNode;
};

/**
 * The trail to the object, then the file name as the title. The full key used to
 * be both: truncated in the title, and repeated across two lines as the last
 * crumb. The name is what the user recognises, and the folders read better as
 * crumbs they can step back up, the way the bucket page's header works.
 */
export function ObjectDetailHeader({
  bucketName,
  region,
  objectKey,
  versionState,
  onBack,
  actions,
}: ObjectDetailHeaderProps) {
  const fileName = getObjectFileName(objectKey);
  const bucketHref = (prefix?: string) =>
    `/buckets/${bucketName}?${new URLSearchParams({ region, ...(prefix && { prefix }) }).toString()}`;
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb
        items={[
          { label: 'Buckets', href: '/buckets' },
          { label: bucketName, href: bucketHref() },
          ...getFolderPrefixes(objectKey).map(({ name, prefix }) => ({
            label: name,
            href: bucketHref(prefix),
          })),
          // Short here, whole in the title right below it
          { label: shortenFileName(fileName) },
        ]}
      />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        {/* As on the create bucket page, the arrow hangs in the margin on the
            title's line once the page has room beside it. Below that it is left
            out rather than given a row of its own: the crumbs above go back too. */}
        <div className="absolute top-0 right-full mr-4 hidden h-7 items-center xl:flex">
          <IconButton
            icon={ArrowLeftIcon}
            aria-label={objectKey.includes('/') ? 'Back to folder' : 'Back to bucket'}
            onClick={onBack}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {/* Two lines at most, with the whole name on hover. break-words only
              splits inside a chunk too long for a line. */}
          <Heading
            id="object-detail-heading"
            tag="h1"
            title={fileName}
            className="line-clamp-2 break-words"
          >
            <FileNameWithBreaks name={fileName} />
          </Heading>
          <VersionLine
            bucketName={bucketName}
            region={region}
            objectKey={objectKey}
            versionState={versionState}
          />
        </div>
        {actions}
      </div>
    </div>
  );
}

/**
 * Says, under the title, that the page shows an older version, and offers the
 * way back. Without it the header looked the same for every version, while
 * Download and Delete acted on the one in the URL. Nothing shows for the latest
 * version: that is the object itself, and the default needs no label.
 *
 * One short line: the badge, then the way back. The version's own date is not
 * repeated here: it is the Details card's Last modified, and highlighted in the
 * history. When the newest entry is a delete marker there is no latest to go to,
 * so the line says when the object was deleted instead.
 */
function VersionLine({
  bucketName,
  region,
  objectKey,
  versionState,
}: Omit<ObjectDetailHeaderProps, 'onBack' | 'actions'>) {
  const { isOlder, isDeleted, latest } = versionState;
  if (!isOlder) return null;
  return (
    <p
      data-testid="object-version-line"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500"
    >
      <Badge color="grey" size="sm">
        Older version
      </Badge>
      <span aria-hidden="true" className="text-zinc-300 select-none">
        ·
      </span>
      {isDeleted && latest ? (
        <span title={formatDateTime(latest.lastModified)}>
          Object deleted {formatDate(latest.lastModified)}
        </span>
      ) : (
        <Link
          to="/buckets/$bucketName/objects"
          params={{ bucketName }}
          search={{ key: objectKey, region }}
          className="rounded-md font-medium text-zinc-700 transition-colors duration-150 hover:text-zinc-950 focus-visible:brand-outline"
        >
          View latest version
        </Link>
      )}
    </p>
  );
}

export type ObjectHeaderActionsProps = {
  s3Uri: string;
  canShare: boolean;
  mayDelete: boolean;
  /** True when the URL names a version, so Delete removes that version alone. */
  isVersion: boolean;
  onDownload: () => void;
  onShare: () => void;
  onDelete: () => void;
};

/**
 * Download leads, since it is what most visits are for, with Share beside it.
 * The rest sit one step away: the two copies people reach for after a download,
 * then Delete, kept off the bar as in the access key drawer, where a red button
 * was the loudest thing on a panel that is mostly read.
 */
export function ObjectHeaderActions({
  s3Uri,
  canShare,
  mayDelete,
  isVersion,
  onDownload,
  onShare,
  onDelete,
}: ObjectHeaderActionsProps) {
  const { toast } = useToast();

  // The menu closes on select, so a toast is the only place left to confirm the copy
  async function copy(value: string, confirmation: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(confirmation);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      toast.error('Failed to copy to clipboard');
    }
  }

  const menuActions: RowAction[] = [
    {
      label: 'Copy S3 URI',
      icon: CopySimpleIcon,
      onSelect: () => void copy(s3Uri, 'S3 URI copied'),
      testId: 'object-copy-s3-uri',
    },
    {
      // "Console link", not "link": Share already makes a link, a public one,
      // and this one only opens for people signed in to this org
      label: 'Copy console link',
      icon: LinkSimpleIcon,
      onSelect: () => void copy(window.location.href, 'Console link copied'),
      testId: 'object-copy-console-link',
    },
  ];
  if (mayDelete) {
    menuActions.push({
      label: isVersion ? 'Delete version' : 'Delete',
      icon: TrashIcon,
      onSelect: onDelete,
      destructive: true,
      testId: 'object-delete-button',
    });
  }

  const shareButton = (
    <Button
      id="object-share-button"
      variant="ghost"
      size="sm"
      icon={LinkIcon}
      disabled={!canShare}
      onClick={onShare}
    >
      Share
    </Button>
  );
  return (
    <div className="flex shrink-0 items-center gap-2">
      {canShare ? (
        shareButton
      ) : (
        <Tooltip content={SHARE_UNAVAILABLE_TOOLTIP}>{shareButton}</Tooltip>
      )}
      <Button
        id="object-download-button"
        variant="ghost"
        size="sm"
        icon={DownloadSimpleIcon}
        onClick={onDownload}
      >
        Download
      </Button>
      <RowActionsMenu
        aria-label="More object actions"
        testId="object-actions-menu"
        actions={menuActions}
      />
    </div>
  );
}
