import { describe, expect, it } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import {
  EMPTY_COLD_RECORD,
  MIN_FREEZE_FILE_BYTES,
  countFilesTooSmallToFreeze,
  findReplacedColdFiles,
  getFileColdState,
  getJobProgress,
  getNextRunAt,
  getRestoreAfterRequest,
  getStaggeredWaitMs,
  getStorageBreakdown,
  isValidRestoreDays,
  type BucketColdRecord,
  type Clock,
  type FileRestore,
} from './cold-storage-files.js';

// A day lasts 1,000ms, so daily runs fall on whole thousands and a 90-day term
// is 90,000ms. Restores take 100ms.
const CLOCK: Clock = { dayMs: 1_000, restoreWaitMs: 100 };

/** Uploaded at 0, so a policy made later decides when it freezes. */
function version(overrides: Partial<S3ObjectVersion> = {}): S3ObjectVersion {
  return {
    key: 'any-folder/any-file',
    sizeBytes: MIN_FREEZE_FILE_BYTES,
    lastModified: new Date(0).toISOString(),
    versionId: 'any-version',
    isLatest: true,
    isDeleteMarker: false,
    ...overrides,
  };
}

/** A whole-bucket policy made at 5,500, so its first run is at 6,000. */
function bucketFrozenAt5500(overrides: Partial<BucketColdRecord> = {}): BucketColdRecord {
  return { ...EMPTY_COLD_RECORD, policies: [{ prefix: '', createdAt: 5_500 }], ...overrides };
}

function restoreOf(v: S3ObjectVersion, restore: Omit<FileRestore, 'lastModified'>): FileRestore {
  return { lastModified: v.lastModified, ...restore };
}

describe('getNextRunAt', () => {
  it.each([
    [5_500, 6_000],
    // A moment exactly on a run waits for the next one.
    [6_000, 7_000],
  ])('returns the first daily run after %i', (timestamp, expected) => {
    expect(getNextRunAt(timestamp, CLOCK)).toBe(expected);
  });
});

describe('getFileColdState', () => {
  it('returns Standard for a file no policy covers', () => {
    expect(getFileColdState(EMPTY_COLD_RECORD, version(), 10_000, CLOCK)).toStrictEqual({
      status: 'standard',
      belowMinimum: false,
    });
  });

  it('returns Standard for a file outside the frozen folder', () => {
    const record = { ...EMPTY_COLD_RECORD, policies: [{ prefix: '2025/', createdAt: 0 }] };
    expect(
      getFileColdState(record, version({ key: '2026/any-file' }), 10_000, CLOCK),
    ).toMatchObject({
      status: 'standard',
    });
  });

  describe('with a policy for one file', () => {
    const record = {
      ...EMPTY_COLD_RECORD,
      policies: [{ key: 'any-folder/any-file', createdAt: 0 }],
    };

    it('freezes that file', () => {
      expect(getFileColdState(record, version(), 10_000, CLOCK)).toMatchObject({
        status: 'frozen',
      });
    });

    it('leaves a file whose name only starts the same way in Standard', () => {
      const sibling = version({ key: 'any-folder/any-file.bak' });
      expect(getFileColdState(record, sibling, 10_000, CLOCK)).toMatchObject({
        status: 'standard',
      });
    });
  });

  it('schedules a covered file for the first run after the policy', () => {
    expect(getFileColdState(bucketFrozenAt5500(), version(), 5_900, CLOCK)).toStrictEqual({
      status: 'scheduled',
      freezesAt: 6_000,
    });
  });

  it('freezes a covered file at that run, with a 90-day term from it', () => {
    expect(getFileColdState(bucketFrozenAt5500(), version(), 6_000, CLOCK)).toStrictEqual({
      status: 'frozen',
      frozenAt: 6_000,
      termEndsAt: 96_000,
    });
  });

  it('schedules a file uploaded after the policy for the run after its upload', () => {
    const uploadedLater = version({ lastModified: new Date(8_200).toISOString() });
    expect(getFileColdState(bucketFrozenAt5500(), uploadedLater, 8_500, CLOCK)).toStrictEqual({
      status: 'scheduled',
      freezesAt: 9_000,
    });
  });

  it.each<[string, Partial<S3ObjectVersion>]>([
    ['an older version', { isLatest: false }],
    ['a delete marker', { isDeleteMarker: true }],
  ])('returns Standard for %s, which never freezes', (_, overrides) => {
    expect(getFileColdState(bucketFrozenAt5500(), version(overrides), 10_000, CLOCK)).toStrictEqual(
      {
        status: 'standard',
        belowMinimum: false,
      },
    );
  });

  it('returns Standard, below the minimum, for a covered file under 128 KB', () => {
    const small = version({ sizeBytes: MIN_FREEZE_FILE_BYTES - 1 });
    expect(getFileColdState(bucketFrozenAt5500(), small, 10_000, CLOCK)).toStrictEqual({
      status: 'standard',
      belowMinimum: true,
    });
  });

  it('returns kept for a file a permanent restore kept in Standard', () => {
    const record = bucketFrozenAt5500({ kept: { 'any-folder/any-file': 7_000 } });
    expect(getFileColdState(record, version(), 10_000, CLOCK)).toStrictEqual({ status: 'kept' });
  });

  it('schedules a file frozen again for the run after "Freeze again"', () => {
    const record = bucketFrozenAt5500({ refrozen: { 'any-folder/any-file': 20_300 } });
    expect(getFileColdState(record, version(), 20_500, CLOCK)).toStrictEqual({
      status: 'scheduled',
      freezesAt: 21_000,
    });
  });

  describe('with a restore of the frozen file ready at 7,000 and kept until 21,000', () => {
    const v = version();
    const record = bucketFrozenAt5500({
      restores: { [v.key]: restoreOf(v, { readyAt: 7_000, expiresAt: 21_000 }) },
    });

    it.each([
      [6_500, { status: 'restoring', readyAt: 7_000, expiresAt: 21_000 }],
      [7_000, { status: 'restored', expiresAt: 21_000 }],
      [21_000, { status: 'frozen' }],
    ])('at %i returns %o', (now, expected) => {
      expect(getFileColdState(record, v, now, CLOCK)).toStrictEqual({
        frozenAt: 6_000,
        termEndsAt: 96_000,
        ...expected,
      });
    });
  });

  it('ignores a restore made from a version the file has since replaced', () => {
    const replaced = version({ lastModified: new Date(1).toISOString() });
    const current = version({ lastModified: new Date(2).toISOString() });
    const record = bucketFrozenAt5500({
      restores: { [current.key]: restoreOf(replaced, { readyAt: 7_000, expiresAt: 21_000 }) },
    });
    expect(getFileColdState(record, current, 8_000, CLOCK)).toMatchObject({ status: 'frozen' });
  });
});

describe('isValidRestoreDays', () => {
  it.each([1, 14, 365])('accepts %i days', (days) => {
    expect(isValidRestoreDays(days)).toBe(true);
  });

  it.each([0, -1, 1.5, 366, Number.NaN])('rejects %d days', (days) => {
    expect(isValidRestoreDays(days)).toBe(false);
  });
});

describe('getRestoreAfterRequest', () => {
  const v = version();

  it('keeps the copy for the days asked, counted from when it is ready', () => {
    expect(
      getRestoreAfterRequest(undefined, { lastModified: v.lastModified, days: 30 }, 10_000, CLOCK),
    ).toStrictEqual({
      lastModified: v.lastModified,
      readyAt: 10_100,
      expiresAt: 40_100,
    });
  });

  it('waits the time given for a file in a job instead of the full restore time', () => {
    expect(
      getRestoreAfterRequest(
        undefined,
        { lastModified: v.lastModified, days: 14, waitMs: 40 },
        10_000,
        CLOCK,
      ),
    ).toMatchObject({ readyAt: 10_040 });
  });

  it('keeps the copy for 14 days when fewer are asked', () => {
    expect(
      getRestoreAfterRequest(undefined, { lastModified: v.lastModified, days: 3 }, 10_000, CLOCK),
    ).toMatchObject({
      expiresAt: 24_100,
    });
  });

  it('extends a copy that is still readable from now, keeping its ready time', () => {
    const existing = restoreOf(v, { readyAt: 10_100, expiresAt: 24_100 });
    expect(
      getRestoreAfterRequest(existing, { lastModified: v.lastModified, days: 20 }, 15_000, CLOCK),
    ).toStrictEqual({
      ...existing,
      expiresAt: 35_000,
    });
  });

  it('never shortens a copy that already lasts longer', () => {
    const existing = restoreOf(v, { readyAt: 10_100, expiresAt: 100_000 });
    expect(
      getRestoreAfterRequest(existing, { lastModified: v.lastModified, days: 14 }, 15_000, CLOCK),
    ).toStrictEqual(existing);
  });
});

describe('getStorageBreakdown', () => {
  it('counts files and bytes by where they bill', () => {
    const record = bucketFrozenAt5500();
    const versions = [
      version({ key: 'frozen', sizeBytes: 200_000 }),
      version({ key: 'uploaded-after-run', lastModified: new Date(9_500).toISOString() }),
      version({ key: 'small', sizeBytes: 10 }),
      version({ key: 'frozen', isLatest: false, sizeBytes: 300_000 }),
      version({ key: 'deleted', isDeleteMarker: true }),
    ];
    expect(getStorageBreakdown(record, versions, 9_600, CLOCK)).toStrictEqual({
      frozen: { files: 1, bytes: 200_000 },
      restored: { files: 0, bytes: 0 },
      scheduled: { files: 1, bytes: MIN_FREEZE_FILE_BYTES },
      standard: { files: 1, bytes: 10 },
      olderVersions: { files: 1, bytes: 300_000 },
    });
  });
});

describe('findReplacedColdFiles', () => {
  const stateAt = (record: BucketColdRecord, now: number) => (v: S3ObjectVersion) =>
    getFileColdState(record, v, now, CLOCK);

  it('returns the uploads whose latest version is frozen', () => {
    const versions = [version({ key: 'any-a' }), version({ key: 'any-b' })];
    expect(
      findReplacedColdFiles(['any-a', 'any-new'], versions, stateAt(bucketFrozenAt5500(), 10_000)),
    ).toStrictEqual([
      { key: 'any-a', state: { status: 'frozen', frozenAt: 6_000, termEndsAt: 96_000 } },
    ]);
  });

  it('returns nothing for an upload over a file still waiting for its first run', () => {
    expect(
      findReplacedColdFiles(
        ['any-a'],
        [version({ key: 'any-a' })],
        stateAt(bucketFrozenAt5500(), 5_900),
      ),
    ).toStrictEqual([]);
  });
});

describe('getStaggeredWaitMs', () => {
  it.each([
    [0, 75],
    // The last file of the job waits the full restore time.
    [1, 100],
  ])('gives file %i of a 2-file job a %ims wait', (index, expected) => {
    expect(getStaggeredWaitMs(index, 2, CLOCK)).toBe(expected);
  });
});

describe('getJobProgress', () => {
  const job = { id: 'any-job', label: 'any-label', keys: ['a', 'b', 'c'], startedAt: 0 };

  it('counts a file as ready once it is no longer restoring', () => {
    const states: Record<string, ReturnType<typeof getFileColdState> | undefined> = {
      a: { status: 'restored', frozenAt: 0, termEndsAt: 1, expiresAt: 2 },
      b: { status: 'restoring', frozenAt: 0, termEndsAt: 1, readyAt: 2, expiresAt: 3 },
      // Deleted or replaced since the restore started: nothing left to wait for.
      c: undefined,
    };
    expect(getJobProgress(job, (key) => states[key])).toStrictEqual({ ready: 2, total: 3 });
  });
});

describe('countFilesTooSmallToFreeze', () => {
  const small = MIN_FREEZE_FILE_BYTES - 1;

  it('counts the latest files under 128 KB inside the prefix', () => {
    const versions = [
      version({ key: 'any-folder/a', sizeBytes: small }),
      version({ key: 'any-folder/b', sizeBytes: small }),
      version({ key: 'any-folder/c', sizeBytes: MIN_FREEZE_FILE_BYTES }),
    ];
    expect(countFilesTooSmallToFreeze(versions, 'any-folder/')).toBe(2);
  });

  it.each([
    ['a file outside the prefix', version({ key: 'other-folder/a', sizeBytes: small })],
    ['an older version', version({ sizeBytes: small, isLatest: false })],
    ['a delete marker', version({ sizeBytes: 0, isDeleteMarker: true })],
  ])('leaves out %s', (_, excluded) => {
    expect(countFilesTooSmallToFreeze([excluded], 'any-folder/')).toBe(0);
  });
});
