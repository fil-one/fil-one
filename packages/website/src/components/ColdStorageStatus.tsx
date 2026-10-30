import { SnowflakeIcon, ThermometerIcon } from '@phosphor-icons/react/dist/ssr';

import { Spinner } from './Spinner';
import {
  formatMoment,
  formatWaitLeft,
  type ColdStorageState,
} from '../lib/cold-storage-prototype.js';

/**
 * A bucket's cold storage state as a short, muted note: an icon and a few
 * words that sit in the grey metadata line under the bucket's name, or beside
 * its heading. Standard storage says nothing, since it is every bucket's
 * normal state. Frozen stays grey because a frozen bucket can do less, not
 * more; only the states with a wait or a deadline in progress take a colour.
 */
export function ColdStorageStatus({ state }: { state: ColdStorageState }) {
  const { icon, text } = describe(state);
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-zinc-500"
      data-testid="cold-storage-status"
    >
      {icon}
      {text}
    </span>
  );
}

function describe(state: ColdStorageState): { icon: React.ReactNode; text: string } {
  switch (state.status) {
    case 'frozen':
      return {
        icon: <SnowflakeIcon size={13} className="text-zinc-400" aria-hidden="true" />,
        text: 'Frozen',
      };
    case 'warming':
      return {
        // A spinner is the one loop the motion rules allow: this is real progress.
        icon: <Spinner ariaLabel="Restoring" size={11} colorClassName="text-amber-600" />,
        text: `Restoring, ready in ${formatWaitLeft(state.readyAt)}`,
      };
    case 'warm':
      return {
        icon: <ThermometerIcon size={13} className="text-amber-600" aria-hidden="true" />,
        text: `Restored until ${formatMoment(state.warmUntil)}`,
      };
    case 'unfreezing':
      return {
        icon: (
          <Spinner ariaLabel="Restoring permanently" size={11} colorClassName="text-zinc-400" />
        ),
        text: `Restoring permanently, ready in ${formatWaitLeft(state.readyAt)}`,
      };
  }
}

/** The state's icon alone, for places that word the state their own way. */
export function ColdStorageIcon({ state }: { state: ColdStorageState }) {
  return describe(state).icon;
}
