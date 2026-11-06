import { ClockIcon, SnowflakeIcon, ThermometerIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge, type BadgeColor, type BadgeStrength } from './Badge';
import { Spinner } from './Spinner';
import {
  MIN_TERM_DAYS,
  formatMoment,
  formatWaitLeft,
  type BucketColdSummary,
  type FileColdState,
} from '../lib/cold-storage-prototype.js';

interface BadgeContent {
  color: BadgeColor;
  strength: BadgeStrength;
  icon: React.ReactNode;
  text: string;
  detail: string;
}

function describeFile(state: FileColdState, now: number): BadgeContent | null {
  switch (state.status) {
    case 'standard':
      return null;
    case 'kept':
      return {
        color: 'grey',
        strength: 'subtle',
        icon: null,
        text: 'Unfrozen',
        detail:
          'Back in standard storage for good. The daily run skips it until you freeze it again.',
      };
    case 'scheduled':
      return {
        color: 'grey',
        strength: 'subtle',
        icon: <ClockIcon size={11} className="text-zinc-500" aria-hidden="true" />,
        text: 'Freezing scheduled',
        detail: `Freezes at the next daily run, ${formatMoment(state.freezesAt)}. Until then it works as usual.`,
      };
    case 'frozen':
      return {
        color: 'blue',
        strength: 'strong',
        icon: <SnowflakeIcon size={11} className="text-brand-600" aria-hidden="true" />,
        text: 'Frozen',
        detail: `Restore it to download or share. Its ${MIN_TERM_DAYS}-day term ends ${formatMoment(state.termEndsAt)}.`,
      };
    case 'restoring':
      return {
        color: 'amber',
        strength: 'subtle',
        icon: <Spinner ariaLabel="Restoring" size={9} colorClassName="text-amber-600" />,
        text: 'Restoring',
        detail: `Downloads work in ${formatWaitLeft(state.readyAt, now)}. The frozen copy stays as it is.`,
      };
    case 'restored':
      return {
        color: 'amber',
        strength: 'subtle',
        icon: <ThermometerIcon size={11} className="text-amber-600" aria-hidden="true" />,
        text: 'Restored',
        detail: `Downloads work until ${formatMoment(state.expiresAt)}. After that the copy is deleted and the file stays frozen.`,
      };
  }
}

/**
 * A file's storage in the Storage column and on the object page. Standard is
 * every file's normal state, so it is plain text; only a state that changes
 * what the file can do takes a pill, with what it means in the tooltip.
 */
export function FileStorageBadge({ state, now }: { state: FileColdState; now: number }) {
  const content = describeFile(state, now);
  if (!content) {
    return (
      <span
        className="text-zinc-500"
        title={
          state.status === 'standard' && state.belowMinimum
            ? 'Files under 128 KB stay in Standard'
            : undefined
        }
      >
        Standard
      </span>
    );
  }
  return (
    <Badge
      color={content.color}
      strength={content.strength}
      size="xs"
      description={content.detail}
      className="shrink-0 whitespace-nowrap"
      data-testid="file-storage-badge"
    >
      {content.icon}
      {content.text}
    </Badge>
  );
}

/** "Files in 2025/ and 3 single files", for a bucket frozen in parts. */
export function describeCoverage(summary: BucketColdSummary): string {
  const parts = [
    ...(summary.prefixes.length > 0 ? [`Files in ${summary.prefixes.join(', ')}`] : []),
    ...(summary.fileCount > 0
      ? [`${summary.fileCount} single ${summary.fileCount === 1 ? 'file' : 'files'}`]
      : []),
  ];
  return parts.join(' and ');
}

function describeBucket(summary: BucketColdSummary): BadgeContent {
  if (summary.scheduled) {
    return {
      color: 'grey',
      strength: 'subtle',
      icon: <ClockIcon size={11} className="text-zinc-500" aria-hidden="true" />,
      text: 'Freezing scheduled',
      detail: `Files freeze at the next daily run, ${formatMoment(summary.firstRunAt)}.`,
    };
  }
  const restores =
    summary.activeRestores > 0
      ? ` ${summary.activeRestores} ${summary.activeRestores === 1 ? 'file has' : 'files have'} a restored copy.`
      : '';
  return summary.scope === 'bucket'
    ? {
        color: 'blue',
        strength: 'strong',
        icon: <SnowflakeIcon size={11} className="text-brand-600" aria-hidden="true" />,
        text: 'Frozen',
        detail: `Files freeze at each daily run, new uploads included. Files under 128 KB stay in Standard.${restores}`,
      }
    : {
        color: 'blue',
        strength: 'subtle',
        icon: <SnowflakeIcon size={11} className="text-brand-600" aria-hidden="true" />,
        text: 'Partly frozen',
        detail: `${describeCoverage(summary)} freeze at each daily run.${restores}`,
      };
}

/**
 * A bucket's freeze policy as a pill beside its name in the Buckets table.
 * Freezing happens file by file, so the pill says what the policy covers:
 * the whole bucket, some folders, or nothing yet until the first daily run.
 */
export function ColdStorageBadge({ summary }: { summary: BucketColdSummary }) {
  const { color, strength, icon, text, detail } = describeBucket(summary);
  return (
    <Badge
      color={color}
      strength={strength}
      size="xs"
      description={detail}
      // The pill is 20px tall and a table row's name line 17.5px; pulling it
      // out of the line's height keeps cold rows the same height as their
      // neighbours.
      // `cold-storage-badge` is the hook the freeze animation in cold-storage.css targets.
      className="cold-storage-badge -my-0.5 shrink-0"
      data-testid="cold-storage-badge"
    >
      {icon}
      {text}
    </Badge>
  );
}
