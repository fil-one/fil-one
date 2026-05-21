import { useEffect, useState } from 'react';

import { ShieldCheckIcon, CreditCardIcon } from '@phosphor-icons/react/dist/ssr';
import {
  CardNumberElement,
  CardExpiryElement,
  CardCvcElement,
  Elements,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import type { Stripe, StripeCardNumberElementChangeEvent } from '@stripe/stripe-js';
import { ActivateSubscriptionRequestSchema } from '@filone/shared';

import { Modal, ModalBody, ModalHeader } from '../Modal/index.js';
import { Button } from '../Button.js';

import { getStripe } from '../../lib/stripe.js';
import { activateSubscription } from '../../lib/api.js';

type AddPaymentDialogProps = {
  open: boolean;
  clientSecret: string;
  stripePublishableKey: string;
  onClose: () => void;
  onBack: () => void;
  onSuccess: () => void;
};

const ELEMENT_STYLE = {
  base: {
    fontSize: '13px',
    fontFamily: 'Inter, system-ui, sans-serif',
    color: '#14181f',
    '::placeholder': { color: '#99a0ae' },
  },
  invalid: { color: '#ef4444' },
};

const ELEMENT_OPTIONS = {
  style: ELEMENT_STYLE,
};

function PaymentForm({
  clientSecret,
  onClose,
  onBack,
  onSuccess,
}: Omit<AddPaymentDialogProps, 'open' | 'stripePublishableKey'>) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_cardBrand, setCardBrand] = useState<string>('unknown');
  const [promotionCode, setPromotionCode] = useState('');

  function handleCardChange(e: StripeCardNumberElementChangeEvent) {
    setCardBrand(e.brand ?? 'unknown');
    if (e.error) {
      setError(e.error.message);
    } else {
      setError(null);
    }
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

    const result = await stripe.confirmCardSetup(clientSecret, {
      payment_method: { card: cardNumberElement },
    });

    if (result.error) {
      setError(result.error.message ?? 'An error occurred while confirming your card.');
      setLoading(false);
      return;
    }

    // Card setup confirmed — activate subscription via API
    try {
      await activateSubscription({ promotionCode: trimmedPromotionCode });
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
        <p className="text-sm text-[#677183] mb-4">Pay as you go — $4.99/TB/month</p>

        {/* Security banner */}
        <div className="flex items-center gap-[10px] rounded-lg bg-[rgba(243,244,246,0.5)] p-[10px] mb-4">
          <ShieldCheckIcon size={16} className="text-[#0066ff] flex-shrink-0" weight="fill" />
          <span className="text-[13px] text-[#677183]">
            Your payment information is encrypted and secure
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {/* Card Number */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-[#14181f]">Card number</label>
            <div className="rounded-[6px] border border-[#e1e4ea] bg-[#f9fafb] px-3 py-2.5">
              <CardNumberElement
                options={{ ...ELEMENT_OPTIONS, showIcon: true }}
                onChange={handleCardChange}
              />
            </div>
          </div>

          {/* Expiry + CVC */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-[#14181f]">Expiry</label>
              <div className="rounded-[6px] border border-[#e1e4ea] bg-[#f9fafb] px-3 py-2.5">
                <CardExpiryElement options={ELEMENT_OPTIONS} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-[#14181f]">CVC</label>
              <div className="rounded-[6px] border border-[#e1e4ea] bg-[#f9fafb] px-3 py-2.5">
                <CardCvcElement options={ELEMENT_OPTIONS} />
              </div>
            </div>
          </div>

          {/* Promo code (optional) */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="promotion-code" className="text-[13px] font-medium text-[#14181f]">
              Promo code <span className="font-normal text-[#99a0ae]">(optional)</span>
            </label>
            <input
              id="promotion-code"
              type="text"
              value={promotionCode}
              onChange={(e) => setPromotionCode(e.target.value)}
              placeholder="Add promo code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
              className="rounded-[6px] border border-[#e1e4ea] bg-[#f9fafb] px-3 py-2.5 text-[13px] text-[#14181f] placeholder:text-[#99a0ae] focus:outline-none focus:ring-1 focus:ring-[#0080ff]"
            />
          </div>

          {/* Error */}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {/* Buttons */}
        <div className="mt-4 border-t border-[#e1e4ea] pt-4 flex flex-col gap-2">
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

          <p className="text-center text-[11px] text-[#677183]">
            Pay only for what you use. Cancel anytime.
          </p>
        </div>
      </ModalBody>
    </form>
  );
}

export function AddPaymentDialog({
  open,
  clientSecret,
  stripePublishableKey,
  onClose,
  onBack,
  onSuccess,
}: AddPaymentDialogProps) {
  const [stripe, setStripe] = useState<Stripe | null>(null);

  useEffect(() => {
    if (open && stripePublishableKey) {
      void getStripe(stripePublishableKey).then(setStripe);
    }
  }, [open, stripePublishableKey]);

  if (!clientSecret || !stripe) return null;

  return (
    <Modal open={open} onClose={onClose} size="sm">
      <Elements stripe={stripe} options={{ clientSecret }}>
        <PaymentForm
          clientSecret={clientSecret}
          onClose={onClose}
          onBack={onBack}
          onSuccess={onSuccess}
        />
      </Elements>
    </Modal>
  );
}
