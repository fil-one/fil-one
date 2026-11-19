import { ArrowSquareOutIcon, TagIcon } from '@phosphor-icons/react/dist/ssr';
import { SubscriptionStatus } from '@filone/shared';
import type { Subscription } from '@filone/shared';

import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import {
  discountLabel,
  formatCents,
  getAppliedDiscounts,
  getDiscountedRateCents,
  planTitle,
  pricingLine,
  statusBadge,
  timelineLine,
} from '../../lib/billing-view.js';

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
  const price = pricingLine(subscription);
  const timeline = timelineLine(subscription);
  const discounts = getAppliedDiscounts(subscription);
  const discountedRate = getDiscountedRateCents(subscription);
  const running =
    subscription.status === SubscriptionStatus.Active ||
    subscription.status === SubscriptionStatus.PastDue;

  return (
    <Card>
      <div className="flex flex-col gap-1">
        {/* The plan's name is the heading: "Plan" above "Pay as you go" said
            the same thing twice. It shares the row with the action, so the
            button stays level with the payment card's. `text-sm` on the group,
            not just its contents, so the row's line box is the 20px of the
            text and not the card's 24px leading. The row itself never wraps,
            which at 375px dropped the action onto a line of its own under the
            heading. Name, badge and action need about 290px, more than a phone
            leaves, so there the badge wraps under the name and the action
            stays level with the name rather than centring on both lines. */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <h3 className="font-medium text-zinc-900" data-testid="plan-name">
              {planTitle(subscription)}
            </h3>
            {/* A pill only for a plan that needs attention (`statusBadge`).
                The wrapper stays either way, so the state is readable from the
                DOM where there is no pill. A flex box, not inline: inline, it sat
                the pill on the text baseline and added 2px of descender space,
                which pushed the name 1px below the payment card's title. */}
            <span
              className="flex"
              data-testid="subscription-status"
              data-status={subscription.status}
            >
              {badge && (
                <Badge color={badge.tone} size="sm" weight="medium">
                  {badge.label}
                </Badge>
              )}
            </span>
          </div>

          {/* A running subscription is managed in Stripe; one that is not needs
              a plan picked before there is anything to manage. Only one of the
              two is ever the next step, so only one is offered. */}
          {/* A manually billed plan is changed through the account team, and
              neither Stripe nor the plan chooser has anything to offer it. */}
          {mayManage &&
            subscription.status !== SubscriptionStatus.Manual &&
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

        {/* The rate, then what happens next: the same value-over-detail pair
            as the card's brand and expiry in the payment card beside it, so
            the two cards share a rhythm and a height. On one line, the plan
            card stood 20px shorter than the payment card and the grid left
            that as empty space under it. `mt-1` matches the payment card's
            gap between its label and its details. */}
        {(price || timeline || discounts.length > 0) && (
          <div className="mt-1">
            {/* The rate they pay, then the discount that makes it so: what it
                takes off, not the code that applied it, since the code was
                typed once at checkout and can run to 40 characters while the
                terms are what the customer checks against an invoice. With a
                discount that changes the rate (`getDiscountedRateCents`), the
                rate shown is the discounted one and the list rate is not
                repeated: struck through beside it, two prices on one line read
                as a puzzle. A tag glyph and text in one dark blue (`brand-800`,
                9.8:1 on white), not a pill: a second pill was one too many.
                The row aligns on the text baseline, since the discount is
                smaller than the rate and centring the two set it high; only
                the glyph, which has no baseline, centres on the line. The
                discount wraps under the rate where the card is too narrow. */}
            {(price || discounts.length > 0) && (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                {price && (
                  <p className="text-sm text-zinc-900 tabular-nums" data-testid="plan-price">
                    {discountedRate === null
                      ? price
                      : `${formatCents(discountedRate)}/TB per month`}
                  </p>
                )}
                {discounts.map((discount, index) => (
                  <span
                    key={index}
                    className="flex items-baseline gap-1 text-xs text-brand-800 tabular-nums"
                    data-testid="plan-discount"
                  >
                    <TagIcon size={12} weight="fill" aria-hidden className="shrink-0 self-center" />
                    {discountLabel(discount)}
                  </span>
                ))}
              </div>
            )}
            {timeline && (
              <p className="text-xs text-zinc-500 tabular-nums" data-testid="plan-timeline">
                {timeline}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
