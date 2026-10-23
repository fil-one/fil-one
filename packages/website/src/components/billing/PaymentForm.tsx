import { useEffect, useState } from 'react';

import { ShieldCheckIcon, CreditCardIcon } from '@phosphor-icons/react/dist/ssr';
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
import { ActivateSubscriptionRequestSchema } from '@filone/shared';

import { ModalBody, ModalHeader } from '../Modal/index.js';
import { Button } from '../Button.js';
import { FormField } from '../FormField.js';
import { Input } from '../Input.js';
import { Label } from '../Label.js';

import { activateSubscription } from '../../lib/api.js';

export type PaymentFormProps = {
  initialClientSecret: string;
  onClose: () => void;
  onBack: () => void;
  onSuccess: () => void;
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
      onSuccess();
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

        {/* Security banner */}
        <div className="flex items-center gap-2.5 rounded-lg bg-zinc-50 p-2.5 mb-4">
          <ShieldCheckIcon size={16} className="text-brand-600 flex-shrink-0" weight="fill" />
          <span className="text-ui text-zinc-600">
            Your payment information is encrypted and secure
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

          {/* Promo code (optional) */}
          <FormField label="Promo code" optional htmlFor="promotion-code">
            <Input
              id="promotion-code"
              type="text"
              value={promotionCode}
              onChange={setPromotionCode}
              placeholder="Add promo code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
            />
          </FormField>

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
