import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { S3ObjectVersion } from '@filone/shared';

import { FolderRow, ObjectEntryRows, type RowActions } from './ObjectBrowserRows';
import { groupVersionsByKey } from '../lib/object-grouping.js';

function version(overrides: Partial<S3ObjectVersion>): S3ObjectVersion {
  return {
    key: 'any-object',
    versionId: 'any-version',
    isLatest: true,
    isDeleteMarker: false,
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function rowActions(overrides: Partial<RowActions> = {}): RowActions {
  return {
    downloading: null,
    onDownload: vi.fn(),
    canShare: true,
    onShare: vi.fn(),
    onRequestDelete: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
}

function inTable(rows: ReactNode) {
  return render(
    <table>
      <tbody>{rows}</tbody>
    </table>,
  );
}

function renderObject(latest: S3ObjectVersion, actions: RowActions) {
  const [group] = groupVersionsByKey([latest]);
  return inTable(
    <ObjectEntryRows
      name={latest.key}
      group={group!}
      isExpanded={false}
      versioningEnabled
      onToggleExpand={vi.fn()}
      actions={actions}
      selection={{ selectable: false, isSelected: () => false, onToggle: vi.fn() }}
    />,
  );
}

describe('ObjectEntryRows: a delete marker', () => {
  it('asks to remove the marker, naming it as a marker, from a button of its own', () => {
    const actions = rowActions();
    renderObject(version({ versionId: 'any-marker', isDeleteMarker: true }), actions);

    fireEvent.click(screen.getByRole('button', { name: 'Remove delete marker on any-object' }));

    expect(actions.onRequestDelete).toHaveBeenCalledWith({
      key: 'any-object',
      versionId: 'any-marker',
      isDeleteMarker: true,
    });
  });

  it('offers no menu, as a marker has nothing to download or share', () => {
    renderObject(version({ isDeleteMarker: true }), rowActions());

    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
  });

  it('offers nothing to a role that may not delete', () => {
    // No onRequestDelete: the role lacks objects.delete.
    renderObject(version({ isDeleteMarker: true }), rowActions({ onRequestDelete: undefined }));

    expect(screen.queryByRole('button', { name: /Remove delete marker/ })).not.toBeInTheDocument();
  });
});

describe('FolderRow', () => {
  function renderFolder(onPrefixChange = vi.fn()) {
    inTable(
      <FolderRow
        name="any-folder"
        prefix="any-folder/"
        onPrefixChange={onPrefixChange}
        selectable={false}
      />,
    );
    return onPrefixChange;
  }

  it('opens the folder from the button on its name', () => {
    const onPrefixChange = renderFolder();

    fireEvent.click(screen.getByRole('button', { name: 'Open folder any-folder' }));

    expect(onPrefixChange).toHaveBeenCalledWith('any-folder/');
  });

  // A row that is a button hides its cells from table navigation.
  it('keeps the row a row rather than a control', () => {
    renderFolder();

    expect(screen.getByTestId('folder-row')).toMatchObject({ tabIndex: -1 });
    expect(screen.getByTestId('folder-row')).not.toHaveAttribute('role');
  });
});

describe('ObjectEntryRows: controls in a row', () => {
  it('opens the object from the button on its name', () => {
    const actions = rowActions();
    renderObject(version({ key: 'any-object', versionId: 'any-version' }), actions);

    fireEvent.click(screen.getByRole('button', { name: 'any-object' }));

    expect(actions.onNavigate).toHaveBeenCalledWith('any-object', 'any-version');
  });

  it('downloads without also opening the object', () => {
    const actions = rowActions();
    renderObject(version({ key: 'any-object' }), actions);

    fireEvent.click(screen.getByRole('button', { name: 'Download any-object' }));

    expect(actions.onDownload).toHaveBeenCalledOnce();
    expect(actions.onNavigate).not.toHaveBeenCalled();
  });

  it('names the versions toggle for its object and says whether it is open', () => {
    const [group] = groupVersionsByKey([
      version({ key: 'any-object', versionId: 'v2', isLatest: true }),
      version({ key: 'any-object', versionId: 'v1', isLatest: false }),
    ]);
    inTable(
      <ObjectEntryRows
        name="any-object"
        group={group!}
        isExpanded={false}
        versioningEnabled
        onToggleExpand={vi.fn()}
        actions={rowActions()}
        selection={{ selectable: false, isSelected: () => false, onToggle: vi.fn() }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Older versions of any-object' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
