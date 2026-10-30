import { SnowflakeIcon, ThermometerIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge, type BadgeColor, type BadgeStrength } from './Badge';
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
  }
}

/** The state's icon alone, for places that word the state their own way. */
export function ColdStorageIcon({ state }: { state: ColdStorageState }) {
  return describe(state).icon;
}

/**
 * The bucket's cold storage state as a pill beside its name in the Buckets
 * table: the tint marks a frozen row, the pill says what it is. Frozen is the
 * strong blue, since the subtle one is the row's own wash and would vanish on
 * it; the timing of a restore sits in the tooltip.
 */
export function ColdStorageBadge({ state }: { state: ColdStorageState }) {
  const { color, strength, icon, text, detail } = describeBadge(state);
  return (
    <Badge
      color={color}
      strength={strength}
      size="xs"
      description={detail}
      // The pill is 20px tall and the name line 17.5px; pulling it out of the
      // line's height keeps cold rows the same height as their neighbours.
      className="-my-0.5 shrink-0"
      data-testid="cold-storage-badge"
    >
      {icon}
      {text}
    </Badge>
  );
}

function describeBadge(state: ColdStorageState): {
  color: BadgeColor;
  strength: BadgeStrength;
  icon: React.ReactNode;
  text: string;
  detail: string;
} {
  switch (state.status) {
    case 'frozen':
      return {
        color: 'blue',
        strength: 'strong',
        icon: <SnowflakeIcon size={11} className="text-brand-600" aria-hidden="true" />,
        text: 'Frozen',
        detail: 'Objects are listed but can’t be downloaded until you restore the bucket.',
      };
    case 'warming':
      return {
        color: 'amber',
        strength: 'subtle',
        icon: <Spinner ariaLabel="Restoring" size={9} colorClassName="text-amber-600" />,
        text: 'Restoring',
        detail: `Downloads work in ${formatWaitLeft(state.readyAt)}.`,
      };
    case 'warm':
      return {
        color: 'amber',
        strength: 'subtle',
        icon: <ThermometerIcon size={11} className="text-amber-600" aria-hidden="true" />,
        text: 'Restored',
        detail: `Downloads work until ${formatMoment(state.warmUntil)}.`,
      };
  }
}
