// Prototype of cold storage (FIL-1608): freeze policies on a bucket or a
// folder, files that freeze at the next daily run, restores of single files,
// folders, selections or whole buckets, and keeping files in Standard.
// The per-file rules live in `cold-storage-files.ts`; this file holds the
// browser store and the hooks the console reads it through.
//
// Nothing here talks to the backend. The demand test fakes the feature while the
// data stays on disk, and this prototype goes one step further: each bucket's
// freeze policies and restores live in this browser's localStorage, so the flow
// can be clicked through against real buckets without any server change.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  S3_REGION,
  getRegionLabel,
  type Bucket,
  type BucketAnalyticsResponse,
  type S3ObjectVersion,
  type S3Region,
} from '@filone/shared';

import { ALL_REGIONS, type BucketFilters, type BucketSort } from './bucket-table.js';
import {
  EMPTY_COLD_RECORD,
  REAL_CLOCK,
  SHORT_CLOCK,
  doesPolicyCover,
  getFileColdState,
  getNextRunAt,
  isFilePolicy,
  isColdFile,
  isFolderPolicy,
  getRestoreAfterRequest,
  getStaggeredWaitMs,
  type BucketColdRecord,
  type Clock,
  type ColdFile,
  type FileColdState,
} from './cold-storage-files.js';
import { MIN_TERM_DAYS } from './cold-storage-files.js';
import { useHasPermission } from './use-permissions.js';

export {
  MAX_RESTORE_DAYS,
  MIN_TERM_DAYS,
  WARM_MIN_DAYS,
  isColdFile,
  isInMinimumTerm,
  isLockedFile,
  isValidRestoreDays,
  type BucketColdRecord,
  type ColdFile,
  type FileColdState,
  type StorageBreakdown,
} from './cold-storage-files.js';

export const WARM_PRICE_PER_TB_MONTH = 5.99;
export const COLD_PRICE_PER_TB_MONTH = 2.99;

const STORAGE_KEY = 'filone:coldStoragePrototype';

export interface PrototypeSettings {
  trialAccount: boolean;
  memberRole: boolean;
  shortWaits: boolean;
  demoBucket: boolean;
}

interface Store {
  /** By `region/name`. */
  buckets: Record<string, BucketColdRecord>;
  settings: PrototypeSettings;
  announcementSeen: boolean;
}

const DEFAULT_STORE: Store = {
  buckets: {},
  settings: {
    trialAccount: false,
    memberRole: false,
    shortWaits: true,
    // Off until switched on in the prototype controls: on by default, every
    // test of the Buckets page would meet a bucket its API mock never returned.
    demoBucket: false,
  },
  announcementSeen: false,
};

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STORE;
    const parsed = JSON.parse(raw) as Partial<Store>;
    // Buckets saved by the whole-bucket prototype have no policies, and their
    // states don't map onto files, so they start over in Standard.
    const buckets = Object.fromEntries(
      Object.entries(parsed.buckets ?? {})
        .filter(([, record]) => Array.isArray(record.policies))
        .map(([id, record]) => [id, { ...EMPTY_COLD_RECORD, ...record }]),
    );
    return {
      ...DEFAULT_STORE,
      ...parsed,
      buckets,
      settings: { ...DEFAULT_STORE.settings, ...parsed.settings },
    };
  } catch {
    return DEFAULT_STORE;
  }
}

let store = readStore();
const listeners = new Set<() => void>();

function writeStore(next: Store) {
  store = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled: the prototype still works until the page reloads.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useStore(): Store {
  return useSyncExternalStore(subscribe, () => store);
}

function bucketId(bucketName: string, region: string) {
  return `${region}/${bucketName}`;
}

function getClock(settings: PrototypeSettings): Clock {
  return settings.shortWaits ? SHORT_CLOCK : REAL_CLOCK;
}

export function useClock(): Clock {
  return getClock(useStore().settings);
}

/** Re-renders every second while `active`, so countdowns move and files freeze on screen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : Date.now();
}

function updateRecord(
  bucketName: string,
  region: string,
  update: (record: BucketColdRecord) => BucketColdRecord,
) {
  const id = bucketId(bucketName, region);
  const current = store.buckets[id] ?? EMPTY_COLD_RECORD;
  writeStore({ ...store, buckets: { ...store.buckets, [id]: update(current) } });
}

// ---------------------------------------------------------------------------
// Reading a bucket's files
// ---------------------------------------------------------------------------

export interface ColdFiles {
  /** `null` while the bucket has no freeze policy and so no cold storage at all. */
  record: BucketColdRecord | null;
  now: number;
  clock: Clock;
  getState: (version: S3ObjectVersion) => FileColdState;
}

/**
 * Where each of a bucket's files stands, re-read every second while the
 * bucket has a policy, so a file turns frozen at the daily run and a restore
 * counts down in place.
 */
export function useColdFiles(bucketName: string, region: string): ColdFiles {
  const { buckets, settings } = useStore();
  const record = buckets[bucketId(bucketName, region)] ?? null;
  const now = useNow(record !== null);
  const clock = getClock(settings);
  return {
    record,
    now,
    clock,
    getState: (version) => getFileColdState(record ?? EMPTY_COLD_RECORD, version, now, clock),
  };
}

/**
 * A bucket's cold storage as the Buckets table sees it, without a listing:
 * whether its policy covers the bucket or some folders, whether the first run
 * has happened, and how many files have a readable copy.
 */
export interface BucketColdSummary {
  scope: 'bucket' | 'folders';
  /** The folders under a policy; empty when the whole bucket is. */
  prefixes: string[];
  /** How many single files have a policy of their own. */
  fileCount: number;
  /** True until the first daily run after the oldest policy. */
  scheduled: boolean;
  firstRunAt: number;
  activeRestores: number;
}

function summarize(record: BucketColdRecord, now: number, clock: Clock): BucketColdSummary | null {
  if (record.policies.length === 0) return null;
  const folders = record.policies.filter(isFolderPolicy);
  const wholeBucket = folders.some((policy) => policy.prefix === '');
  const oldest = Math.min(...record.policies.map((policy) => policy.createdAt));
  const firstRunAt = getNextRunAt(oldest, clock);
  return {
    scope: wholeBucket ? 'bucket' : 'folders',
    prefixes: wholeBucket ? [] : folders.map((policy) => policy.prefix),
    fileCount: record.policies.filter(isFilePolicy).length,
    scheduled: now < firstRunAt,
    firstRunAt,
    activeRestores: Object.values(record.restores).filter((r) => now < r.expiresAt).length,
  };
}

/** How long a row keeps `data-freezing`: its animation's last step ends at 800ms. */
const FREEZE_MOMENT_MS = 900;

/**
 * True for a moment after `frozen` turns true while the component is on
 * screen, which the Buckets table's freeze animation keys off. Starts from the
 * value at mount, so a bucket that is already frozen never animates on load.
 */
export function useJustFroze(frozen: boolean): boolean {
  const previous = useRef(frozen);
  const [justFroze, setJustFroze] = useState(false);
  useEffect(() => {
    const froze = frozen && !previous.current;
    previous.current = frozen;
    if (!froze) return;
    setJustFroze(true);
    const timer = setTimeout(() => setJustFroze(false), FREEZE_MOMENT_MS);
    return () => {
      clearTimeout(timer);
      setJustFroze(false);
    };
  }, [frozen]);
  return justFroze;
}

export function useBucketColdSummary(bucketName: string, region: string): BucketColdSummary | null {
  const { buckets, settings } = useStore();
  const record = buckets[bucketId(bucketName, region)];
  const now = useNow(record !== undefined);
  return record ? summarize(record, now, getClock(settings)) : null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Starts freezing every file under `prefix`, `''` being the whole bucket, at
 * the next daily run, and every file added there later at the run after it.
 */
export function addFreezePolicy(bucketName: string, region: string, prefix: string) {
  updateRecord(bucketName, region, (record) =>
    record.policies.some((policy) => !isFilePolicy(policy) && prefix.startsWith(policy.prefix))
      ? record
      : { ...record, policies: [...record.policies, { prefix, createdAt: Date.now() }] },
  );
}

/** Starts freezing these files at the next daily run, and later uploads under their names. */
export function addFileFreezePolicies(bucketName: string, region: string, keys: string[]) {
  const createdAt = Date.now();
  updateRecord(bucketName, region, (record) => {
    const kept = { ...record.kept };
    for (const key of keys) delete kept[key];
    const fresh = keys.filter(
      (key) => !record.policies.some((policy) => doesPolicyCover(policy, key)),
    );
    return {
      ...record,
      kept,
      policies: [...record.policies, ...fresh.map((key) => ({ key, createdAt }))],
    };
  });
}

/** Starts one restore job over `versions`, each kept readable for `days` (at least 14). */
export function restoreFiles(
  bucketName: string,
  region: string,
  job: {
    versions: Pick<S3ObjectVersion, 'key' | 'lastModified'>[];
    days: number;
    /** What is being restored, for the progress line. */
    label: string;
  },
) {
  const now = Date.now();
  const clock = getClock(store.settings);
  const { versions, days, label } = job;
  updateRecord(bucketName, region, (record) => {
    const restores = { ...record.restores };
    versions.forEach((version, index) => {
      restores[version.key] = getRestoreAfterRequest(
        restores[version.key],
        {
          lastModified: version.lastModified,
          days,
          waitMs: getStaggeredWaitMs(index, versions.length, clock),
        },
        now,
        clock,
      );
    });
    // A single file needs no count: its own Restoring pill says it all.
    const restoreJobs =
      versions.length > 1
        ? [
            ...record.restoreJobs.slice(-4),
            { id: `${now}`, label, keys: versions.map((v) => v.key), startedAt: now },
          ]
        : record.restoreJobs;
    return { ...record, restores, restoreJobs };
  });
}

/**
 * A permanent restore: the files move to Standard, and the daily run skips
 * them from now on, new uploads under the same name included.
 */
export function keepInStandard(bucketName: string, region: string, keys: string[]) {
  const now = Date.now();
  updateRecord(bucketName, region, (record) => {
    const kept = { ...record.kept };
    const restores = { ...record.restores };
    for (const key of keys) {
      kept[key] = now;
      delete restores[key];
    }
    return { ...record, kept, restores };
  });
}

/** Clears the keep mark, so the files freeze again at the next daily run. */
export function freezeAgain(bucketName: string, region: string, keys: string[]) {
  const now = Date.now();
  updateRecord(bucketName, region, (record) => {
    const kept = { ...record.kept };
    const refrozen = { ...record.refrozen };
    for (const key of keys) {
      delete kept[key];
      refrozen[key] = now;
    }
    return { ...record, kept, refrozen };
  });
}

/** Deleting a bucket ends its cold storage; the dialog shows what that costs first. */
export function forgetBucket(bucketName: string, region: string) {
  const buckets = { ...store.buckets };
  delete buckets[bucketId(bucketName, region)];
  writeStore({ ...store, buckets });
}

export function usePrototypeSettings(): PrototypeSettings {
  return useStore().settings;
}

export function updatePrototypeSettings(patch: Partial<PrototypeSettings>) {
  writeStore({ ...store, settings: { ...store.settings, ...patch } });
}

export function resetPrototype() {
  writeStore({ ...DEFAULT_STORE, settings: store.settings });
}

export function useAnnouncementSeen(): boolean {
  return useStore().announcementSeen;
}

export function markAnnouncementSeen() {
  writeStore({ ...store, announcementSeen: true });
}

/**
 * Stands in for analytics. The flow marks what the demand test would measure;
 * the prototype logs each event so a demo can show it without sending anything.
 */
export function trackColdStorage(event: string, props: Record<string, string> = {}) {
  console.info(`[cold storage] ${event}`, props);
}

/**
 * The frozen and restored files in a listing, read outside React: for the
 * Buckets table, which loads a bucket's listing only when asked to restore it.
 */
export function findColdVersions(
  bucketName: string,
  region: string,
  versions: S3ObjectVersion[],
): S3ObjectVersion[] {
  const record = store.buckets[bucketId(bucketName, region)];
  if (!record) return [];
  const clock = getClock(store.settings);
  const now = Date.now();
  return versions.filter((v) => isColdFile(getFileColdState(record, v, now, clock)));
}

/** Lets stories and tests seed a bucket's record directly. */
export function setColdRecord(bucketName: string, region: string, record: BucketColdRecord) {
  updateRecord(bucketName, region, () => record);
}

// ---------------------------------------------------------------------------
// Demo bucket
// ---------------------------------------------------------------------------

/**
 * A made-up bucket added to the listing in this browser, so an org with four
 * real buckets reaches the five that bring up search, sort and the filters. The
 * API doesn't know it: it lives in the table, its filters and the freeze
 * dialog, but opening it, or deleting it, fails.
 */
const DEMO_BUCKET: Bucket = {
  bucketName: 'raw-footage-2021',
  region: S3_REGION,
  createdAt: '2026-03-02T10:00:00Z',
  isPublic: false,
};
const DEMO_BUCKET_ID = bucketId(DEMO_BUCKET.bucketName, DEMO_BUCKET.region);
const DEMO_ANALYTICS = { bytesUsed: 12e12, objectCount: 3_210 };

export function useDemoBucket(): Bucket | null {
  return usePrototypeSettings().demoBucket ? DEMO_BUCKET : null;
}

/**
 * `buckets` with the demo bucket added where the backend would have put it:
 * dropped when the search or region filter excludes it, and inserted in the
 * current sort order. `buckets` arrives already filtered and sorted.
 */
export function withDemoBucket(
  buckets: Bucket[],
  demo: Bucket | null,
  filters: BucketFilters,
  sort: BucketSort,
): Bucket[] {
  if (!demo || buckets.some((b) => b.bucketName === demo.bucketName)) return buckets;
  const query = filters.query.trim().toLowerCase();
  if (query !== '' && !demo.bucketName.toLowerCase().includes(query)) return buckets;
  if (filters.region !== ALL_REGIONS && filters.region !== demo.region) return buckets;
  const sortValue = (b: Bucket) =>
    sort.key === 'region'
      ? getRegionLabel(b.region)
      : sort.key === 'createdAt'
        ? b.createdAt
        : b.bucketName;
  const direction = sort.direction === 'asc' ? 1 : -1;
  const at = buckets.findIndex((b) => direction * sortValue(demo).localeCompare(sortValue(b)) < 0);
  return at === -1 ? [...buckets, demo] : [...buckets.slice(0, at), demo, ...buckets.slice(at)];
}

/** The demo bucket's made-up size and object count; `null` for every real bucket. */
export function useSimulatedAnalytics(
  bucketName: string,
  region: S3Region,
): Pick<BucketAnalyticsResponse, 'bytesUsed' | 'objectCount'> | null {
  return bucketId(bucketName, region) === DEMO_BUCKET_ID ? DEMO_ANALYTICS : null;
}

// ---------------------------------------------------------------------------
// Storage filter
// ---------------------------------------------------------------------------

/**
 * The Buckets table's storage filter. Cold storage state lives in this
 * browser, so unlike search and region this filter runs here, over the list
 * the backend returns. Frozen takes any bucket with a freeze policy, whole or
 * by folder; Restored takes any bucket with a readable copy of a frozen file.
 */
export type StorageFilter = 'all' | 'standard' | 'frozen' | 'restored';

export const STORAGE_FILTER_LABELS: Record<StorageFilter, string> = {
  all: 'All storage',
  standard: 'Standard',
  frozen: 'Frozen',
  restored: 'Restored',
};

type ListedBucket = { bucketName: string; region?: string };

function matchesStorageFilter(
  record: BucketColdRecord | undefined,
  filter: Exclude<StorageFilter, 'all'>,
  now: number,
): boolean {
  const hasPolicy = record !== undefined && record.policies.length > 0;
  if (filter === 'standard') return !hasPolicy;
  if (filter === 'frozen') return hasPolicy;
  return record !== undefined && Object.values(record.restores).some((r) => now < r.expiresAt);
}

/** The buckets matching `filter`, re-filtered as any bucket's cold storage changes. */
export function useStorageFilteredBuckets<T extends ListedBucket>(
  buckets: T[],
  filter: StorageFilter,
): T[] {
  const { buckets: records } = useStore();
  if (filter === 'all') return buckets;
  const now = Date.now();
  return buckets.filter((b) =>
    matchesStorageFilter(records[bucketId(b.bucketName, b.region ?? S3_REGION)], filter, now),
  );
}

/** True when any of `buckets` has a freeze policy, which is when the filter is worth showing. */
export function useHasColdBuckets(buckets: ListedBucket[]): boolean {
  const { buckets: records } = useStore();
  return buckets.some(
    (b) => (records[bucketId(b.bucketName, b.region ?? S3_REGION)]?.policies.length ?? 0) > 0,
  );
}

// ---------------------------------------------------------------------------
// Eligibility and formatting
// ---------------------------------------------------------------------------

export type FreezeBlock = 'trial' | 'role';

/** Why this account cannot freeze, in the order the flow checks, or `null` when it can. */
export function useFreezeBlock(): FreezeBlock | null {
  const settings = usePrototypeSettings();
  // Freezing commits the org to a minimum term, so it sits with deletion: Owner and Admin.
  const mayFreeze = useHasPermission('buckets.delete') && !settings.memberRole;
  if (settings.trialAccount) return 'trial';
  if (!mayFreeze) return 'role';
  return null;
}

export const FREEZE_BLOCK_HINTS: Record<FreezeBlock, string> = {
  trial: 'Paid plans',
  role: 'Admins only',
};

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatUsd(amount: number): string {
  return usd.format(amount);
}

/**
 * "$2.99/TB-month". The console quotes only the per-TB rate, never a bucket's
 * total or what it saves, so every price in the flow goes through this.
 */
export function formatRate(pricePerTbMonth: number): string {
  return `${formatUsd(pricePerTbMonth)}/TB-month`;
}

/** A date for long spans; a time when the moment falls today, which short waits make common. */
export function formatMoment(timestamp: number): string {
  const date = new Date(timestamp);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "about 1 hour", or a seconds countdown under short waits. */
export function formatWaitLeft(readyAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((readyAt - now) / 1000));
  if (seconds < 120) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 55 ? 'about 1 hour' : `${minutes} minutes`;
}

/**
 * What a delete of these files does to cold storage, for its confirmation:
 * a restored copy goes with its frozen file, and a file inside its minimum
 * term still bills the rest. `undefined` when neither applies.
 */
export function describeColdDelete(states: ColdFile[], now: number): string | undefined {
  const one = states.length === 1;
  const restored = states.filter((s) => s.status === 'restored' || s.status === 'restoring');
  const inTerm = states.filter((s) => now < s.termEndsAt);
  const rate = formatRate(COLD_PRICE_PER_TB_MONTH);
  const copies =
    restored.length === 0
      ? ''
      : one
        ? 'Its restored copy is deleted too.'
        : 'Restored copies are deleted with their files.';
  const term =
    inTerm.length === 0
      ? ''
      : one
        ? `Its ${MIN_TERM_DAYS}-day frozen term runs until ${formatMoment(inTerm[0].termEndsAt)}, so the remaining days still bill at ${rate}.`
        : `${inTerm.length} of them are inside their ${MIN_TERM_DAYS}-day frozen term, so the remaining days still bill at ${rate}.`;
  const text = [copies, term].filter(Boolean).join(' ');
  return text || undefined;
}

/** Keeps a value while a dialog fades out after its prop goes `null`. */
export function useLastNonNull<T>(value: T | null): T | null {
  const last = useRef<T | null>(null);
  if (value !== null) last.current = value;
  return last.current;
}
