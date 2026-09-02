import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/ssr';
import { SubscriptionStatus } from '@filone/shared';
import type { Subscription } from '@filone/shared';

import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { planMetaLine, planTitle, statusBadge } from '../../lib/billing-view.js';

export type PlanCardProps = {
  subscription: Subscription;
  /** Whether the caller holds `billing.manage`. Reading is a wider permission. */
  mayManage: boolean;
  /** Opens the Stripe customer portal, where plans and cards are actually changed. */
  onManage: () => void;
  /** Starts the upgrade or reactivation flow, for a plan that is not running. */
  onChoosePlan: () => void;
};

/**
 * Keeps a card's action from setting the height of the row it sits in.
 *
 * The button is 30px and the title beside it is a 20px line, so the row took the
 * button's height and centred the title in it — 26px of space above the title
 * against 21px below the card's last line, which is the asymmetry you feel
 * before you can name it. The negative margin pulls the button's box back to the
 * text's line box; its hit area is untouched.
 */
const ACTION_PULL = '-my-1.5';

/**
 * What the button offers, matching the banner above it word for word: the same
 * dialog opened from two places on one screen should not be called two things.
 * Only a cancellation is a reactivation; a lapsed trial and a lapsed payment
 * both land on the plan chooser.
 */
function planActionLabel(status: SubscriptionStatus): string {
  switch (status) {
    case SubscriptionStatus.Trialing:
      return 'Upgrade';
    case SubscriptionStatus.Canceled:
      return 'Reactivate';
    default:
      return 'Choose a plan';
  }
}

/**
 * What plan this org is on, what it charges, and when it renews.
 *
 * Three lines and one action, because that is the whole answer. The card it
 * replaces spent its height on a coloured border per status, a nested CTA
 * banner, and a "Billed monthly" footer, and still could not tell a contracted
 * customer what their plan was called.
 *
 * Everything it says comes from `billing-view`, which states a rate only when
 * Stripe reported one. Managing the plan is a trip to Stripe by design: the
 * portal is where the subscription lives, so it is the one place that can be
 * right about it.
 */
export function PlanCard({ subscription, mayManage, onManage, onChoosePlan }: PlanCardProps) {
  const badge = statusBadge(subscription.status);
  const running =
    subscription.status === SubscriptionStatus.Active ||
    subscription.status === SubscriptionStatus.PastDue;

  return (
    <Card>
      <div className="flex flex-col gap-1">
        {/* Label first, then the value: the same shape as the payment card
            beside it. Leading with the plan name instead made two identical
            cards read as different kinds of thing, and left their two identical
            buttons 32px out of line with each other. */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="text-sm font-medium text-zinc-900">Plan</h3>

          {/* A running subscription is managed in Stripe; one that is not needs
              a plan picked before there is anything to manage. Only one of the
              two is ever the next step, so only one is offered. */}
          {mayManage &&
            (running ? (
              <Button
                id="billing-manage-plan-button"
                variant="tertiary"
                size="sm"
                className={ACTION_PULL}
                icon={ArrowSquareOutIcon}
                iconPosition="right"
                onClick={onManage}
              >
                Manage plan
              </Button>
            ) : (
              <Button
                id="billing-plan-cta-button"
                variant="primary"
                size="sm"
                className={ACTION_PULL}
                onClick={onChoosePlan}
              >
                {planActionLabel(subscription.status)}
              </Button>
            ))}
        </div>

        {/* `text-sm` on the row, not just its contents: without it the flex line
            box inherited the card's 24px leading and stood 4px taller than the
            payment card's value line beside it. */}
        <div className="flex items-center gap-2 text-sm">
          <p className="text-zinc-900" data-testid="plan-name">
            {planTitle(subscription)}
          </p>
          {/* The wrapper stays either way, so the state is readable from the DOM
              even where the pill would only repeat the name: an account with no
              plan is already named "No plan", and saying it twice side by side
              is noise. */}
          <span data-testid="subscription-status" data-status={subscription.status}>
            {subscription.status !== SubscriptionStatus.Inactive && (
              <Badge color={badge.tone} size="sm" weight="medium" dot={badge.dot}>
                {badge.label}
              </Badge>
            )}
          </span>
        </div>

        <p className="text-xs text-zinc-500 tabular-nums" data-testid="plan-meta">
          {planMetaLine(subscription)}
        </p>
      </div>
    </Card>
  );
}
