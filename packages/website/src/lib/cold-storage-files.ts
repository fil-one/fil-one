// The cold storage model of FIL-1608, per file: which files a bucket's freeze
// policies cover, when each one freezes, and what a restore or a "keep in
// Standard" does to it. Pure functions over a bucket's record, so the rules
// can be tested without the browser store that holds the record.

import type { S3ObjectVersion } from '@filone/shared';

export const MIN_TERM_DAYS = 90;
export const WARM_MIN_DAYS = 14;
export const MAX_RESTORE_DAYS = 365;
/** Files below this size stay in Standard, as with AWS's lifecycle default. */
export const MIN_FREEZE_FILE_BYTES = 128 * 1024;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a day and a restore wait last. The real flow freezes at a daily
 * run and restores in about an hour; short waits shrink both so a demo can
 * watch a freeze, a restore and a 2-week expiry happen.
 */
export interface Clock {
  dayMs: number;
  restoreWaitMs: number;
}

export const REAL_CLOCK: Clock = { dayMs: DAY_MS, restoreWaitMs: 60 * 60 * 1000 };
export const SHORT_CLOCK: Clock = { dayMs: 10_000, restoreWaitMs: 10_000 };

/** Freeze a bucket or a folder: every file under `prefix`, now and later. */
export interface FolderFreezePolicy {
  /** `''` for the whole bucket, else a folder such as `2025/`. */
  prefix: string;
  createdAt: number;
}

/** Freeze one file: the file named `key`, and any later upload under that name. */
export interface FileFreezePolicy {
  key: string;
  createdAt: number;
}

export type FreezePolicy = FolderFreezePolicy | FileFreezePolicy;

export function isFilePolicy(policy: FreezePolicy): policy is FileFreezePolicy {
  return Object.hasOwn(policy, 'key');
}

export function isFolderPolicy(policy: FreezePolicy): policy is FolderFreezePolicy {
  return !isFilePolicy(policy);
}

export function doesPolicyCover(policy: FreezePolicy, key: string): boolean {
  return isFilePolicy(policy) ? policy.key === key : key.startsWith(policy.prefix);
}

/** A readable copy of one frozen file, tied to the version it was made from. */
export interface FileRestore {
  /** The restored version's last-modified time, so a newer upload drops the restore. */
  lastModified: string;
  readyAt: number;
  expiresAt: number;
}

/** One restore of several files, run as a single job so its progress can be counted. */
export interface RestoreJob {
  id: string;
  /** What was restored, for the progress line: a folder, "the whole bucket" or "3 files". */
  label: string;
  keys: string[];
  startedAt: number;
}

export interface BucketColdRecord {
  policies: FreezePolicy[];
  restoreJobs: RestoreJob[];
  /** By file key. */
  restores: Record<string, FileRestore>;
  /** Files kept in Standard by a permanent restore, by key, with when. */
  kept: Record<string, number>;
  /** When "Freeze again" cleared a file's keep mark, by key: it freezes at the next run after. */
  refrozen: Record<string, number>;
}

export const EMPTY_COLD_RECORD: BucketColdRecord = {
  policies: [],
  restoreJobs: [],
  restores: {},
  kept: {},
  refrozen: {},
};

export interface StandardFile {
  status: 'standard';
  /** Covered by a freeze policy but under the 128 KB minimum. */
  belowMinimum: boolean;
}

export interface KeptFile {
  status: 'kept';
}

export interface ScheduledFile {
  status: 'scheduled';
  freezesAt: number;
}

interface FrozenTerm {
  frozenAt: number;
  termEndsAt: number;
}

export interface FrozenFile extends FrozenTerm {
  status: 'frozen';
}

export interface RestoringFile extends FrozenTerm {
  status: 'restoring';
  readyAt: number;
  expiresAt: number;
}

export interface RestoredFile extends FrozenTerm {
  status: 'restored';
  expiresAt: number;
}

export type FileColdState =
  | StandardFile
  | KeptFile
  | ScheduledFile
  | FrozenFile
  | RestoringFile
  | RestoredFile;

/** A file with a frozen copy, whether or not a readable copy sits beside it. */
export type ColdFile = FrozenFile | RestoringFile | RestoredFile;

export function isColdFile(state: FileColdState): state is ColdFile {
  return state.status === 'frozen' || state.status === 'restoring' || state.status === 'restored';
}

/** Frozen or still restoring: no readable copy yet, so download and share wait. */
export function isLockedFile(state: FileColdState): boolean {
  return state.status === 'frozen' || state.status === 'restoring';
}

const STANDARD: StandardFile = { status: 'standard', belowMinimum: false };

/** The first daily run strictly after `timestamp`: midnight UTC in the real flow. */
export function getNextRunAt(timestamp: number, clock: Clock): number {
  return (Math.floor(timestamp / clock.dayMs) + 1) * clock.dayMs;
}

/** The oldest policy covering `key`, which decides when the file first froze. */
export function findCoveringPolicy(
  policies: FreezePolicy[],
  key: string,
): FreezePolicy | undefined {
  return policies
    .filter((policy) => doesPolicyCover(policy, key))
    .reduce<FreezePolicy | undefined>(
      (oldest, policy) => (oldest && oldest.createdAt <= policy.createdAt ? oldest : policy),
      undefined,
    );
}

/**
 * Where one version of a file stands. Archives are flattened: only the latest
 * version freezes, so an older version or a delete marker is always Standard.
 * A file freezes at the first run after the latest of three moments: the
 * policy's creation, the file's upload, and a "Freeze again".
 */
export function getFileColdState(
  record: BucketColdRecord,
  version: S3ObjectVersion,
  now: number,
  clock: Clock,
): FileColdState {
  if (!version.isLatest || version.isDeleteMarker) return STANDARD;
  const policy = findCoveringPolicy(record.policies, version.key);
  if (!policy) return STANDARD;
  if (Object.hasOwn(record.kept, version.key)) return { status: 'kept' };
  if (version.sizeBytes < MIN_FREEZE_FILE_BYTES) return { status: 'standard', belowMinimum: true };

  const baseline = Math.max(
    policy.createdAt,
    Date.parse(version.lastModified),
    record.refrozen[version.key] ?? 0,
  );
  const frozenAt = getNextRunAt(baseline, clock);
  if (now < frozenAt) return { status: 'scheduled', freezesAt: frozenAt };

  const term = { frozenAt, termEndsAt: frozenAt + MIN_TERM_DAYS * clock.dayMs };
  const restore = record.restores[version.key];
  if (!restore || restore.lastModified !== version.lastModified || now >= restore.expiresAt) {
    return { ...term, status: 'frozen' };
  }
  return now < restore.readyAt
    ? { ...term, status: 'restoring', readyAt: restore.readyAt, expiresAt: restore.expiresAt }
    : { ...term, status: 'restored', expiresAt: restore.expiresAt };
}

/**
 * Where a folder stands. A folder has no storage of its own, so its state is
 * the freeze rule over it: scheduled or frozen when a rule covers the folder,
 * partly frozen when only some files or subfolders inside have one.
 */
export type FolderColdState =
  | { status: 'standard' }
  | { status: 'scheduled'; freezesAt: number }
  | { status: 'frozen'; restoredCount: number }
  | { status: 'partly-frozen' };

/** A folder as `getFolderColdState` reads it: its prefix and the bucket listing it sits in. */
export interface FolderInListing {
  prefix: string;
  versions: S3ObjectVersion[];
}

export function getFolderColdState(
  record: BucketColdRecord,
  { prefix, versions }: FolderInListing,
  now: number,
  clock: Clock,
): FolderColdState {
  const inside = versions.filter((version) => version.isLatest && version.key.startsWith(prefix));
  const states = inside.map((version) => getFileColdState(record, version, now, clock));
  const rule = findCoveringPolicy(record.policies.filter(isFolderPolicy), prefix);
  if (rule) {
    const freezesAt = getNextRunAt(rule.createdAt, clock);
    if (now < freezesAt) return { status: 'scheduled', freezesAt };
    const restoredCount = states.filter(
      (state) => state.status === 'restoring' || state.status === 'restored',
    ).length;
    return { status: 'frozen', restoredCount };
  }
  const hasRuleInside = record.policies.some(
    (policy) => isFolderPolicy(policy) && policy.prefix.startsWith(prefix),
  );
  const hasColdFile = states.some((state) => state.status === 'scheduled' || isColdFile(state));
  return hasRuleInside || hasColdFile ? { status: 'partly-frozen' } : { status: 'standard' };
}

/** RestoreObject's Days: a whole number from 1 to 365. */
export function isValidRestoreDays(days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= MAX_RESTORE_DAYS;
}

/**
 * The restore a request for `days` makes. The readable copy is kept, and
 * billed, for at least 2 weeks, so its expiry always matches what is billed.
 * Restoring a file that is already restored extends its copy, never shortening it.
 */
export function getRestoreAfterRequest(
  existing: FileRestore | undefined,
  /** `waitMs` overrides the clock's restore wait, so files in one job finish one after another. */
  request: { lastModified: string; days: number; waitMs?: number },
  now: number,
  clock: Clock,
): FileRestore {
  const keptMs = Math.max(request.days, WARM_MIN_DAYS) * clock.dayMs;
  if (existing && existing.lastModified === request.lastModified && now < existing.expiresAt) {
    const from = Math.max(now, existing.readyAt);
    return { ...existing, expiresAt: Math.max(existing.expiresAt, from + keptMs) };
  }
  const readyAt = now + (request.waitMs ?? clock.restoreWaitMs);
  return { lastModified: request.lastModified, readyAt, expiresAt: readyAt + keptMs };
}

/**
 * How long the file at `index` of a `count`-file job waits: the first about
 * half the full wait, the last the full wait, the rest spread between. A real
 * bulk restore finishes file by file, which is what its progress count shows.
 */
export function getStaggeredWaitMs(index: number, count: number, clock: Clock): number {
  return Math.round(clock.restoreWaitMs * (0.5 + (0.5 * (index + 1)) / count));
}

export interface JobProgress {
  ready: number;
  total: number;
}

/** How many of a job's files have a readable copy; a file no longer cold counts as done. */
export function getJobProgress(
  job: RestoreJob,
  getStateByKey: (key: string) => FileColdState | undefined,
): JobProgress {
  const ready = job.keys.filter((key) => getStateByKey(key)?.status !== 'restoring').length;
  return { ready, total: job.keys.length };
}

export interface Tally {
  files: number;
  bytes: number;
}

/** What a bucket's listing holds, by where its bytes are billed. */
export interface StorageBreakdown {
  frozen: Tally;
  /** Restoring and restored files: the frozen copy plus a readable one. */
  restored: Tally;
  scheduled: Tally;
  /** Latest versions in Standard, kept files included. */
  standard: Tally;
  /** Noncurrent versions, which never freeze and bill as Standard until deleted. */
  olderVersions: Tally;
}

function emptyTally(): Tally {
  return { files: 0, bytes: 0 };
}

function getBreakdownSlot(
  version: S3ObjectVersion,
  state: FileColdState,
): keyof StorageBreakdown | null {
  if (version.isDeleteMarker) return null;
  if (!version.isLatest) return 'olderVersions';
  switch (state.status) {
    case 'frozen':
      return 'frozen';
    case 'restoring':
    case 'restored':
      return 'restored';
    case 'scheduled':
      return 'scheduled';
    default:
      return 'standard';
  }
}

/**
 * How many files under `prefix` a freeze policy there would leave in Standard
 * for being under 128 KB. Only the latest version of a file can freeze, so
 * older versions and delete markers don't count.
 */
export function countFilesTooSmallToFreeze(versions: S3ObjectVersion[], prefix: string): number {
  return versions.filter(
    (version) =>
      version.isLatest &&
      !version.isDeleteMarker &&
      version.key.startsWith(prefix) &&
      version.sizeBytes < MIN_FREEZE_FILE_BYTES,
  ).length;
}

export function getStorageBreakdown(
  record: BucketColdRecord,
  versions: S3ObjectVersion[],
  now: number,
  clock: Clock,
): StorageBreakdown {
  const breakdown: StorageBreakdown = {
    frozen: emptyTally(),
    restored: emptyTally(),
    scheduled: emptyTally(),
    standard: emptyTally(),
    olderVersions: emptyTally(),
  };
  for (const version of versions) {
    const slot = getBreakdownSlot(version, getFileColdState(record, version, now, clock));
    if (!slot) continue;
    breakdown[slot].files += 1;
    breakdown[slot].bytes += version.sizeBytes;
  }
  return breakdown;
}

export interface ReplacedFile {
  key: string;
  state: ColdFile;
}

/**
 * The files among `uploadKeys` whose upload replaces a frozen copy: those
 * whose latest version is frozen, restoring or restored. Files still waiting
 * for the daily run, kept in Standard or under 128 KB are Standard, so
 * replacing them costs nothing extra.
 */
export function findReplacedColdFiles(
  uploadKeys: string[],
  versions: S3ObjectVersion[],
  getState: (version: S3ObjectVersion) => FileColdState,
): ReplacedFile[] {
  const cold = new Map<string, ColdFile>();
  for (const version of versions) {
    const state = getState(version);
    if (isColdFile(state)) cold.set(version.key, state);
  }
  return uploadKeys.flatMap((key) => {
    const state = cold.get(key);
    return state ? [{ key, state }] : [];
  });
}

export function isInMinimumTerm(state: ColdFile, now: number): boolean {
  return now < state.termEndsAt;
}

/**
 * A permanent restore: the files go back to Standard for good, with the keep
 * mark that makes the daily run skip their names, and any copy dropped since
 * the files are now readable. With a `prefix`, a folder or `''` for the whole
 * bucket, it also removes every freeze rule there and below, so files
 * uploaded there later stay in Standard too.
 */
export function getRecordAfterPermanentRestore(
  record: BucketColdRecord,
  change: { keys: string[]; prefix?: string },
  now: number,
): BucketColdRecord {
  const { keys, prefix } = change;
  const kept = { ...record.kept };
  const restores = { ...record.restores };
  for (const key of keys) {
    kept[key] = now;
    delete restores[key];
  }
  const policies =
    prefix === undefined
      ? record.policies
      : record.policies.filter(
          (policy) => !(isFilePolicy(policy) ? policy.key : policy.prefix).startsWith(prefix),
        );
  return { ...record, kept, restores, policies };
}

/**
 * The folder rule that still covers `prefix` from above it, if any: after a
 * permanent restore of the folder, files uploaded there later still freeze
 * under it.
 */
export function findRuleAbove(
  policies: FreezePolicy[],
  prefix: string,
): FolderFreezePolicy | undefined {
  return policies
    .filter(isFolderPolicy)
    .find((policy) => policy.prefix.length < prefix.length && prefix.startsWith(policy.prefix));
}
