import { useState } from 'react';
import {
  ArrowCounterClockwiseIcon,
  SnowflakeIcon,
  ThermometerIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { S3Region } from '@filone/shared';

import { BucketActionMenu } from './BucketActionMenu';
import { Button } from './Button';
import { ExtendRestoreDialog } from './ExtendRestoreDialog';
import { Tooltip } from './Tooltip';
import { useToast } from './Toast';
import { ColdStorageIcon } from './ColdStorageStatus';
import { ColdStoragePrototypeControls } from './ColdStoragePrototypeControls';
import { FreezeBucketDialog, type ColdStorageTarget } from './FreezeBucketDialog';
import {
  GetDataBackDialog,
  type GetDataBackChoice,
  type GetDataBackTarget,
} from './GetDataBackDialog';
import {
  extendWarm,
  formatMoment,
  formatWaitLeft,
  useBucketBytes,
  useColdStorage,
  useFreezeBlock,
  type ColdStorageState,
  type WarmState,
  trackColdStorage,
} from '../lib/cold-storage-prototype.js';

type DownloadObject = (key: string, versionId?: string) => Promise<void>;

/**
 * Everything the bucket page shows for cold storage (FIL-1608 prototype), kept
 * out of the page so the page stays about the bucket. The page places each
 * piece; this hook owns the state and the dialogs behind them.
 */
export function useBucketColdStorage(
  bucketName: string,
  region: S3Region,
  downloadObject: DownloadObject,
) {
  const state = useColdStorage(bucketName, region);
  const freezeBlock = useFreezeBlock(useBucketBytes(bucketName, region));
  const [freezeTarget, setFreezeTarget] = useState<ColdStorageTarget | null>(null);
  const [getBackTarget, setGetBackTarget] = useState<GetDataBackTarget | null>(null);
  const [extendTarget, setExtendTarget] = useState<WarmState | null>(null);

  const openGetDataBack = (preselect: GetDataBackChoice) =>
    setGetBackTarget({ bucketName, region, preselect });

  // Downloads work only while warm. Anywhere else a download click is the
  // moment someone needs the data, so it opens Get data back with warming chosen.
  const downloadsBlocked = state !== null && state.status !== 'warm';
  const guardedDownload: DownloadObject = downloadsBlocked
    ? () => {
        trackColdStorage('frozen file clicked');
        if (state.status === 'frozen') openGetDataBack('warm');
        return Promise.resolve();
      }
    : downloadObject;

  const { toast } = useToast();
  const actions = (
    <HeaderActions
      state={state}
      canFreeze={freezeBlock === null}
      onFreeze={() => {
        trackColdStorage('freeze started');
        setFreezeTarget({ bucketName, region });
      }}
      onGetDataBack={openGetDataBack}
      onExtend={(warm) => {
        trackColdStorage('extend opened');
        setExtendTarget(warm);
      }}
    />
  );

  return {
    state,
    /** Frozen buckets are read-only in every state, warm included, so uploads and emptying go. */
    readOnly: state !== null,
    downloadObject: guardedDownload,
    actions,
    overlays: (
      <>
        <FreezeBucketDialog target={freezeTarget} onClose={() => setFreezeTarget(null)} />
        <GetDataBackDialog target={getBackTarget} onClose={() => setGetBackTarget(null)} />
        <ExtendRestoreDialog
          state={extendTarget}
          bucketName={bucketName}
          onClose={() => setExtendTarget(null)}
          onConfirm={(warm) => {
            extendWarm(bucketName, region, warm);
            trackColdStorage('warm extended', { extensions: String(warm.extensions + 1) });
            toast.success('Restored for 2 more weeks');
          }}
        />
        <ColdStoragePrototypeControls />
      </>
    ),
  };
}

/**
 * The cold storage controls beside the bucket heading. The action the bucket's
 * state calls for is a visible button (Restore while frozen, Extend while
 * restored); the rarer way out sits in the overflow menu. A bucket waiting on
 * a restore has nothing to do, and one that can't be frozen gets no menu,
 * since a menu holding only a disabled item is a dead end.
 */
function HeaderActions({
  state,
  canFreeze,
  onFreeze,
  onGetDataBack,
  onExtend,
}: {
  state: ColdStorageState | null;
  canFreeze: boolean;
  onFreeze: () => void;
  onGetDataBack: (preselect: GetDataBackChoice) => void;
  onExtend: (state: WarmState) => void;
}) {
  if (state === null) {
    return canFreeze ? (
      <BucketActionMenu
        actions={[{ label: 'Freeze bucket', icon: SnowflakeIcon, onSelect: onFreeze }]}
      />
    ) : null;
  }
  if (state.status === 'frozen') {
    return (
      <Button
        id="cold-storage-restore-button"
        variant="ghost"
        size="sm"
        icon={ThermometerIcon}
        onClick={() => onGetDataBack('warm')}
      >
        Restore
      </Button>
    );
  }
  if (state.status === 'warm') {
    return (
      <>
        <Button
          id="cold-storage-extend-button"
          variant="ghost"
          size="sm"
          onClick={() => onExtend(state)}
        >
          Extend 2 weeks
        </Button>
        <BucketActionMenu
          actions={[
            {
              label: 'Restore permanently',
              icon: ArrowCounterClockwiseIcon,
              onSelect: () => onGetDataBack('unfreeze'),
            },
          ]}
        />
      </>
    );
  }
  return null;
}

/** After this many extensions in a row, staying restored costs more than restoring permanently. */
const EXTENSIONS_BEFORE_NUDGE = 2;

/**
 * The bucket's cold storage state as one item in the grey line under its
 * heading, beside region and size: an icon and a short phrase, with what it
 * means for the objects and the bill in a tooltip. One place on the page says
 * the bucket is frozen, and the detail is there for whoever wants it.
 */
export function ColdStorageMeta({ state }: { state: ColdStorageState }) {
  const { text, detail } = describeMeta(state);
  return (
    <Tooltip content={detail} side="bottom" focusable label={`${text}. ${detail}`}>
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
        <span className="underline decoration-zinc-300 decoration-dotted underline-offset-4">
          {text}
        </span>
        <ColdStorageIcon state={state} />
      </span>
    </Tooltip>
  );
}

function describeMeta(state: ColdStorageState): { text: string; detail: string } {
  if (state.status === 'frozen') {
    return {
      text: 'Frozen',
      detail: 'Objects are listed but can’t be downloaded or changed until you restore the bucket.',
    };
  }
  if (state.status === 'warm') {
    const until = formatMoment(state.warmUntil);
    const base = `Downloads work until ${until}. Then the restored copy is deleted and the bucket is frozen again.`;
    return {
      text: `Restored until ${until}`,
      detail:
        state.extensions >= EXTENSIONS_BEFORE_NUDGE
          ? `${base} You’ve extended twice, so restoring permanently would now cost less.`
          : base,
    };
  }
  const waiting = state.status === 'warming' ? 'Restoring' : 'Restoring permanently';
  return {
    text: `${waiting}, ready in ${formatWaitLeft(state.readyAt)}`,
    detail: 'You can’t download yet. We’ll email you when it’s ready.',
  };
}
