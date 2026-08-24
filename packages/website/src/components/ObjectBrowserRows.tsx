import { Fragment } from 'react';
import {
  CaretDownIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import { formatBytes } from '@filone/shared';
import type { S3ObjectVersion } from '@filone/shared';

import { IconButton } from './IconButton';
import { Spinner } from './Spinner';
import { Table } from './Table/Table';
import { VersionRowBadge, truncateVersionId } from './VersionHistoryCard';
import type { VersionGroup } from '../lib/object-grouping.js';
import { selectionId } from '../lib/object-selection.js';
import { formatDate } from '../lib/time.js';

/** Callbacks every object/version row needs, threaded down from the browser. */
export type RowActions = {
  downloading: string | null;
  onDownload: (key: string, versionId?: string) => void;
  onRequestDelete: (key: string, versionId: string) => void;
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
  const { downloading, onDownload, onRequestDelete } = actions;
  return (
    <div className="flex items-center justify-end gap-1">
      {!version.isDeleteMarker &&
        (downloading === groupKey ? (
          // Same footprint as the IconButton it replaces while the download runs.
          <span className="inline-flex items-center justify-center p-1.5 text-zinc-500">
            <Spinner ariaLabel="Downloading" size={18} />
          </span>
        ) : (
          <IconButton
            icon={DownloadSimpleIcon}
            aria-label={`Download ${label}`}
            size="md"
            onClick={() => onDownload(groupKey, version.versionId)}
          />
        ))}
      <IconButton
        icon={TrashIcon}
        aria-label={`Delete ${label}`}
        size="md"
        // Same IconButton as the others, but the hover keeps a danger cue since
        // this deletes directly (twMerge lets it win over the base zinc hover).
        className="hover:text-red-600"
        onClick={() => onRequestDelete(groupKey, version.versionId)}
      />
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
      <Table.Cell className="py-3 pr-4 pl-10">
        <div className="flex items-center gap-2 text-zinc-500">
          <FileIcon size={14} className="shrink-0 text-zinc-300" aria-hidden="true" />
          {displayName}
        </div>
      </Table.Cell>
      <Table.Cell className="font-mono text-xs text-zinc-500" title={version.versionId}>
        {truncateVersionId(version.versionId)}
      </Table.Cell>
      <Table.Cell>
        <VersionRowBadge version={version} />
      </Table.Cell>
      <Table.Cell className="text-zinc-500">
        {version.isDeleteMarker ? '\u2014' : formatBytes(version.sizeBytes)}
      </Table.Cell>
      <Table.Cell className="text-zinc-500">{formatDate(version.lastModified)}</Table.Cell>
      <Table.Cell onClick={(e) => e.stopPropagation()}>
        <VersionActions
          version={version}
          groupKey={groupKey}
          actions={actions}
          label={`version ${version.versionId}`}
        />
      </Table.Cell>
    </Table.Row>
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
      {name}
      {hasMultipleVersions && (
        <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
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
      <Table.Cell>
        <NameCell
          name={name}
          group={group}
          hasMultipleVersions={hasMultipleVersions}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
        />
      </Table.Cell>
      {versioningEnabled && (
        <>
          <Table.Cell className="font-mono text-xs text-zinc-500" title={group.latest.versionId}>
            {truncateVersionId(group.latest.versionId)}
          </Table.Cell>
          <Table.Cell>
            <VersionRowBadge version={{ ...group.latest, isLatest: true }} />
          </Table.Cell>
        </>
      )}
      <Table.Cell className="text-zinc-600">
        {group.latest.isDeleteMarker ? '\u2014' : formatBytes(group.latest.sizeBytes)}
      </Table.Cell>
      <Table.Cell className="text-zinc-600">{formatDate(group.latest.lastModified)}</Table.Cell>
      <Table.Cell onClick={(e) => e.stopPropagation()}>
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
  versioningEnabled,
  onPrefixChange,
  selectable,
  isSelected,
  onToggleSelect,
}: {
  name: string;
  prefix: string;
  versioningEnabled: boolean;
  onPrefixChange: (prefix: string) => void;
  selectable: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
}) {
  return (
    <Table.Row
      data-testid="folder-row"
      data-folder-prefix={prefix}
      selected={isSelected}
      className="cursor-pointer"
      onClick={() => onPrefixChange(prefix)}
    >
      {selectable && (
        <Table.SelectCell
          checked={isSelected}
          onChange={onToggleSelect}
          label={`Select everything in ${name}`}
        />
      )}
      <Table.Cell>
        <div className="flex items-center gap-2 font-medium text-zinc-900">
          <FolderIcon size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
          {name}
        </div>
      </Table.Cell>
      {versioningEnabled && (
        <>
          <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
          <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
        </>
      )}
      <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
      <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
      <Table.Cell />
    </Table.Row>
  );
}
