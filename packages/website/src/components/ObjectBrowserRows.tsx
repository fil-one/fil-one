import { Fragment } from 'react';
import {
  CaretDownIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  LinkIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import { formatBytes } from '@filone/shared';
import type { S3ObjectVersion } from '@filone/shared';

import { Badge } from './Badge';
import { IconButton } from './IconButton';
import { RowActionsMenu, type RowAction } from './RowActionsMenu';
import { Spinner } from './Spinner';
import { Table } from './Table/Table';
import type { VersionGroup } from '../lib/object-grouping.js';
import { folderSelectionId, selectionId } from '../lib/object-selection.js';
import { formatDate } from '../lib/time.js';

/**
 * Columns dropped below `sm`, header and rows alike. With them a phone scrolls
 * the table sideways and the row actions start off-screen; without them the row
 * is the name, a line of facts under it, and the actions. Same split as
 * `BucketsTable`.
 */
export const SECONDARY_COLUMN = 'hidden sm:table-cell';

/**
 * The name cell takes whatever width the other columns leave, and no more, so
 * a long key truncates instead of pushing the actions out of the row.
 */
const NAME_CELL = 'w-full max-w-0';

/**
 * Below `sm`, the facts the hidden columns carry, under the name: the size and
 * the date. A delete marker's date is when the object was deleted, so it reads
 * as one red fact rather than a pill beside a date.
 *
 * The line may still wrap on the narrowest phones; each separator travels with
 * the fact after it, so a wrap never leaves one hanging at a line's end.
 */
function MobileFacts({ version }: { version: S3ObjectVersion }) {
  const date = formatDate(version.lastModified);
  const facts = version.isDeleteMarker
    ? [<span className="font-medium text-red-600">Deleted {date}</span>]
    : [<span>{formatBytes(version.sizeBytes)}</span>, <span>{date}</span>];

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zinc-500 tabular-nums sm:hidden">
      {facts.map((fact, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">·</span>}
          {fact}
        </span>
      ))}
    </div>
  );
}

/** Callbacks every object/version row needs, threaded down from the browser. */
export type RowActions = {
  downloading: string | null;
  onDownload: (key: string, versionId?: string) => void;
  /** Whether the plan allows share links; when not, Share stays visible but disabled. */
  canShare: boolean;
  onShare: (key: string, versionId: string) => void;
  /** Absent for a role without `objects.delete` — the control is not rendered. */
  onRequestDelete?: (key: string, versionId: string) => void;
  onNavigate: (key: string, versionId: string) => void;
};

/** Selection wiring for a single row. `selectable` is false when bulk delete is off. */
export type RowSelection = {
  selectable: boolean;
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
};

// ---------------------------------------------------------------------------
// Row action buttons
// ---------------------------------------------------------------------------

/**
 * Download stays one click away, since it is what people come to a file for;
 * the rest sit in the row's menu. Delete in particular is kept out of reach of a
 * slip next to Download.
 */
function VersionActions({
  version,
  groupKey,
  actions,
  label,
}: {
  version: S3ObjectVersion;
  groupKey: string;
  actions: RowActions;
  label: string;
}) {
  const { downloading, onDownload, canShare, onShare, onRequestDelete } = actions;
  // A delete marker has no content, so nothing to download or link to.
  const menu: RowAction[] = [
    ...(version.isDeleteMarker
      ? []
      : [
          {
            // The label carries the reason while sharing is unavailable, as a
            // disabled menu item has no tooltip to explain itself.
            label: canShare ? 'Share link' : 'Share link (paid plans)',
            icon: LinkIcon,
            disabled: !canShare,
            onSelect: () => onShare(groupKey, version.versionId),
          },
        ]),
    ...(onRequestDelete
      ? [
          {
            label: 'Delete',
            icon: TrashIcon,
            destructive: true,
            onSelect: () => onRequestDelete(groupKey, version.versionId),
          },
        ]
      : []),
  ];

  return (
    <div className="flex items-center justify-end gap-1">
      {version.isDeleteMarker ? (
        // Holds Download's place so every row's menu lines up in one column.
        <span className="inline-flex p-1.5" aria-hidden="true">
          <span className="size-4.5" />
        </span>
      ) : downloading === groupKey ? (
        // Same footprint as the IconButton it replaces while the download runs.
        <span className="inline-flex items-center justify-center p-1.5 text-zinc-500">
          <Spinner ariaLabel="Downloading" size={18} />
        </span>
      ) : (
        <IconButton
          icon={DownloadSimpleIcon}
          aria-label={`Download ${label}`}
          tooltip="Download"
          tooltipSide="top"
          size="md"
          onClick={() => onDownload(groupKey, version.versionId)}
        />
      )}
      <RowActionsMenu actions={menu} aria-label={`Actions for ${label}`} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-row for expanded older versions
// ---------------------------------------------------------------------------

function VersionSubRow({
  version,
  groupKey,
  displayName,
  actions,
  selection,
}: {
  version: S3ObjectVersion;
  groupKey: string;
  displayName: string;
  actions: RowActions;
  selection: RowSelection;
}) {
  const id = selectionId(groupKey, version.versionId);
  const isSelected = selection.isSelected(id);

  return (
    <Table.Row
      data-testid="object-version-row"
      data-version-id={version.versionId}
      selected={isSelected}
      // Sub-rows sit on a tint of their own to read as nested. Applied only when
      // unselected so it never competes with the selected background.
      className={`cursor-pointer ${isSelected ? '' : 'bg-zinc-50/50 hover:bg-zinc-100/50'}`}
      role="button"
      tabIndex={0}
      onClick={() => actions.onNavigate(groupKey, version.versionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') actions.onNavigate(groupKey, version.versionId);
      }}
    >
      {selection.selectable && (
        <Table.SelectCell
          checked={isSelected}
          onChange={() => selection.onToggle(id)}
          label={`Select version ${version.versionId} of ${displayName}`}
        />
      )}
      <Table.Cell className={`py-3 pr-4 pl-10 ${NAME_CELL}`}>
        {/* Every older version shares the object's name, so the version id is
            what tells one from another; it is the only place the id appears. */}
        <div className="flex items-center gap-2 text-zinc-500" title={version.versionId}>
          <FileIcon size={14} className="shrink-0 text-zinc-300" aria-hidden="true" />
          <span className="truncate font-mono text-xs">{version.versionId}</span>
          {version.isDeleteMarker && <DeletedBadge />}
        </div>
        <MobileFacts version={version} />
      </Table.Cell>
      <Table.Cell className={`text-xs text-zinc-500 tabular-nums ${SECONDARY_COLUMN}`}>
        {!version.isDeleteMarker && formatBytes(version.sizeBytes)}
      </Table.Cell>
      <Table.Cell className={`text-xs text-zinc-500 tabular-nums ${SECONDARY_COLUMN}`}>
        {formatDate(version.lastModified)}
      </Table.Cell>
      {/* Narrower padding below `sm`, where every pixel goes to the name. */}
      <Table.Cell className="px-2 sm:px-4" onClick={(e) => e.stopPropagation()}>
        <VersionActions
          version={version}
          groupKey={groupKey}
          actions={actions}
          label={`version ${version.versionId} of ${displayName}`}
        />
      </Table.Cell>
    </Table.Row>
  );
}

/**
 * Marks a version that is a delete marker. Hidden below `sm`, where the facts
 * line under the name already reads "Deleted" with the date.
 */
function DeletedBadge() {
  return (
    <span className="hidden shrink-0 sm:inline-flex">
      <Badge color="red" size="sm">
        Deleted
      </Badge>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Latest version row (primary row for each object key)
// ---------------------------------------------------------------------------

function NameCell({
  name,
  group,
  hasMultipleVersions,
  isExpanded,
  onToggleExpand,
}: {
  name: string;
  group: VersionGroup;
  hasMultipleVersions: boolean;
  isExpanded: boolean;
  onToggleExpand: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 font-medium text-zinc-900" title={group.key}>
      {hasMultipleVersions ? (
        <button
          type="button"
          className="shrink-0 text-zinc-400 hover:text-zinc-700"
          aria-label={isExpanded ? 'Collapse versions' : 'Expand versions'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(group.key);
          }}
        >
          {isExpanded ? (
            <CaretDownIcon size={14} aria-hidden="true" />
          ) : (
            <CaretRightIcon size={14} aria-hidden="true" />
          )}
        </button>
      ) : (
        <FileIcon size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
      )}
      <span className="truncate">{name}</span>
      {/* Status is shown only when it is the exception: every row is an
          object's latest version, so "Latest" on each would say nothing. */}
      {group.latest.isDeleteMarker && <DeletedBadge />}
      {hasMultipleVersions && (
        // Below `sm` the expand caret alone says there is history, so the
        // name keeps the room.
        <span className="ml-1 hidden shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-meta font-medium text-zinc-600 sm:inline">
          {group.versionCount} versions
        </span>
      )}
    </div>
  );
}

function LatestVersionRow({
  name,
  group,
  isExpanded,
  versioningEnabled,
  onToggleExpand,
  actions,
  selection,
}: {
  name: string;
  group: VersionGroup;
  isExpanded: boolean;
  versioningEnabled: boolean;
  onToggleExpand: (key: string) => void;
  actions: RowActions;
  selection: RowSelection;
}) {
  const hasMultipleVersions = versioningEnabled && group.versionCount > 1;
  const id = selectionId(group.key, group.latest.versionId);
  const isSelected = selection.isSelected(id);

  return (
    <Table.Row
      data-testid="object-row"
      data-object-key={group.key}
      selected={isSelected}
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={() => actions.onNavigate(group.key, group.latest.versionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ')
          actions.onNavigate(group.key, group.latest.versionId);
      }}
    >
      {selection.selectable && (
        <Table.SelectCell
          checked={isSelected}
          onChange={() => selection.onToggle(id)}
          label={`Select ${name}`}
        />
      )}
      <Table.Cell className={NAME_CELL}>
        <NameCell
          name={name}
          group={group}
          hasMultipleVersions={hasMultipleVersions}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
        />
        <MobileFacts version={group.latest} />
      </Table.Cell>
      {/* text-xs like the secondary cells of the other console tables (the
          buckets table's region and created date); the name alone is text-sm. */}
      <Table.Cell className={`text-xs text-zinc-600 tabular-nums ${SECONDARY_COLUMN}`}>
        {!group.latest.isDeleteMarker && formatBytes(group.latest.sizeBytes)}
      </Table.Cell>
      <Table.Cell className={`text-xs text-zinc-600 tabular-nums ${SECONDARY_COLUMN}`}>
        {formatDate(group.latest.lastModified)}
      </Table.Cell>
      {/* Narrower padding below `sm`, where every pixel goes to the name. */}
      <Table.Cell className="px-2 sm:px-4" onClick={(e) => e.stopPropagation()}>
        <VersionActions
          version={group.latest}
          groupKey={group.key}
          actions={actions}
          label={name}
        />
      </Table.Cell>
    </Table.Row>
  );
}

/** One object: its latest version, plus older versions when expanded. */
export function ObjectEntryRows({
  name,
  group,
  isExpanded,
  versioningEnabled,
  onToggleExpand,
  actions,
  selection,
}: {
  name: string;
  group: VersionGroup;
  isExpanded: boolean;
  versioningEnabled: boolean;
  onToggleExpand: (key: string) => void;
  actions: RowActions;
  selection: RowSelection;
}) {
  return (
    <Fragment>
      <LatestVersionRow
        name={name}
        group={group}
        isExpanded={isExpanded}
        versioningEnabled={versioningEnabled}
        onToggleExpand={onToggleExpand}
        actions={actions}
        selection={selection}
      />
      {isExpanded &&
        group.versions
          .filter((v) => v !== group.latest)
          .map((version) => (
            <VersionSubRow
              key={`version:${group.key}:${version.versionId}`}
              version={version}
              groupKey={group.key}
              displayName={name}
              actions={actions}
              selection={selection}
            />
          ))}
    </Fragment>
  );
}

// ---------------------------------------------------------------------------
// Folder row
// ---------------------------------------------------------------------------

export function FolderRow({
  name,
  prefix,
  onPrefixChange,
  selection,
}: {
  name: string;
  prefix: string;
  onPrefixChange: (prefix: string) => void;
  selection: RowSelection;
}) {
  const id = folderSelectionId(prefix);
  const isSelected = selection.isSelected(id);

  return (
    <Table.Row
      data-testid="folder-row"
      data-folder-prefix={prefix}
      selected={isSelected}
      className="group cursor-pointer"
      onClick={() => onPrefixChange(prefix)}
    >
      {/* Selecting a folder selects everything inside it, which the server
          deletes by prefix: the browser holds only one page of one folder. */}
      {selection.selectable && (
        <Table.SelectCell
          checked={isSelected}
          onChange={() => selection.onToggle(id)}
          label={`Select folder ${name}`}
        />
      )}
      <Table.Cell className={NAME_CELL}>
        <div className="flex items-center gap-2 font-medium text-zinc-900" title={name}>
          <FolderIcon size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
          <span className="truncate">{name}</span>
        </div>
      </Table.Cell>
      {/* Blank rather than a dash: size and date are not unknown for a
          folder, they do not apply to one. */}
      <Table.Cell className={SECONDARY_COLUMN} />
      <Table.Cell className={SECONDARY_COLUMN} />
      <Table.Cell className="px-2 sm:px-4">
        {/* Says the row opens rather than acts, and takes an action button's
            footprint so a folder row stands as tall as an object row. */}
        <div className="flex justify-end">
          <span className="inline-flex items-center justify-center p-1.5 text-zinc-400 transition-colors duration-150 group-hover:text-zinc-600">
            <CaretRightIcon size={18} aria-hidden="true" />
          </span>
        </div>
      </Table.Cell>
    </Table.Row>
  );
}
