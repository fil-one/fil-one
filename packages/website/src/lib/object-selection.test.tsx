import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { S3ObjectVersion } from '@filone/shared';

import {
  folderSelectionId,
  parseSelectionId,
  selectionId,
  useObjectSelection,
} from './object-selection.js';

function version(
  overrides: Partial<S3ObjectVersion> & Pick<S3ObjectVersion, 'key'>,
): S3ObjectVersion {
  return {
    versionId: '',
    isLatest: true,
    isDeleteMarker: false,
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectionId / parseSelectionId', () => {
  it('round-trips a key with no version id', () => {
    expect(parseSelectionId(selectionId('a.txt', ''))).toEqual({ key: 'a.txt' });
  });

  it('round-trips a key with a version id', () => {
    expect(parseSelectionId(selectionId('a.txt', 'v1'))).toEqual({ key: 'a.txt', versionId: 'v1' });
  });

  it('round-trips a key containing a newline', () => {
    const key = 'weird\nname.txt';
    expect(parseSelectionId(selectionId(key, 'v1'))).toEqual({ key, versionId: 'v1' });
  });
});

describe('useObjectSelection', () => {
  const versions = [version({ key: 'a.txt' }), version({ key: 'b.txt' })];
  const idA = selectionId('a.txt', '');
  const idB = selectionId('b.txt', '');

  it('toggles a single id on and off', () => {
    const { result } = renderHook(() => useObjectSelection(versions));

    act(() => result.current.toggle(idA));
    expect(result.current.selected.has(idA)).toBe(true);

    act(() => result.current.toggle(idA));
    expect(result.current.selected.has(idA)).toBe(false);
  });

  it('selects and clears many ids at once', () => {
    const { result } = renderHook(() => useObjectSelection(versions));

    act(() => result.current.setMany([idA, idB], true));
    expect(result.current.areAllSelected([idA, idB])).toBe(true);

    act(() => result.current.setMany([idA], false));
    expect(result.current.selected).toEqual(new Set([idB]));
  });

  it('reports an empty id list as not all selected', () => {
    const { result } = renderHook(() => useObjectSelection(versions));
    expect(result.current.areAllSelected([])).toBe(false);
  });

  it('converts the selection into delete targets', () => {
    const { result } = renderHook(() => useObjectSelection(versions));
    act(() => result.current.toggle(selectionId('a.txt', 'v1')));
    expect(result.current.targets()).toStrictEqual({
      objects: [{ key: 'a.txt', versionId: 'v1' }],
      folderPrefixes: [],
    });
  });

  it('returns selected folders as prefixes, apart from the objects', () => {
    const { result } = renderHook(() => useObjectSelection(versions, ['any-folder/']));
    act(() => result.current.setMany([idA, folderSelectionId('any-folder/')], true));
    expect(result.current.targets()).toStrictEqual({
      objects: [{ key: 'a.txt' }],
      folderPrefixes: ['any-folder/'],
    });
  });

  // An unversioned object's id starts with the separator, so a folder id built
  // the same way could read as an object whose key starts with the prefix.
  it('keeps a folder apart from an unversioned object whose key is the same text', () => {
    const { result } = renderHook(() =>
      useObjectSelection([version({ key: 'any-name/' })], ['any-name/']),
    );
    act(() => result.current.toggle(folderSelectionId('any-name/')));
    expect(result.current.targets()).toStrictEqual({
      objects: [],
      folderPrefixes: ['any-name/'],
    });
  });

  it('drops folders that are no longer listed', () => {
    const { result, rerender } = renderHook(
      ({ folders }) => useObjectSelection(versions, folders),
      { initialProps: { folders: ['any-folder/', 'other-folder/'] } },
    );

    act(() =>
      result.current.setMany(
        [folderSelectionId('any-folder/'), folderSelectionId('other-folder/')],
        true,
      ),
    );
    rerender({ folders: ['other-folder/'] });

    expect(result.current.selected).toEqual(new Set([folderSelectionId('other-folder/')]));
  });

  it('drops ids for objects that no longer exist', () => {
    const { result, rerender } = renderHook(({ list }) => useObjectSelection(list), {
      initialProps: { list: versions },
    });

    act(() => result.current.setMany([idA, idB], true));
    rerender({ list: [version({ key: 'b.txt' })] });

    expect(result.current.selected).toEqual(new Set([idB]));
  });

  it('clears the whole selection', () => {
    const { result } = renderHook(() => useObjectSelection(versions));
    act(() => result.current.setMany([idA, idB], true));
    act(() => result.current.clear());
    expect(result.current.selected.size).toBe(0);
  });
});
