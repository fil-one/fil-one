import { useState } from 'react';

import type { S3ObjectVersion } from '@filone/shared';

import { getEntriesAtPrefix, groupVersionsByKey } from './object-grouping.js';
import { descendantSelectionIds, selectionId, type SelectableVersion } from './object-selection.js';
import {
  DEFAULT_OBJECT_SORT,
  searchEntriesUnderPrefix,
  shouldShowObjectControls,
  sortEntries,
  type ObjectSort,
} from './object-table.js';

/**
 * What the object table shows at `currentPrefix`: the open folder's entries, or
 * the search matches below it, in the chosen order. Holds the search and sort
 * state, which apply only once the bucket is large enough to show the controls.
 */
export function useObjectTableView(versions: S3ObjectVersion[], currentPrefix: string) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(DEFAULT_OBJECT_SORT);

  const groups = groupVersionsByKey(versions);
  const showControls = shouldShowObjectControls(groups.length);
  const searching = showControls && query.trim() !== '';
  const entries = sortEntries(
    searching
      ? searchEntriesUnderPrefix(groups, currentPrefix, query)
      : getEntriesAtPrefix(groups, currentPrefix),
    sort,
  );
  const latestVersions: SelectableVersion[] = groups.map((group) => ({
    key: group.key,
    versionId: group.latest.versionId,
  }));
  const idsAtPrefix = descendantSelectionIds(latestVersions, currentPrefix);
  // While searching, "select all" covers the matches only, so a bulk delete
  // never reaches objects the search hid. A search lists objects alone, never
  // folders, so every entry here is one object.
  const shownIds = searching
    ? entries.flatMap((entry) =>
        entry.kind === 'object' ? [selectionId(entry.group.key, entry.group.latest.versionId)] : [],
      )
    : idsAtPrefix;

  return {
    loadedCount: groups.length,
    entries,
    latestVersions,
    idsAtPrefix,
    shownIds,
    showControls,
    searching,
    query,
    setQuery,
    /** Absent below the controls threshold, which leaves the column heads inert. */
    sort: showControls ? { value: sort, onChange: (next: ObjectSort) => setSort(next) } : undefined,
  };
}
