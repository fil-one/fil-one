import { useCallback, useEffect, useState } from 'react';

import type { S3ObjectVersion } from '@filone/shared';

import type { ObjectDeleteTarget } from './use-object-actions.js';

/** A stable empty default, so the prune effect does not rerun on every render. */
const NO_FOLDERS: string[] = [];

/** The identity of a selectable row: an object key plus the version it shows. */
export type SelectableVersion = { key: string; versionId: string };

/**
 * Stable id for a selected row. Version ids never contain a newline, so the
 * first one separates the two halves even when the object key does.
 */
export function selectionId(key: string, versionId: string): string {
  return `${versionId}\n${key}`;
}

const FOLDER_ID_MARK = '\0';

/**
 * Stable id for a selected folder row. It starts with a NUL character, which
 * no version id starts with, so it never collides with an object's id, even an
 * unversioned one (whose id starts with the newline).
 */
export function folderSelectionId(prefix: string): string {
  return `${FOLDER_ID_MARK}${prefix}`;
}

function isFolderSelectionId(id: string): boolean {
  return id.startsWith(FOLDER_ID_MARK);
}

export function parseSelectionId(id: string): ObjectDeleteTarget {
  const idx = id.indexOf('\n');
  const versionId = id.slice(0, idx);
  return { key: id.slice(idx + 1), ...(versionId && { versionId }) };
}

/** What a selection deletes: objects one by one, folders by their prefix. */
export interface SelectionTargets {
  objects: ObjectDeleteTarget[];
  /** Folder prefixes, each ending in '/'. */
  folderPrefixes: string[];
}

export type ObjectSelection = {
  selected: Set<string>;
  toggle: (id: string) => void;
  setMany: (ids: string[], shouldSelect: boolean) => void;
  clear: () => void;
  areAllSelected: (ids: string[]) => boolean;
  targets: () => SelectionTargets;
};

/**
 * Row selection over one listing page.
 *
 * @param versions The page's object versions.
 * @param folders The page's folder prefixes. Defaults to none.
 */
export function useObjectSelection(
  versions: S3ObjectVersion[],
  folders: string[] = NO_FOLDERS,
): ObjectSelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Drop selected ids that no longer exist (e.g. after a delete).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const existing = new Set([
        ...versions.map((v) => selectionId(v.key, v.versionId)),
        ...folders.map(folderSelectionId),
      ]);
      const next = new Set<string>();
      for (const id of prev) if (existing.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [versions, folders]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Select or clear several rows at once (the header checkbox). */
  const setMany = useCallback((ids: string[], shouldSelect: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (shouldSelect) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const areAllSelected = useCallback(
    (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id)),
    [selected],
  );

  const targets = useCallback((): SelectionTargets => {
    const ids = Array.from(selected);
    return {
      objects: ids.filter((id) => !isFolderSelectionId(id)).map(parseSelectionId),
      folderPrefixes: ids.filter(isFolderSelectionId).map((id) => id.slice(FOLDER_ID_MARK.length)),
    };
  }, [selected]);

  return { selected, toggle, setMany, clear, areAllSelected, targets };
}
