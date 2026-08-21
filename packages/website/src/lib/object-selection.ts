import { useCallback, useEffect, useState } from 'react';

import type { S3ObjectVersion } from '@filone/shared';

import type { ObjectDeleteTarget } from './use-object-actions.js';

/** The identity of a selectable row: an object key plus the version it shows. */
export type SelectableVersion = { key: string; versionId: string };

/**
 * Stable id for a selected row. Version ids never contain a newline, so the
 * first one separates the two halves even when the object key does.
 */
export function selectionId(key: string, versionId: string): string {
  return `${versionId}\n${key}`;
}

export function parseSelectionId(id: string): ObjectDeleteTarget {
  const idx = id.indexOf('\n');
  const versionId = id.slice(0, idx);
  return { key: id.slice(idx + 1), ...(versionId && { versionId }) };
}

/**
 * Selection ids for every object under a prefix, including objects nested in
 * sub-folders. Backs the header "select all" checkbox and folder rows, which
 * both stand in for their whole subtree.
 */
export function descendantSelectionIds(latest: SelectableVersion[], prefix: string): string[] {
  return latest
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => selectionId(entry.key, entry.versionId));
}

export type ObjectSelection = {
  selected: Set<string>;
  toggle: (id: string) => void;
  setMany: (ids: string[], shouldSelect: boolean) => void;
  clear: () => void;
  areAllSelected: (ids: string[]) => boolean;
  targets: () => ObjectDeleteTarget[];
};

export function useObjectSelection(versions: S3ObjectVersion[]): ObjectSelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Drop selected ids that no longer exist (e.g. after a delete).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const existing = new Set(versions.map((v) => selectionId(v.key, v.versionId)));
      const next = new Set<string>();
      for (const id of prev) if (existing.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [versions]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Select or clear a whole subtree at once (header and folder rows). */
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

  const targets = useCallback(
    (): ObjectDeleteTarget[] => Array.from(selected, (id) => parseSelectionId(id)),
    [selected],
  );

  return { selected, toggle, setMany, clear, areAllSelected, targets };
}
