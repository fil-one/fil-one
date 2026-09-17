import { formatBytes } from '@filone/shared';
import type { Subscription } from '@filone/shared';

import { Badge } from '../Badge';
import { Card } from '../Card';
import { ProgressBar } from '../ProgressBar';
import { cn } from '../../lib/utils.js';
import {
  billingPeriodRange,
  costDisclosure,
  daysLeftLabel,
  formatCents,
  usageLimits,
} from '../../lib/billing-view.js';

export type UsageCardProps = {
  subscription: Subscription;
  storageBytesUsed: number;
  egressBytesUsed: number;
};

type StatEmphasis = 'lead' | 'supporting';

interface Stat {
  label: string;
  /** A word qualifying the label, such as a measure that is not billed. */
  note?: string;
  value: string;
  valueTestId?: string;
  /** A line under the figure, for the exception that needs explaining. */
  caption?: string;
  emphasis: StatEmphasis;
  /** The allowance this figure is drawn against, when it has one. */
  limit?: number | null;
  used?: number;
  meterLabel?: string;
}

/**
 * One size and one weight for every figure, so the row is a set. What separates
 * the total is depth: near-black against the grey of the measures it is worked
 * out from.
 *
 * Not weight, because `font-medium` is the console's ceiling outside a page
 * title (DESIGN.md rule 5), and not size, because ranking these by size is what
 * turned the measures into footnotes two revisions ago. Depth does the same job
 * and costs nothing: `zinc-950` on white is 17:1 against `zinc-600`'s 6.4:1, and
 * the total is last, after a divider, which the eye already reads as an answer.
 */
const emphasisStyles: Record<StatEmphasis, string> = {
  lead: 'font-medium text-zinc-950',
  supporting: 'font-medium text-zinc-600',
};

/**
 * What this organization is using, and what it is adding up to.
 *
 * Read as arithmetic: the measures first, the total last, divided from each
 * other and spanning the card. The total sits where a total belongs rather than
 * leading, and carries its weight instead of its size.
 *
 * Bars only against a real allowance. A trial has one, so a bar under its tile
 * answers "how much is left"; a paid plan does not, and the version of this card
 * that drew one anyway was filling it against a limit taken from the trial's
 * constants.
 *
 * Every figure comes from `billing-view`, which states a rate only where Stripe
 * reported one. Where it did not, the total is left to Stripe rather than
 * guessed at.
 */
export function UsageCard({ subscription, storageBytesUsed, egressBytesUsed }: UsageCardProps) {
  const limits = usageLimits(subscription.status);
  const cost = costDisclosure(subscription, storageBytesUsed);
  // Only a trial has allowances to fill, which is also the only state where
  // egress is capped rather than simply free.
  const onTrial = limits.storageLimitBytes !== null;
  const period = billingPeriodRange(subscription);
  const daysLeft = daysLeftLabel(subscription);

  const stats: Stat[] = [
    {
      label: 'Storage',
      value: formatBytes(storageBytesUsed),
      emphasis: 'supporting',
      limit: limits.storageLimitBytes,
      used: storageBytesUsed,
      meterLabel: 'Storage usage',
    },
    {
      label: 'Egress',
      // Beside the label, where it qualifies what the figure below costs rather
      // than looking like part of the figure itself.
      note: onTrial ? undefined : 'Free',
      value: formatBytes(egressBytesUsed),
      emphasis: 'supporting',
      limit: limits.egressLimitBytes,
      used: egressBytesUsed,
      meterLabel: 'Egress usage',
    },
  ];

  // A trial bills nothing, so it has no total to end on.
  if (cost.kind === 'estimate') {
    stats.push({
      label: 'Estimated total',
      value: formatCents(cost.cents),
      valueTestId: 'estimated-cost',
      emphasis: 'lead',
      caption: cost.minimumApplied ? 'Your monthly minimum' : undefined,
    });
  }

  return (
    <Card>
      <div className="flex flex-col gap-5">
        {/* The dates sit with the title, not opposite it: they say which period
            the figures below cover, which is part of naming the card. The
            countdown goes to the far edge, where a changing value belongs. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-sm font-medium text-zinc-900">
              {onTrial ? 'Usage during your trial' : 'Usage this billing period'}
            </h3>
            {period && (
              <p className="text-xs text-zinc-500 tabular-nums" data-testid="billing-period">
                {period}
              </p>
            )}
          </div>
          {daysLeft && (
            <Badge color="grey" size="sm" weight="medium">
              {daysLeft}
            </Badge>
          )}
        </div>

        {/* Equal columns spanning the card, hairline-divided. The dividers turn
            horizontal when the row stacks, where they do the same job. */}
        <div className="flex flex-col divide-y divide-zinc-200 sm:flex-row sm:divide-x sm:divide-y-0">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className={cn(
                'flex-1 py-3 first:pt-0 last:pb-0',
                'sm:py-0',
                index > 0 && 'sm:pl-6',
                index < stats.length - 1 && 'sm:pr-6',
              )}
            >
              <StatFigure stat={stat} />
            </div>
          ))}
        </div>

        {/* No rate to multiply by, so no number. Said rather than left blank: a
            customer on a contract should not be left wondering whether the
            console simply failed to load it. */}
        {cost.kind === 'agreement' && (
          <p className="text-xs text-zinc-500" data-testid="cost-follows-agreement">
            Your total for this period is in Stripe.
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * One figure: what it is, then how much of it.
 *
 * Tabular figures throughout, so the row reads as a set and no column shifts
 * width as its number changes. A bar appears only where there is a real
 * allowance to fill, and takes the tile's full width under the number.
 */
function StatFigure({ stat }: { stat: Stat }) {
  const { label, note, value, valueTestId, caption, emphasis, limit, used, meterLabel } = stat;
  const limited = typeof limit === 'number' && limit > 0;
  const pct = limited && typeof used === 'number' ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div className="flex flex-col gap-1">
      {/* The qualifier is plain text, not a pill: a blue badge on a figure that
          costs nothing pulled more attention than the figures that do. It keeps
          the label's own colour — a step lighter was 2.6:1 on white, and "Free"
          is meaning, not decoration. */}
      <span className="text-xs text-zinc-500">
        {label}
        {note && ` · ${note}`}
      </span>

      <span
        className={cn('text-base leading-7 tabular-nums', emphasisStyles[emphasis])}
        data-testid={valueTestId}
      >
        {value}
        {limited && (
          <span className="text-sm font-normal text-zinc-500"> of {formatBytes(limit)}</span>
        )}
      </span>

      {caption && <span className="text-xs text-zinc-500">{caption}</span>}
      {limited && meterLabel && (
        <div className="mt-1">
          <ProgressBar value={pct} size="md" label={meterLabel} />
        </div>
      )}
    </div>
  );
}
