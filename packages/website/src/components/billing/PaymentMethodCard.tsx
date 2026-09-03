import { ArrowSquareOutIcon, CreditCardIcon, ReceiptIcon } from '@phosphor-icons/react/dist/ssr';
import type { BillingInfo } from '@filone/shared';

import { Button } from '../Button';
import { Card } from '../Card';
import { IconBox } from '../IconBox';
import { paymentPosture } from '../../lib/billing-view.js';
import type { PaymentPosture } from '../../lib/billing-view.js';

export type PaymentMethodCardProps = {
  billing: BillingInfo;
  mayManage: boolean;
  /** Opens the Stripe portal, where a card on file is changed. */
  onManage: () => void;
  /** Starts the flow that puts a first card on file. */
  onAddCard: () => void;
};

/**
 * How this organization pays.
 *
 * Label, value, detail — the same three lines as the plan card beside it, so the
 * pair reads as a pair and their two actions sit on one line. The tile indents
 * the value and its expiry, which is the trade for having a glyph at all: the
 * label row is what keeps the two cards aligned with each other.
 *
 * The two buttons that open Stripe's portal carry the trailing arrow Manage
 * plan uses, because they go to the same place. Add card does not: it opens a
 * dialog here.
 *
 * Three states rather than two. A billed account with no card on file is
 * invoiced, not missing something: contracted customers are billed by invoice,
 * and "No payment method added" over an active Business plan reads as a fault
 * in the account. A trial with no card is the one that genuinely needs one, and
 * only that state asks.
 */
export function PaymentMethodCard({
  billing,
  mayManage,
  onManage,
  onAddCard,
}: PaymentMethodCardProps) {
  const posture = paymentPosture(billing);
  const card = billing.paymentMethod;

  return (
    <Card>
      <div className="flex flex-col gap-1">
        {/* The action rides the label row, which is what puts it level with the
            plan card's button beside it. */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="text-sm font-medium text-zinc-900">Payment method</h3>
          {mayManage && (
            <PaymentAction posture={posture} onManage={onManage} onAddCard={onAddCard} />
          )}
        </div>

        {posture === 'card' && card && (
          <div className="mt-1 flex items-center gap-3">
            <IconBox icon={CreditCardIcon} color="blue" size="md" />
            <div className="min-w-0">
              {/* The brand and the last four, which is how a card is named
                  everywhere else it appears. Four dots, not twelve: the digits
                  nobody has are not information. */}
              <p className="text-sm whitespace-nowrap text-zinc-900">
                <span className="capitalize">{card.brand || 'Card'}</span>
                {' •••• '}
                <span className="tabular-nums">{card.last4}</span>
              </p>
              <p className="text-xs text-zinc-500 tabular-nums">
                Expires {String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}
              </p>
            </div>
          </div>
        )}

        {posture === 'invoiced' && (
          <div className="mt-1 flex items-center gap-3" data-testid="billed-by-invoice">
            <IconBox icon={ReceiptIcon} color="grey" size="md" />
            <p className="text-sm text-zinc-900">Billed by invoice</p>
          </div>
        )}

        {posture === 'needs-card' && (
          <div className="mt-1 flex items-center gap-3">
            <IconBox icon={CreditCardIcon} color="grey" size="md" />
            <div className="min-w-0">
              <p className="text-sm text-zinc-900">No card on file</p>
              <p className="text-xs text-zinc-500">Needed before your trial ends</p>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Whichever single action this posture leads to, if any. */
function PaymentAction({
  posture,
  onManage,
  onAddCard,
}: {
  posture: PaymentPosture;
  onManage: () => void;
  onAddCard: () => void;
}) {
  // A first card goes on file through a dialog here, so that one keeps its own
  // glyph and no arrow. The other two open Stripe's portal.
  if (posture === 'needs-card') {
    return (
      <Button
        id="billing-add-payment-button"
        variant="tertiary"
        size="sm"
        // The same pull as the plan card's action: a control must not set the
        // height of the label row, or the title sits lower than the card's
        // padding everywhere else.
        className="-my-1.5"
        icon={CreditCardIcon}
        onClick={onAddCard}
      >
        Add card
      </Button>
    );
  }

  return (
    <Button
      id={posture === 'card' ? 'billing-update-payment-button' : 'billing-invoiced-manage-button'}
      variant="tertiary"
      size="sm"
      className="-my-1.5"
      icon={ArrowSquareOutIcon}
      iconPosition="right"
      onClick={onManage}
    >
      {posture === 'card' ? 'Update' : 'Manage'}
    </Button>
  );
}
