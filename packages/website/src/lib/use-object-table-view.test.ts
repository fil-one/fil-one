import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { S3ObjectVersion } from '@filone/shared';

import { DEFAULT_OBJECT_SORT, OBJECT_TABLE_CONTROLS_MIN } from './object-table.js';
import { useObjectTableView } from './use-object-table-view.js';

function objects(count: number): S3ObjectVersion[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `any-object-${i}.txt`,
    versionId: '',
    isLatest: true,
    isDeleteMarker: false,
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00.000Z',
  }));
}

function renderView(count: number) {
  return renderHook(({ versions }) => useObjectTableView(versions, ''), {
    initialProps: { versions: objects(count) },
  });
}

describe('useObjectTableView', () => {
  it('restores the default search and sort when the bucket drops below the controls threshold', () => {
    const { result, rerender } = renderView(OBJECT_TABLE_CONTROLS_MIN);
    act(() => {
      result.current.setQuery('any-object-1');
      result.current.sort?.onChange({ key: 'size', direction: 'desc' });
    });

    rerender({ versions: objects(OBJECT_TABLE_CONTROLS_MIN - 1) });
    rerender({ versions: objects(OBJECT_TABLE_CONTROLS_MIN) });

    expect(result.current).toMatchObject({
      searching: false,
      query: '',
      sort: { value: DEFAULT_OBJECT_SORT },
    });
  });

  it('keeps the search and sort while the bucket stays above the controls threshold', () => {
    const { result, rerender } = renderView(OBJECT_TABLE_CONTROLS_MIN);
    act(() => {
      result.current.setQuery('any-object-1');
      result.current.sort?.onChange({ key: 'size', direction: 'desc' });
    });

    rerender({ versions: objects(OBJECT_TABLE_CONTROLS_MIN + 1) });

    expect(result.current).toMatchObject({
      searching: true,
      query: 'any-object-1',
      sort: { value: { key: 'size', direction: 'desc' } },
    });
  });
});
