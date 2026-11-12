import { useState } from 'react';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Button } from './Button';
import { FileStorageBadge } from './ColdStorageStatus';
import { FreezeBucketDialog, type ColdStorageTarget } from './FreezeBucketDialog';
import { KeepInStandardDialog, type KeepInStandardTarget } from './KeepInStandardDialog';
import { RestoreFilesDialog, type RestoreTarget } from './RestoreFilesDialog';
import { useToast } from './Toast';
import {
  describeColdDelete,
  freezeAgain,
  isColdFile,
  isInMinimumTerm,
  isLockedFile,
  trackColdStorage,
  useColdFiles,
  useFreezeBlock,
  type FileColdState,
} from '../lib/cold-storage-prototype.js';

/**
 * The listing's entry for the version on screen: the one asked for, else the
 * latest. Unversioned buckets list every object with an empty version id.
 */
function findShownVersion(
  versions: S3ObjectVersion[],
  versionId: string | undefined,
): S3ObjectVersion | undefined {
  return versionId
    ? versions.find((v) => v.versionId === versionId)
    : versions.find((v) => v.isLatest);
}

function ColdStorageAction({
  state,
  onFreeze,
  onRestore,
  onKeep,
  onFreezeAgain,
}: {
  state: FileColdState;
  /** Absent for an account that can't freeze, or a file that can't. */
  onFreeze?: () => void;
  onRestore: () => void;
  onKeep: () => void;
  onFreezeAgain: () => void;
}) {
  switch (state.status) {
    case 'standard':
      return onFreeze ? (
        <Button id="object-freeze-button" variant="tertiary" size="sm" onClick={onFreeze}>
          Freeze
        </Button>
      ) : null;
    case 'frozen':
      return (
        <Button id="object-restore-button" variant="tertiary" size="sm" onClick={onRestore}>
          Restore
        </Button>
      );
    case 'restored':
      return (
        <div className="flex gap-2">
          <Button id="object-extend-restore-button" variant="ghost" size="sm" onClick={onRestore}>
            Add days
          </Button>
          <Button id="object-keep-standard-button" variant="tertiary" size="sm" onClick={onKeep}>
            Unfreeze
          </Button>
        </div>
      );
    case 'kept':
      return (
        <Button
          id="object-freeze-again-button"
          variant="tertiary"
          size="sm"
          onClick={onFreezeAgain}
        >
          Freeze again
        </Button>
      );
    default:
      return null;
  }
}

/**
 * Cold storage prototype (FIL-1608) on the object page: the file's storage
 * with the action it calls for, why download and share are off while it is
 * frozen, what deleting it would still bill, and a way to freeze it. Without
 * the file in the cached listing, everything is `undefined`.
 */
export function useObjectColdStorage({
  bucketName,
  region,
  versionId,
  objectVersions,
}: {
  bucketName: string;
  region: S3Region;
  versionId: string | undefined;
  /** This object's versions from the cached bucket listing. */
  objectVersions: S3ObjectVersion[];
}) {
  const cold = useColdFiles(bucketName, region);
  const { toast } = useToast();
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [keepTarget, setKeepTarget] = useState<KeepInStandardTarget | null>(null);
  const version = findShownVersion(objectVersions, versionId);
  const freezeBlock = useFreezeBlock();
  const [freezeTarget, setFreezeTarget] = useState<ColdStorageTarget | null>(null);
  const state = version ? cold.getState(version) : undefined;
  const canFreeze =
    freezeBlock === null &&
    version?.isLatest === true &&
    state?.status === 'standard' &&
    !state.belowMinimum;

  const overlays = (
    <>
      <FreezeBucketDialog target={freezeTarget} onClose={() => setFreezeTarget(null)} />
      <RestoreFilesDialog target={restoreTarget} onClose={() => setRestoreTarget(null)} />
      <KeepInStandardDialog target={keepTarget} onClose={() => setKeepTarget(null)} />
    </>
  );
  if (!state || !version) return { overlays };

  const deleteCharge = isColdFile(state) ? describeColdDelete([state], cold.now) : undefined;

  return {
    /** Frozen or restoring: nothing to download or share until the restore finishes. */
    locked: isLockedFile(state),
    deleteCharge,
    storageRow: (
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 py-1">
        <span className="text-sm text-(--color-paragraph-text-subtle)">Storage</span>
        <div className="flex items-center gap-3">
          <FileStorageBadge state={state} now={cold.now} />
          <ColdStorageAction
            state={state}
            onFreeze={
              canFreeze
                ? () => setFreezeTarget({ bucketName, region, keys: [version.key] })
                : undefined
            }
            onRestore={() =>
              setRestoreTarget({
                bucketName,
                region,
                scopes: [{ id: 'file', label: version.key, versions: [version] }],
                extend: state.status === 'restored',
              })
            }
            onKeep={() =>
              setKeepTarget({
                bucketName,
                region,
                keys: [version.key],
                inTermCount: isColdFile(state) && isInMinimumTerm(state, cold.now) ? 1 : 0,
              })
            }
            onFreezeAgain={() => {
              freezeAgain(bucketName, region, [version.key]);
              trackColdStorage('frozen again');
              toast.success('Freezing scheduled. The file freezes at the next daily run.');
            }}
          />
        </div>
      </div>
    ),
    overlays,
  };
}
