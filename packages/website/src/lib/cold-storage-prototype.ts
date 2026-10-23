// Prototype of cold storage (FIL-1608): freezing a bucket at $1.99/TB-month,
// warming it for two weeks, and unfreezing it permanently.
//
// Nothing here talks to the backend. The demand test fakes the feature while the
// data stays on disk, and this prototype goes one step further: each bucket's
// cold storage state lives in this browser's localStorage, so the flow can be
// clicked through against real buckets without any server change.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';

import { S3_REGION, type BucketAnalyticsResponse, type S3Region } from '@filone/shared';

import { queryKeys } from './query-client.js';
import { useHasPermission } from './use-permissions.js';

export const WARM_PRICE_PER_TB_MONTH = 5.99;
export const COLD_PRICE_PER_TB_MONTH = 1.99;
/** The minimum term is still undecided between 60 and 90 days. */
export const MIN_TERM_DAYS = 90;
export const WARM_MIN_DAYS = 14;
export const MIN_FREEZE_BYTES = 1e12;
/** Prices are per TB-month, so prorating counts a month as 30 days. */
const DAYS_PER_MONTH = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Most staging buckets hold a few MB, so the controls can make one of them Sam's
 * 70 TB archive: the bucket that can be frozen, beside real buckets that can't.
 */
const SIMULATED_BYTES = 70e12;

const STORAGE_KEY = 'filone:coldStoragePrototype';

interface ColdStateBase {
  frozenAt: number;
  termEndsAt: number;
  /** The bucket's size when it was frozen; every price for the frozen bucket uses it. */
  bytes: number;
}

export interface FrozenState extends ColdStateBase {
  status: 'frozen';
}

export interface WarmingState extends ColdStateBase {
  status: 'warming';
  readyAt: number;
}

export interface WarmState extends ColdStateBase {
  status: 'warm';
  warmUntil: number;
  extensions: number;
}

export interface UnfreezingState extends ColdStateBase {
  status: 'unfreezing';
  readyAt: number;
}

export type ColdStorageState = FrozenState | WarmingState | WarmState | UnfreezingState;

export interface PrototypeSettings {
  simulateLargeBucket: boolean;
  trialAccount: boolean;
  memberRole: boolean;
  shortWaits: boolean;
}

interface Store {
  buckets: Record<string, ColdStorageState>;
  settings: PrototypeSettings;
  announcementSeen: boolean;
  /** Which bucket stands in for the 70 TB archive, as `region/name`. */
  largeBucketId: string | null;
}

const DEFAULT_STORE: Store = {
  buckets: {},
  settings: {
    simulateLargeBucket: true,
    trialAccount: false,
    memberRole: false,
    shortWaits: true,
  },
  announcementSeen: false,
  largeBucketId: null,
};

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STORE;
    const parsed = JSON.parse(raw) as Partial<Store>;
    // States saved before sizes were recorded price at the 1 TB minimum.
    const buckets = Object.fromEntries(
      Object.entries(parsed.buckets ?? {}).map(([id, state]) => [
        id,
        { ...state, bytes: state.bytes ?? MIN_FREEZE_BYTES },
      ]),
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

/** One hour in the real flow; ten seconds with short waits on, so a demo can watch it finish. */
function waitMs(settings: PrototypeSettings) {
  return settings.shortWaits ? 10_000 : 60 * 60 * 1000;
}

/** Two weeks in the real flow; one minute with short waits on. */
function warmPeriodMs(settings: PrototypeSettings) {
  return settings.shortWaits ? 60_000 : WARM_MIN_DAYS * DAY_MS;
}

/**
 * Applies the transitions that happen on their own: a finished wait, and the
 * end of a warm period, which returns the bucket to frozen. Returns `null` once
 * an unfreeze completes, because the bucket is then ordinary storage again.
 */
/** What a bucket carries through every state change: when it froze and how big it was. */
function frozenFacts({ frozenAt, termEndsAt, bytes }: ColdStorageState): ColdStateBase {
  return { frozenAt, termEndsAt, bytes };
}

function resolveState(state: ColdStorageState, now: number): ColdStorageState | null {
  if (state.status === 'warming' && now >= state.readyAt) {
    return {
      ...frozenFacts(state),
      status: 'warm',
      extensions: 0,
      warmUntil: state.readyAt + warmPeriodMs(store.settings),
    };
  }
  if (state.status === 'warm' && now >= state.warmUntil) {
    return { ...frozenFacts(state), status: 'frozen' };
  }
  if (state.status === 'unfreezing' && now >= state.readyAt) return null;
  return state;
}

/** Re-renders every second while `active`, so countdowns move and transitions land. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : Date.now();
}

/** The bucket's cold storage state, or `null` for a bucket in standard storage. */
export function useColdStorage(bucketName: string, region: string): ColdStorageState | null {
  const { buckets } = useStore();
  const stored = buckets[bucketId(bucketName, region)] ?? null;
  const now = useNow(stored !== null && stored.status !== 'frozen');
  const resolved = stored && resolveState(stored, now);
  // Persisted once it happens, so every component reading this bucket agrees.
  useEffect(() => {
    if (resolved !== stored) setBucket(bucketName, region, resolved);
  }, [bucketName, region, resolved, stored]);
  return resolved;
}

function setBucket(bucketName: string, region: string, state: ColdStorageState | null) {
  const buckets = { ...store.buckets };
  if (state) buckets[bucketId(bucketName, region)] = state;
  else delete buckets[bucketId(bucketName, region)];
  writeStore({ ...store, buckets });
}

export function freezeBucket(bucketName: string, region: string, bytes: number) {
  const now = Date.now();
  setBucket(bucketName, region, {
    status: 'frozen',
    frozenAt: now,
    termEndsAt: now + MIN_TERM_DAYS * DAY_MS,
    bytes,
  });
}

export function warmBucket(bucketName: string, region: string, state: ColdStorageState) {
  setBucket(bucketName, region, {
    ...frozenFacts(state),
    status: 'warming',
    readyAt: Date.now() + waitMs(store.settings),
  });
}

export function extendWarm(bucketName: string, region: string, state: WarmState) {
  setBucket(bucketName, region, {
    ...state,
    warmUntil: state.warmUntil + warmPeriodMs(store.settings),
    extensions: state.extensions + 1,
  });
}

export function unfreezeBucket(bucketName: string, region: string, state: ColdStorageState) {
  setBucket(bucketName, region, {
    ...frozenFacts(state),
    status: 'unfreezing',
    readyAt: Date.now() + waitMs(store.settings),
  });
}

/** Deleting a frozen bucket ends its cold storage; the dialog shows what that costs first. */
export function forgetBucket(bucketName: string, region: string) {
  setBucket(bucketName, region, null);
}

export function usePrototypeSettings(): PrototypeSettings {
  return useStore().settings;
}

export function updatePrototypeSettings(patch: Partial<PrototypeSettings>) {
  writeStore({ ...store, settings: { ...store.settings, ...patch } });
}

export function resetPrototype() {
  writeStore({ ...DEFAULT_STORE, settings: store.settings, largeBucketId: store.largeBucketId });
}

export function setLargeBucket(bucketName: string, region: string) {
  writeStore({ ...store, largeBucketId: bucketId(bucketName, region) });
}

/** The name of the bucket standing in for the 70 TB archive, if one is chosen. */
export function useLargeBucketName(): string | null {
  const { largeBucketId } = useStore();
  return largeBucketId ? largeBucketId.slice(largeBucketId.indexOf('/') + 1) : null;
}

/**
 * Picks the 70 TB archive: the first bucket in eu-west-1, where the prototype
 * is demoed, or the first bucket of any region when none is there. Picks again
 * when the list changes (a delete, another org's buckets).
 */
export function useEnsureLargeBucket(buckets: { bucketName: string; region?: string }[]) {
  const { largeBucketId } = useStore();
  const pick = buckets.find((b) => (b.region ?? S3_REGION) === S3_REGION) ?? buckets.at(0);
  const pickId = pick ? bucketId(pick.bucketName, pick.region ?? S3_REGION) : null;
  useEffect(() => {
    if (pick && pickId !== largeBucketId) setLargeBucket(pick.bucketName, pick.region ?? S3_REGION);
  }, [pick, pickId, largeBucketId]);
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

// ---------------------------------------------------------------------------
// Size, eligibility and pricing
// ---------------------------------------------------------------------------

/**
 * The bucket's size from the analytics the Buckets table and the bucket page
 * already load. `skipToken` means this observer never fetches; it reads the shared cache entry
 * and re-renders when that entry fills in.
 */
export function useBucketBytes(bucketName: string, region: S3Region): number | undefined {
  const simulated = useSimulatedAnalytics(bucketName, region);
  const { data } = useQuery<BucketAnalyticsResponse>({
    queryKey: queryKeys.bucketAnalytics(bucketName, region),
    queryFn: skipToken,
  });
  return simulated?.bytesUsed ?? data?.bytesUsed;
}

/** A plausible object count for 70 TB of raw footage. */
const SIMULATED_OBJECT_COUNT = 18_420;

/**
 * The faked size and object count for the 70 TB stand-in, so the Buckets table
 * and the bucket page show the archive the flow describes. `null` for every
 * other bucket, which keeps showing its real analytics.
 */
export function useSimulatedAnalytics(
  bucketName: string,
  region: S3Region,
): Pick<BucketAnalyticsResponse, 'bytesUsed' | 'objectCount'> | null {
  const { simulateLargeBucket } = usePrototypeSettings();
  const { largeBucketId } = useStore();
  if (!simulateLargeBucket || largeBucketId !== bucketId(bucketName, region)) return null;
  return { bytesUsed: SIMULATED_BYTES, objectCount: SIMULATED_OBJECT_COUNT };
}

export type FreezeBlock = 'trial' | 'role' | 'size' | 'loading';

/** Why this bucket cannot be frozen, in the order the flow checks, or `null` when it can. */
export function useFreezeBlock(bytes: number | undefined): FreezeBlock | null {
  const settings = usePrototypeSettings();
  // Freezing commits the org to a minimum term, so it sits with deletion: Owner and Admin.
  const mayFreeze = useHasPermission('buckets.delete') && !settings.memberRole;
  if (settings.trialAccount) return 'trial';
  if (!mayFreeze) return 'role';
  if (bytes === undefined) return 'loading';
  if (bytes < MIN_FREEZE_BYTES) return 'size';
  return null;
}

export const FREEZE_BLOCK_HINTS: Record<FreezeBlock, string> = {
  trial: 'Paid plans',
  role: 'Admins only',
  size: 'Under 1 TB',
  loading: 'Checking size',
};

export function bytesToTb(bytes: number): number {
  return bytes / 1e12;
}

export function getMonthlyCost(bytes: number, pricePerTbMonth: number): number {
  return bytesToTb(bytes) * pricePerTbMonth;
}

/** Two weeks warm: half a month of standard storage, with its monthly minimum. */
export function getWarmPeriodCost(bytes: number): number {
  return floorToCents(getStandardMonthlyCost(bytes) * WARM_PERIOD_MONTHS);
}

/** Standard storage keeps its $5.99 monthly minimum, whatever the size. */
export const STANDARD_MONTHLY_MINIMUM = 5.99;

/** The 2-week warm minimum bills as half a month of standard storage. */
const WARM_PERIOD_MONTHS = 0.5;

/** What 2 weeks warm costs per TB, the figure the copy quotes: half of $5.99/TB-month. */
export function getWarmPeriodPricePerTb(): number {
  return floorToCents(WARM_PRICE_PER_TB_MONTH * WARM_PERIOD_MONTHS);
}

export function getStandardMonthlyCost(bytes: number): number {
  return Math.max(getMonthlyCost(bytes, WARM_PRICE_PER_TB_MONTH), STANDARD_MONTHLY_MINIMUM);
}

/** A frozen bucket bills at least the 1 TB it needed to freeze. */
export function getBillableBytes(bytes: number): number {
  return Math.max(bytes, MIN_FREEZE_BYTES);
}

/** Prorated amounts round down to the cent, so half of $5.99 is $2.99. */
function floorToCents(amount: number): number {
  return Math.floor(Math.round(amount * 1000) / 10) / 100;
}

/** What leaving cold storage before the minimum term ends costs: the cold rate for the days left. */
export function getRemainingTermCost(bytes: number, termEndsAt: number, now = Date.now()): number {
  return (
    getMonthlyCost(bytes, COLD_PRICE_PER_TB_MONTH) * (getDaysLeft(termEndsAt, now) / DAYS_PER_MONTH)
  );
}

export function getDaysLeft(termEndsAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((termEndsAt - now) / DAY_MS));
}

/** Whole terabytes, the way the prices are quoted. */
export function formatTb(bytes: number): string {
  return `${Math.round(bytesToTb(bytes)).toLocaleString()} TB`;
}

export function isInMinimumTerm(state: ColdStorageState, now = Date.now()): boolean {
  return now < state.termEndsAt;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatUsd(amount: number): string {
  return usd.format(amount);
}

/** A date for long spans; a time when the moment falls today, which short waits make common. */
export function formatMoment(timestamp: number): string {
  const date = new Date(timestamp);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Nov 6": the year adds nothing to a date a few weeks out. */
export function formatShortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "about 1 hour", or a seconds countdown under short waits. */
export function formatWaitLeft(readyAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((readyAt - now) / 1000));
  if (seconds < 120) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 55 ? 'about 1 hour' : `${minutes} minutes`;
}
