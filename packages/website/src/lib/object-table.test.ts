import { describe, it, expect } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import { getEntriesAtPrefix, groupVersionsByKey } from './object-grouping.js';
import {
  DEFAULT_OBJECT_SORT,
  OBJECT_TABLE_CONTROLS_MIN,
  nextObjectSort,
  searchEntriesUnderPrefix,
  shouldShowObjectControls,
  sortEntries,
} from './object-table.js';

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

function names(entries: { name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

describe('shouldShowObjectControls', () => {
  it.each([
    [false, OBJECT_TABLE_CONTROLS_MIN - 1],
    [true, OBJECT_TABLE_CONTROLS_MIN],
  ])('returns %s for a bucket of %i objects', (expected, count) => {
    expect(shouldShowObjectControls(count)).toBe(expected);
  });
});

describe('nextObjectSort', () => {
  it('starts a newly clicked column ascending', () => {
    expect(nextObjectSort({ key: 'name', direction: 'desc' }, 'size')).toStrictEqual({
      key: 'size',
      direction: 'asc',
    });
  });

  it('toggles the direction when the active column is clicked again', () => {
    expect(nextObjectSort({ key: 'size', direction: 'asc' }, 'size')).toStrictEqual({
      key: 'size',
      direction: 'desc',
    });
  });
});

describe('searchEntriesUnderPrefix', () => {
  const groups = groupVersionsByKey([
    version({ key: 'any-dir/Report.pdf' }),
    version({ key: 'any-dir/nested/report-draft.pdf' }),
    version({ key: 'any-dir/notes.txt' }),
    version({ key: 'other-dir/report.pdf' }),
  ]);

  it('matches objects in nested folders under the prefix, ignoring case', () => {
    expect(names(searchEntriesUnderPrefix(groups, 'any-dir/', 'REPORT'))).toStrictEqual([
      'Report.pdf',
      'nested/report-draft.pdf',
    ]);
  });

  it('matches the whole bucket from the root', () => {
    expect(names(searchEntriesUnderPrefix(groups, '', 'report.pdf'))).toStrictEqual([
      'any-dir/Report.pdf',
      'other-dir/report.pdf',
    ]);
  });

  it('matches against the path below the prefix, not the prefix itself', () => {
    expect(searchEntriesUnderPrefix(groups, 'any-dir/', 'any-dir')).toStrictEqual([]);
  });

  it('ignores whitespace around the query', () => {
    expect(names(searchEntriesUnderPrefix(groups, 'any-dir/', '  notes '))).toStrictEqual([
      'notes.txt',
    ]);
  });
});

describe('sortEntries', () => {
  const entries = getEntriesAtPrefix(
    groupVersionsByKey([
      version({ key: 'b-dir/x' }),
      version({ key: 'a-dir/x' }),
      version({ key: 'small', sizeBytes: 10, lastModified: '2026-03-01T00:00:00.000Z' }),
      version({ key: 'large', sizeBytes: 300, lastModified: '2026-01-01T00:00:00.000Z' }),
      version({ key: 'medium', sizeBytes: 200, lastModified: '2026-02-01T00:00:00.000Z' }),
    ]),
    '',
  );

  it('keeps the default name order of getEntriesAtPrefix', () => {
    expect(names(sortEntries(entries, DEFAULT_OBJECT_SORT))).toStrictEqual(names(entries));
  });

  it('reverses folders and objects alike, folders still first, for a descending name sort', () => {
    expect(names(sortEntries(entries, { key: 'name', direction: 'desc' }))).toStrictEqual([
      'b-dir',
      'a-dir',
      'small',
      'medium',
      'large',
    ]);
  });

  it.each([
    ['size', 'asc', ['small', 'medium', 'large']],
    ['size', 'desc', ['large', 'medium', 'small']],
    ['lastModified', 'asc', ['large', 'medium', 'small']],
    ['lastModified', 'desc', ['small', 'medium', 'large']],
  ] as const)(
    'orders objects by %s %s and leaves folders first in name order',
    (key, direction, objects) => {
      expect(names(sortEntries(entries, { key, direction }))).toStrictEqual([
        'a-dir',
        'b-dir',
        ...objects,
      ]);
    },
  );

  it('falls back to name order for objects of equal size', () => {
    // Reversed, so a stable sort that ignored names would keep 'any-b' first.
    const sameSize = getEntriesAtPrefix(
      groupVersionsByKey([version({ key: 'any-b' }), version({ key: 'any-a' })]),
      '',
    ).reverse();
    expect(names(sortEntries(sameSize, { key: 'size', direction: 'desc' }))).toStrictEqual([
      'any-a',
      'any-b',
    ]);
  });
});
