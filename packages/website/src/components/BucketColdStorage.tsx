import { useState } from 'react';
import { SnowflakeIcon, ThermometerIcon } from '@phosphor-icons/react/dist/ssr';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import type { BucketAction } from './BucketActionMenu';
import { ColdStoragePrototypeControls } from './ColdStoragePrototypeControls';
import { useToast } from './Toast';
import { FreezeBucketDialog, type ColdStorageTarget } from './FreezeBucketDialog';
import { KeepInStandardDialog, type KeepInStandardTarget } from './KeepInStandardDialog';
import { RestoreProgress } from './RestoreProgress';
import { RestoreFilesDialog, type RestoreScope, type RestoreTarget } from './RestoreFilesDialog';
import type { ObjectColdStorage } from './ObjectBrowserRows';
import {
  FREEZE_BLOCK_HINTS,
  describeColdDelete,
  freezeAgain,
  isColdFile,
  isInMinimumTerm,
  trackColdStorage,
  useColdFiles,
  useFreezeBlock,
  type ColdFile,
  type ColdFiles,
} from '../lib/cold-storage-prototype.js';
import { useCachedListing } from '../lib/use-cached-listing.js';
import {
  EMPTY_COLD_RECORD,
  getFolderColdState,
  getJobProgress,
  isFilePolicy,
} from '../lib/cold-storage-files.js';

function getColdStates(
  versions: S3ObjectVersion[],
  cold: ColdFiles,
): { version: S3ObjectVersion; state: ColdFile }[] {
  return versions.flatMap((version) => {
    const state = cold.getState(version);
    return isColdFile(state) ? [{ version, state }] : [];
  });
}

/**
 * The scopes a restore can cover, narrowest first: what was asked for, the
 * folder being browsed, and the whole bucket. A scope that holds no frozen
 * file, or the same files as a narrower one, is left out.
 */
function buildRestoreScopes(
  requested: RestoreScope | null,
  allVersions: S3ObjectVersion[],
  cold: ColdFiles,
  currentPrefix: string,
): RestoreScope[] {
  const coldVersions = getColdStates(allVersions, cold).map(({ version }) => version);
  const candidates = [
    requested,
    currentPrefix
      ? {
          id: 'folder',
          label: `Everything in ${currentPrefix}`,
          versions: coldVersions.filter((v) => v.key.startsWith(currentPrefix)),
        }
      : null,
    { id: 'bucket', label: 'The whole bucket', versions: coldVersions },
  ];
  const scopes: RestoreScope[] = [];
  for (const scope of candidates) {
    if (!scope || scope.versions.length === 0) continue;
    if (scopes.some((s) => s.versions.length === scope.versions.length)) continue;
    scopes.push(scope);
  }
  return scopes;
}

function describeDeleteCharge(versions: S3ObjectVersion[], cold: ColdFiles): string | undefined {
  const states = getColdStates(versions, cold).map(({ state }) => state);
  return describeColdDelete(states, cold.now);
}

function describeSelection(versions: S3ObjectVersion[]): string {
  if (versions.length === 1) return versions[0].key.split('/').at(-1) ?? versions[0].key;
  return `The ${versions.length} selected files`;
}

/**
 * Everything the bucket page shows for cold storage (FIL-1608 prototype), kept
 * out of the page so the page stays about the bucket. Freezing is per file:
 * the bucket holds freeze policies, and each file in the listing has a state
 * of its own. The page places each piece; this hook owns the dialogs.
 */
export function useBucketColdStorage(bucketName: string, region: S3Region, currentPrefix: string) {
  // The listing the page itself loaded: same query, read from the cache.
  const listing = useCachedListing(bucketName, region);
  const versions = listing.versions ?? [];
  const cold = useColdFiles(bucketName, region);
  const { toast } = useToast();
  const freezeBlock = useFreezeBlock();
  const [freezeTarget, setFreezeTarget] = useState<ColdStorageTarget | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [keepTarget, setKeepTarget] = useState<KeepInStandardTarget | null>(null);

  const openRestore = (requested: RestoreScope | null) => {
    trackColdStorage('restore opened', { scope: requested?.id ?? 'bucket' });
    const scopes = buildRestoreScopes(requested, versions, cold, currentPrefix);
    // Asked for files that all have a copy already: this adds days to them.
    const extend =
      requested !== null &&
      requested.versions.length > 0 &&
      requested.versions.every((v) => cold.getState(v).status === 'restored');
    if (scopes.length > 0) {
      setRestoreTarget({
        bucketName,
        region,
        scopes: extend ? scopes.slice(0, 1) : scopes,
        extend,
      });
    }
  };

  // Latest versions by key, so a job's files are counted by their current state.
  const stateByKey = new Map(
    versions.filter((v) => v.isLatest).map((v) => [v.key, cold.getState(v)] as const),
  );
  const activeJobs = (cold.record?.restoreJobs ?? [])
    .map((job) => ({ job, progress: getJobProgress(job, (key) => stateByKey.get(key)) }))
    .filter(({ progress }) => progress.ready < progress.total);

  const objectColdStorage: ObjectColdStorage = {
    showColumn: cold.record !== null,
    restoreProgress: <RestoreProgress jobs={activeJobs} />,
    getState: cold.getState,
    getFolderState: (prefix) =>
      getFolderColdState(
        cold.record ?? EMPTY_COLD_RECORD,
        { prefix, versions },
        cold.now,
        cold.clock,
      ),
    now: cold.now,
    onFreeze:
      freezeBlock === null
        ? (selected) => setFreezeTarget({ bucketName, region, keys: selected.map((v) => v.key) })
        : undefined,
    onRestore: (selected) =>
      openRestore({
        id: 'selection',
        label: describeSelection(selected),
        versions: getColdStates(selected, cold).map(({ version }) => version),
      }),
    onKeepInStandard: (selected) => {
      const restored = getColdStates(selected, cold).filter(
        ({ state }) => state.status === 'restored',
      );
      setKeepTarget({
        bucketName,
        region,
        keys: restored.map(({ version }) => version.key),
        inTermCount: restored.filter(({ state }) => isInMinimumTerm(state, cold.now)).length,
      });
    },
    onFreezeAgain:
      freezeBlock === null
        ? (selected) => {
            freezeAgain(
              bucketName,
              region,
              selected.map((v) => v.key),
            );
            trackColdStorage('frozen again');
            toast.success('Freezing scheduled for the next daily run.');
          }
        : undefined,
    describeDeleteCharge: (selected) => describeDeleteCharge(selected, cold),
  };

  const hasWholeBucketPolicy =
    cold.record?.policies.some((p) => !isFilePolicy(p) && p.prefix === '') ?? false;
  const hasColdFiles = versions.some((v) => isColdFile(cold.getState(v)));

  return {
    /** Each file's storage and the cold storage actions on the object table. */
    objectColdStorage,
    /**
     * Freeze files, beside the header's other actions. Gone once the whole
     * bucket has a rule; a role that can't freeze never sees it, and a trial
     * sees it disabled with the reason.
     */
    /**
     * The header "…" menu's cold storage items: Freeze files, until the whole
     * bucket has a rule, and Restore files, while any file is frozen or
     * restored. Restoring is mostly done from the files themselves, a row or
     * a selection, so the whole-bucket restore is a rare step that sits here.
     * A role that can't freeze never sees Freeze files; a trial sees it disabled.
     */
    menuActions: [
      ...(!hasWholeBucketPolicy && freezeBlock !== 'role'
        ? [
            {
              label: 'Freeze all files',
              icon: SnowflakeIcon,
              disabled: freezeBlock !== null,
              hint: freezeBlock ? FREEZE_BLOCK_HINTS[freezeBlock] : undefined,
              onSelect: () => {
                trackColdStorage('freeze started');
                setFreezeTarget({ bucketName, region, prefix: currentPrefix });
              },
            },
          ]
        : []),
      ...(hasColdFiles
        ? [{ label: 'Restore files', icon: ThermometerIcon, onSelect: () => openRestore(null) }]
        : []),
    ] satisfies BucketAction[],
    /** Restores from the whole bucket, for the title badge and the details panel; absent while nothing is frozen. */
    onRestoreFiles: hasColdFiles ? () => openRestore(null) : undefined,
    overlays: (
      <>
        <FreezeBucketDialog target={freezeTarget} onClose={() => setFreezeTarget(null)} />
        <RestoreFilesDialog target={restoreTarget} onClose={() => setRestoreTarget(null)} />
        <KeepInStandardDialog target={keepTarget} onClose={() => setKeepTarget(null)} />
        <ColdStoragePrototypeControls />
      </>
    ),
  };
}
