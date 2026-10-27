import { useEffect, useState } from 'react';

import { CheckCircleIcon, CreditCardIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';
import {
  CardNumberElement,
  CardExpiryElement,
  CardCvcElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import type {
  Stripe,
  StripeCardNumberElement,
  StripeCardNumberElementChangeEvent,
} from '@stripe/stripe-js';
import { ActivateSubscriptionRequestSchema, CheckPromotionCodeRequestSchema } from '@filone/shared';
import type { SubscriptionDiscount } from '@filone/shared';

import { ModalBody, ModalHeader } from '../Modal/index.js';
import { Button } from '../Button.js';
import { FormField } from '../FormField.js';
import { Input } from '../Input.js';
import { Label } from '../Label.js';

import { activateSubscription, checkPromotionCode } from '../../lib/api.js';
import { discountLabel } from '../../lib/billing-view.js';

export type PaymentFormProps = {
  initialClientSecret: string;
  onClose: () => void;
  onBack: () => void;
  /** Called with the promo code the subscription started with, when there was one. */
  onSuccess: (promotionCode?: string) => void;
  onRefreshSetupIntent: () => Promise<string>;
};

// Stripe renders these fields inside its own iframe, which cannot read the
// console's CSS variables, so each colour is the hex of the token `Input` uses.
const ELEMENT_STYLE = {
  base: {
    fontSize: '14px',
    fontFamily: 'Inter, system-ui, sans-serif',
    color: '#09090b', // zinc-950, --color-text-base
    '::placeholder': { color: '#9f9fa9' }, // zinc-400, --input-placeholder-color
  },
  invalid: { color: '#e7000b' }, // red-600, the FormField error colour
};

const ELEMENT_OPTIONS = {
  style: ELEMENT_STYLE,
};

// The frame around each Stripe field, matching `Input` md. `focus-within`
// because focus lands on Stripe's iframe, which the frame contains.
const STRIPE_FIELD_CLASS =
  'flex h-(--control-height-md) flex-col justify-center rounded-md border border-(--input-border-color) bg-white px-3 transition-colors focus-within:brand-outline';

export function PaymentForm({
  initialClientSecret,
  onClose,
  onBack,
  onSuccess,
  onRefreshSetupIntent,
}: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_cardBrand, setCardBrand] = useState<string>('unknown');
  const [promotionCode, setPromotionCode] = useState('');
  const [cardConfirmed, setCardConfirmed] = useState(false);
  const [setupIntentUsed, setSetupIntentUsed] = useState(false);
  const [effectiveClientSecret, setEffectiveClientSecret] = useState(initialClientSecret);

  useEffect(() => {
    setCardConfirmed(false);
    setSetupIntentUsed(false);
    setEffectiveClientSecret(initialClientSecret);
  }, [initialClientSecret]);

  function handleCardChange(e: StripeCardNumberElementChangeEvent) {
    setCardConfirmed(false);
    setCardBrand(e.brand ?? 'unknown');
    if (e.error) {
      setError(e.error.message);
    } else {
      setError(null);
    }
  }

  async function confirmCard(
    stripeInstance: Stripe,
    cardElement: StripeCardNumberElement,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (cardConfirmed) return { ok: true };

    let clientSecret = effectiveClientSecret;
    if (setupIntentUsed) {
      try {
        clientSecret = await onRefreshSetupIntent();
      } catch (err) {
        return { ok: false, error: (err as Error).message || 'Failed to refresh payment setup.' };
      }
      setEffectiveClientSecret(clientSecret);
      setSetupIntentUsed(false);
    }

    const result = await stripeInstance.confirmCardSetup(clientSecret, {
      payment_method: { card: cardElement },
    });

    if (result.error) {
      return {
        ok: false,
        error: result.error.message ?? 'An error occurred while confirming your card.',
      };
    }

    setCardConfirmed(true);
    setSetupIntentUsed(true);
    return { ok: true };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setLoading(true);
    setError(null);

    const cardNumberElement = elements.getElement(CardNumberElement);
    if (!cardNumberElement) {
      setError('Card element not found');
      setLoading(false);
      return;
    }

    // Validate the promo code against the same zod schema the server uses, so format
    // typos are caught before we bother creating a Stripe payment method.
    const trimmedPromotionCode = promotionCode.trim();
    const body = trimmedPromotionCode ? { promotionCode: trimmedPromotionCode } : {};
    const parsed = ActivateSubscriptionRequestSchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Form validation error.');
      setLoading(false);
      return;
    }

    const confirmation = await confirmCard(stripe, cardNumberElement);
    if (!confirmation.ok) {
      setError(confirmation.error);
      setLoading(false);
      return;
    }

    // Card setup confirmed — activate subscription via API
    try {
      await activateSubscription(parsed.data);
      onSuccess(parsed.data.promotionCode);
    } catch (err) {
      setError((err as Error).message || 'Failed to activate subscription.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ModalHeader onClose={onClose}>Add payment method</ModalHeader>
      <ModalBody>
        <p className="text-sm text-zinc-600 mb-4">Pay as you go: $5.99/TB/month</p>

        {/* Security banner. The icon in the console's usual inline style,
            regular weight in grey: a filled brand-blue shield was the one
            icon in the modal shouting. One line at the modal's full width;
            where it wraps, `text-balance` splits it into two even lines
            rather than leaving one word on a line of its own. */}
        <div className="flex items-center gap-2.5 rounded-lg bg-zinc-50 p-2.5 mb-4">
          <ShieldCheckIcon size={16} className="flex-shrink-0 text-zinc-500" aria-hidden />
          <span className="text-ui text-balance text-zinc-600">
            Payment information is encrypted and secure
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {/* Card Number */}
          <div className="flex flex-col gap-2.5">
            <Label>Card number</Label>
            <div className={STRIPE_FIELD_CLASS}>
              <CardNumberElement
                options={{ ...ELEMENT_OPTIONS, showIcon: true }}
                onChange={handleCardChange}
              />
            </div>
          </div>

          {/* Expiry + CVC */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2.5">
              <Label>Expiry</Label>
              <div className={STRIPE_FIELD_CLASS}>
                <CardExpiryElement options={ELEMENT_OPTIONS} />
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              <Label>CVC</Label>
              <div className={STRIPE_FIELD_CLASS}>
                <CardCvcElement options={ELEMENT_OPTIONS} />
              </div>
            </div>
          </div>

          <PromotionCodeField value={promotionCode} onChange={setPromotionCode} />

          {/* Error */}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {/* Buttons */}
        <div className="mt-4 border-t border-zinc-200 pt-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="md" onClick={onBack}>
              Back
            </Button>

            <Button
              type="submit"
              variant="primary"
              size="md"
              icon={CreditCardIcon}
              disabled={!stripe || loading}
              className="flex-1 justify-center"
            >
              {loading ? 'Processing...' : 'Start subscription'}
            </Button>
          </div>

          <p className="text-center text-meta text-zinc-600">
            Pay for the storage you use, $5.99/month minimum.
            <br />
            Cancel anytime.
          </p>
        </div>
      </ModalBody>
    </form>
  );
}

/**
 * The optional promo code, with an Apply button that asks Stripe what the code
 * takes off, so the discount is confirmed before the card is charged. A code
 * typed and never applied is still checked by activation.
 */
function PromotionCodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the code in the field takes off, once Stripe has confirmed it. Cleared
  // whenever the field changes, so it never describes a code no longer there.
  const [appliedDiscount, setAppliedDiscount] = useState<SubscriptionDiscount | null>(null);

  function handleChange(next: string) {
    onChange(next);
    setError(null);
    setAppliedDiscount(null);
  }

  async function apply() {
    const parsed = CheckPromotionCodeRequestSchema.safeParse({ promotionCode: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a promo code.');
      return;
    }

    setChecking(true);
    setError(null);
    try {
      const { discount } = await checkPromotionCode(parsed.data);
      setAppliedDiscount(discount);
    } catch (err) {
      setError((err as Error).message || 'Could not check this promo code.');
    } finally {
      setChecking(false);
    }
  }

  /** Enter applies the code instead of submitting the form and starting the subscription. */
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (value.trim() && !appliedDiscount) void apply();
  }

  return (
    <FormField label="Promo code" optional htmlFor="promotion-code" error={error}>
      <div className="flex items-center gap-2">
        <Input
          id="promotion-code"
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          invalid={Boolean(error)}
          placeholder="Add promo code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          className="min-w-0 flex-1"
        />
        {appliedDiscount ? (
          <Button type="button" variant="ghost" size="md" onClick={() => handleChange('')}>
            Remove
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="md"
            disabled={!value.trim()}
            loading={checking}
            loadingLabel="Checking promo code"
            onClick={() => void apply()}
          >
            Apply
          </Button>
        )}
      </div>
      {appliedDiscount && (
        <p
          className="flex items-start gap-1.5 text-xs text-zinc-600"
          data-testid="applied-discount"
          role="status"
        >
          {/* A box one line tall, so the icon stays on the first line when the text wraps. */}
          <span className="flex h-4 flex-shrink-0 items-center">
            <CheckCircleIcon size={14} className="text-brand-600" weight="fill" />
          </span>
          <span>
            {appliedDiscount.promotionCode ?? value.trim()} applied:{' '}
            {discountLabel(appliedDiscount)}
          </span>
        </p>
      )}
    </FormField>
  );
}
