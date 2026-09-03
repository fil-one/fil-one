import { LifebuoyIcon } from '@phosphor-icons/react/dist/ssr';
import { SubscriptionStatus } from '@filone/shared';

import { BaseLink } from '../BaseLink';
import { Overline } from '../Overline';
import { showsSalesPitch } from '../../lib/billing-view.js';

export type BillingHelpRailProps = {
  status: SubscriptionStatus;
  /** Opens the sales conversation, for an account that has not bought yet. */
  onContactSales: () => void;
};

/**
 * The standing answer to "who do I ask", beside the numbers rather than under
 * them.
 *
 * The same rail the create-bucket page carries: an overline, then short items
 * divided by hairlines. That page uses it to explain defaults you cannot see on
 * the form; here it explains what you are billed for and where to take a
 * question, which is what people arrive on a billing page wanting when the
 * figures alone do not settle it.
 *
 * Deliberately not marketing. The volume-pricing item is offered only to an
 * account that has not bought yet, the same condition the rest of the tab uses:
 * an org already on a contract has an account team, and pitching it a plan is
 * the console admitting it does not know who it is talking to.
 */
export function BillingHelpRail({ status, onContactSales }: BillingHelpRailProps) {
  return (
    // Full width once it stacks: at 240px on a phone the copy sits in a narrow
    // column with the rest of the screen empty beside it.
    <aside className="w-full shrink-0 self-start lg:sticky lg:top-0 lg:w-60 lg:pt-1">
      {/* The glyph inherits the overline's own colour: Phosphor draws in
          `currentColor`, so it stays with the label if that ever changes. */}
      <Overline className="flex items-center gap-1.5">
        <LifebuoyIcon size={12} aria-hidden="true" />
        Need help?
      </Overline>

      <div className="mt-3 flex flex-col">
        <RailItem title="Billing questions">
          Ask us about an invoice, a payment, or your plan.{' '}
          <BaseLink
            href="/support"
            className="font-medium text-brand-600 hover:underline focus-visible:brand-outline"
          >
            Contact support
          </BaseLink>
        </RailItem>

        {showsSalesPitch(status) && (
          <RailItem title="Volume pricing" divided>
            Storing hundreds of terabytes?{' '}
            <button
              type="button"
              onClick={onContactSales}
              className="font-medium text-brand-600 hover:underline focus-visible:brand-outline"
            >
              Talk to sales
            </button>{' '}
            about a plan with an SLA and dedicated support.
          </RailItem>
        )}
      </div>
    </aside>
  );
}

/** One item, hairline-divided from the one above it. */
function RailItem({
  title,
  children,
  divided = false,
}: {
  title: string;
  children: React.ReactNode;
  divided?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 py-3 ${divided ? 'border-t border-zinc-200/60' : ''}`.trim()}
    >
      <span className="text-sm font-medium text-zinc-900">{title}</span>
      <p className="text-xs leading-relaxed text-zinc-500">{children}</p>
    </div>
  );
}
