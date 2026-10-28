// Object-table search and sort. Unlike the buckets table, these run in the
// browser: the listing is already loaded whole (one S3 page), and S3 itself
// lists only in key order and matches only by prefix.

import type { SortDirection } from '@filone/shared';

import type { BrowseEntry, VersionGroup } from './object-grouping.js';

/**
 * Object count at which the browser starts showing its search and sort
 * controls. Counted across the whole bucket rather than the open folder, so the
 * controls do not appear and disappear while browsing between folders.
 */
export const OBJECT_TABLE_CONTROLS_MIN = 5;

/** True when a bucket holds enough objects to be worth searching and sorting. */
export function shouldShowObjectControls(objectCount: number): boolean {
  return objectCount >= OBJECT_TABLE_CONTROLS_MIN;
}

export type ObjectSortKey = 'name' | 'size' | 'lastModified';

export type ObjectSort = {
  key: ObjectSortKey;
  direction: SortDirection;
};

/** Matches the order `getEntriesAtPrefix` already returns, so the initial render is stable. */
export const DEFAULT_OBJECT_SORT: ObjectSort = { key: 'name', direction: 'asc' };

/**
 * Sort state after clicking `key`: a new column starts ascending, and clicking
 * the active column toggles direction.
 */
export function nextObjectSort(current: ObjectSort, key: ObjectSortKey): ObjectSort {
  if (current.key !== key) return { key, direction: 'asc' };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

/**
 * Objects anywhere under `prefix` whose path below it contains `query`, ignoring
 * case. Each entry is named by that path, so a match in a sub-folder reads as
 * `photos/cat.jpg` and is told apart from a `cat.jpg` beside it. Folders are
 * left out: a search answers "where is this object", and the path already says.
 */
export function searchEntriesUnderPrefix(
  groups: VersionGroup[],
  prefix: string,
  query: string,
): BrowseEntry[] {
  const needle = query.trim().toLowerCase();
  const entries: BrowseEntry[] = [];
  for (const group of groups) {
    if (!group.key.startsWith(prefix)) continue;
    const path = group.key.slice(prefix.length);
    if (path.toLowerCase().includes(needle)) entries.push({ kind: 'object', name: path, group });
  }
  return entries;
}

function compareNames(a: BrowseEntry, b: BrowseEntry): number {
  return a.name.localeCompare(b.name);
}

function compareObjects(
  a: VersionGroup,
  b: VersionGroup,
  key: Exclude<ObjectSortKey, 'name'>,
): number {
  if (key === 'size') return a.latest.sizeBytes - b.latest.sizeBytes;
  return Date.parse(a.latest.lastModified) - Date.parse(b.latest.lastModified);
}

/**
 * Entries in `sort` order, folders always ahead of objects. Folders carry no size
 * or date of their own, so a size or date sort leaves them in name order and
 * orders only the objects. Equal sizes or dates fall back to name order, so the
 * rows do not shuffle between renders.
 */
export function sortEntries(entries: BrowseEntry[], sort: ObjectSort): BrowseEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const folders = entries.filter((entry) => entry.kind === 'folder');
  const objects = entries.filter((entry) => entry.kind === 'object');

  folders.sort((a, b) => (sort.key === 'name' ? sign : 1) * compareNames(a, b));
  objects.sort((a, b) => {
    if (sort.key === 'name') return sign * compareNames(a, b);
    return sign * compareObjects(a.group, b.group, sort.key) || compareNames(a, b);
  });

  return [...folders, ...objects];
}
