import {
  ArrowCounterClockwiseIcon,
  CalendarPlusIcon,
  SnowflakeIcon,
  ThermometerIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { S3ObjectVersion } from '@filone/shared';

import { Button } from './Button';
import type { RowAction } from './RowActionsMenu';
import { isColdFile, type FileColdState } from '../lib/cold-storage-prototype.js';

// The object browser's pieces for the cold storage prototype (FIL-1608), kept
// apart so the browser itself stays about listing and selecting objects.

/** Cold storage prototype (FIL-1608): each file's state and the actions on it. */
export interface ObjectColdStorage {
  /** Whether the bucket has any freeze rule, which is when the Storage column shows. */
  showColumn: boolean;
  /** Restores of several files still running, counted, shown above the table. */
  restoreProgress?: React.ReactNode;
  getState: (version: S3ObjectVersion) => FileColdState;
  now: number;
  /** Opens the freeze review for these files; absent for an account that can't freeze. */
  onFreeze?: (versions: S3ObjectVersion[]) => void;
  /** Opens the restore dialog over these files. */
  onRestore: (versions: S3ObjectVersion[]) => void;
  /** Opens the unfreeze confirmation over these files. */
  onKeepInStandard: (versions: S3ObjectVersion[]) => void;
  /** Freezes an unfrozen file again at the next daily run; absent for an account that can't. */
  onFreezeAgain?: (versions: S3ObjectVersion[]) => void;
  /** What deleting these versions still bills, for the delete confirmation; `undefined` when nothing. */
  describeDeleteCharge: (versions: S3ObjectVersion[]) => string | undefined;
}

/**
 * A file's cold storage actions beyond Restore, as the row's icons: more
 * days or unfreezing for a restored file, freezing for a Standard one, and
 * freezing again for an unfrozen one.
 */
export function getColdRowActions(
  version: S3ObjectVersion,
  state: FileColdState,
  cold: ObjectColdStorage,
): RowAction[] {
  const { onFreeze, onFreezeAgain } = cold;
  switch (state.status) {
    case 'restored':
      return [
        { label: 'Add days', icon: CalendarPlusIcon, onSelect: () => cold.onRestore([version]) },
        {
          label: 'Unfreeze',
          icon: ArrowCounterClockwiseIcon,
          onSelect: () => cold.onKeepInStandard([version]),
        },
      ];
    case 'standard':
      return onFreeze && version.isLatest && !version.isDeleteMarker && !state.belowMinimum
        ? [{ label: 'Freeze', icon: SnowflakeIcon, onSelect: () => onFreeze([version]) }]
        : [];
    case 'kept':
      return onFreezeAgain
        ? [{ label: 'Freeze again', icon: SnowflakeIcon, onSelect: () => onFreezeAgain([version]) }]
        : [];
    default:
      return [];
  }
}

/** A selected or delete-confirmed row; unversioned rows carry no version id. */
export type SelectionTarget = { key: string; versionId?: string };

/** Cold storage prototype: the listing entries behind selection or delete targets. */
export function findVersions(
  versions: S3ObjectVersion[],
  targets: SelectionTarget[],
): S3ObjectVersion[] {
  return targets.flatMap((target) => {
    const found = versions.find(
      (v) => v.key === target.key && v.versionId === (target.versionId ?? ''),
    );
    return found ? [found] : [];
  });
}

/**
 * Cold storage prototype: the bulk bar's Freeze, when the selection holds
 * files that can freeze, Restore, when it holds frozen or restored ones, and
 * Unfreeze, when it holds restored ones.
 */
export function ColdBulkActions({
  coldStorage,
  selected,
}: {
  coldStorage: ObjectColdStorage;
  selected: S3ObjectVersion[];
}) {
  const cold = selected.filter((v) => isColdFile(coldStorage.getState(v)));
  // Latest versions in plain Standard, at or over 128 KB, with no rule yet.
  const freezable = selected.filter((v) => {
    const state = coldStorage.getState(v);
    return v.isLatest && !v.isDeleteMarker && state.status === 'standard' && !state.belowMinimum;
  });
  const onFreeze = coldStorage.onFreeze;
  const restored = selected.filter((v) => coldStorage.getState(v).status === 'restored');
  return (
    <>
      {restored.length > 0 && (
        <Button
          id="object-browser-keep-standard-button"
          variant="ghost"
          size="sm"
          onClick={() => coldStorage.onKeepInStandard(restored)}
        >
          Unfreeze
        </Button>
      )}
      {onFreeze && freezable.length > 0 && (
        <Button
          id="object-browser-freeze-button"
          variant="ghost"
          size="sm"
          icon={SnowflakeIcon}
          onClick={() => onFreeze(freezable)}
        >
          Freeze
        </Button>
      )}
      {cold.length > 0 && (
        <Button
          id="object-browser-restore-button"
          variant="ghost"
          size="sm"
          icon={ThermometerIcon}
          onClick={() => coldStorage.onRestore(cold)}
        >
          Restore
        </Button>
      )}
    </>
  );
}
