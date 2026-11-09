import { describe, it, expect } from 'vitest';

import {
  buildLancePythonSnippet,
  lanceDatabaseUri,
  formatCitationScore,
  formatDuration,
  formatIndexType,
  formatIo,
  getSearchableVersions,
  isEngineStatus,
  objectBasename,
  parseCitedAnswer,
  syncPercent,
  syncProgressLabel,
} from './rag-engine.js';

describe('parseCitedAnswer', () => {
  it('splits single markers into citation segments', () => {
    expect(parseCitedAnswer('Kept 35 days [1]. Restorable [2].', [1, 2])).toEqual([
      { kind: 'text', text: 'Kept 35 days ' },
      { kind: 'cite', n: 1 },
      { kind: 'text', text: '. Restorable ' },
      { kind: 'cite', n: 2 },
      { kind: 'text', text: '.' },
    ]);
  });

  it('expands grouped and adjacent markers', () => {
    expect(parseCitedAnswer('A [1, 3][2]', [1, 2, 3])).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'cite', n: 1 },
      { kind: 'cite', n: 3 },
      { kind: 'cite', n: 2 },
    ]);
  });

  it('leaves numbers with no citation behind them as text', () => {
    expect(parseCitedAnswer('See [4] and [a] and [1]', [1])).toEqual([
      { kind: 'text', text: 'See [4] and [a] and ' },
      { kind: 'cite', n: 1 },
    ]);
  });

  it('returns the whole answer as text when nothing is cited', () => {
    expect(parseCitedAnswer('No citations here.', [])).toEqual([
      { kind: 'text', text: 'No citations here.' },
    ]);
  });
});

describe('formatCitationScore', () => {
  it('names the scale each mode scores on', () => {
    expect(formatCitationScore({ score: 0.18234, scoreKind: 'distance' })).toBe('Distance 0.182');
    expect(formatCitationScore({ score: 12.345, scoreKind: 'bm25' })).toBe('BM25 12.35');
    expect(formatCitationScore({ score: 0.032522, scoreKind: 'rrf' })).toBe('RRF 0.0325');
  });
});

describe('formatting helpers', () => {
  it('formats durations in ms below a second and seconds above', () => {
    expect(formatDuration(18.4)).toBe('18 ms');
    expect(formatDuration(5840)).toBe('5.8 s');
  });

  it('formats query IO', () => {
    expect(formatIo({ bytesRead: 412_672, requests: 27 })).toBe('412.7 KB in 27 requests');
    expect(formatIo({ bytesRead: 100, requests: 1 })).toMatch(/in 1 request$/);
  });

  it('takes the basename of an object key', () => {
    expect(objectBasename('policies/data-retention.pdf')).toBe('data-retention.pdf');
    expect(objectBasename('top.md')).toBe('top.md');
  });
});

describe('sync progress', () => {
  it('computes a percentage once the total is known', () => {
    expect(syncPercent({ objectsTotal: 40, objectsDone: 17, chunksWritten: 796 })).toBe(43);
    expect(syncPercent({ objectsTotal: 0, objectsDone: 0, chunksWritten: 0 })).toBeUndefined();
    expect(syncPercent(undefined)).toBeUndefined();
  });

  it('labels each phase of a run', () => {
    expect(syncProgressLabel(undefined)).toBe('Starting');
    expect(syncProgressLabel({ objectsTotal: 0, objectsDone: 0, chunksWritten: 0 })).toBe(
      'Listing objects',
    );
    expect(syncProgressLabel({ objectsTotal: 40, objectsDone: 17, chunksWritten: 796 })).toBe(
      '17 of 40 objects · 796 chunks written',
    );
  });

  it('recognises an engine status body and rejects an empty one', () => {
    expect(isEngineStatus({ syncState: 'syncing', filesIndexed: 0, indexedBytes: 0 })).toBe(true);
    expect(isEngineStatus(undefined)).toBe(false);
    expect(isEngineStatus({})).toBe(false);
  });
});

describe('buildLancePythonSnippet', () => {
  const args = {
    datasetUri: 's3://filone-rag-abc/lance/chunks.lance',
    table: 'chunks',
    endpoint: 'https://s3.eu-central-3.staging.filonecontent.com',
    region: 'eu-central-3',
  };

  it('connects to the companion bucket on the Forge endpoint, path-style', () => {
    const code = buildLancePythonSnippet(args);
    expect(code).toContain('lancedb.connect(\n    "s3://filone-rag-abc/lance",');
    expect(code).toContain('"aws_endpoint": "https://s3.eu-central-3.staging.filonecontent.com"');
    expect(code).toContain('"aws_region": "eu-central-3"');
    expect(code).toContain('"aws_virtual_hosted_style_request": "false"');
    expect(code).toContain('db.open_table("chunks")');
    expect(code).not.toContain('allow_http');
  });

  it('reads credentials from the environment, never inline', () => {
    const code = buildLancePythonSnippet(args);
    expect(code).toContain('os.environ["FILONE_ACCESS_KEY_ID"]');
    expect(code).toContain('os.environ["FILONE_SECRET_ACCESS_KEY"]');
  });

  it('allows plain HTTP only for an http endpoint', () => {
    const code = buildLancePythonSnippet({ ...args, endpoint: 'http://127.0.0.1:15130' });
    expect(code).toContain('"allow_http": "true",\n    },');
  });

  it('pins the session token empty so an exported AWS token is never sent', () => {
    expect(buildLancePythonSnippet(args)).toContain('"aws_session_token": "",');
  });

  it('opens the directory that holds the dataset URI', () => {
    const code = buildLancePythonSnippet({
      ...args,
      datasetUri: 's3://filone-rag-abc/v2/data/chunks.lance',
    });
    expect(code).toContain('lancedb.connect(\n    "s3://filone-rag-abc/v2/data",');
  });

  it('ends with a search that needs only lancedb, on a neutral query', () => {
    const code = buildLancePythonSnippet(args);
    expect(code).toContain('.limit(5).to_list())');
    expect(code).not.toContain('to_pandas');
    expect(code).not.toContain('retention');
  });
});

describe('lanceDatabaseUri', () => {
  it('strips the table directory from the dataset URI', () => {
    expect(lanceDatabaseUri('s3://b/lance/chunks.lance', 'chunks')).toBe('s3://b/lance');
  });

  it('drops the last segment of a URI in another shape', () => {
    expect(lanceDatabaseUri('s3://b/lance/other.lance/', 'chunks')).toBe('s3://b/lance');
  });
});

describe('formatIndexType', () => {
  it('names a flat scan, alone or as the vector half of hybrid', () => {
    expect(formatIndexType('flat')).toBe('Flat scan');
    expect(formatIndexType('flat+FTS')).toBe('Flat scan + FTS');
  });

  it('keeps real index names and spaces the hybrid join', () => {
    expect(formatIndexType('IVF_HNSW_SQ')).toBe('IVF_HNSW_SQ');
    expect(formatIndexType('IVF_HNSW_SQ+FTS')).toBe('IVF_HNSW_SQ + FTS');
    expect(formatIndexType('FTS')).toBe('FTS');
  });

  it('says when full text had no index to use', () => {
    expect(formatIndexType('none')).toBe('No index');
  });
});

describe('getSearchableVersions', () => {
  const partial = { version: 3, timestamp: '2026-11-04T10:00:09Z' };
  const finished = {
    version: 2,
    timestamp: '2026-11-04T09:00:00Z',
    tags: ['sync-20261104T090000.000Z'],
  };
  const older = { version: 1, timestamp: '2026-11-03T09:00:00Z' };

  it('drops versions newer than the last finished sync while a run is in flight', () => {
    expect(getSearchableVersions([partial, finished, older], true)).toStrictEqual([
      finished,
      older,
    ]);
  });

  it('keeps every version when no run is in flight', () => {
    expect(getSearchableVersions([partial, finished, older], false)).toStrictEqual([
      partial,
      finished,
      older,
    ]);
  });

  it('keeps every version mid-run when no version carries a sync tag', () => {
    // A named tag that is not a sync tag does not mark a finished run.
    const named = { ...finished, tags: ['before-retention-update'] };
    expect(getSearchableVersions([partial, named, older], true)).toStrictEqual([
      partial,
      named,
      older,
    ]);
  });
});
