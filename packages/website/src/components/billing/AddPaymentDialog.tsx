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

import { Modal, ModalBody, ModalHeader } from '../Modal/index.js';

import { getStripe } from '../../lib/stripe.js';

type AddPaymentDialogProps = {
  open: boolean;
  clientSecret: string;
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
}: Omit<AddPaymentDialogProps, 'open'>) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_cardBrand, setCardBrand] = useState<string>('unknown');

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
      const { apiRequest } = await import('../../lib/api.js');
      await apiRequest('/billing/activate', { method: 'POST' });
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

          {/* Error */}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {/* Buttons */}
        <div className="mt-4 border-t border-[#e1e4ea] pt-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center justify-center rounded-[6px] border border-[#e1e4ea] bg-[#f9fafb] px-[17px] py-[9px] text-[13px] font-medium text-[#14181f] shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)] transition-colors hover:bg-zinc-50"
            >
              Back
            </button>

            <button
              type="submit"
              disabled={!stripe || loading}
              className="flex flex-1 items-center justify-center gap-2 rounded-[6px] bg-gradient-to-br from-[#0080ff] to-[#256af4] px-4 py-2 text-[13px] font-medium text-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <CreditCardIcon size={16} weight="bold" />
              {loading ? 'Processing...' : 'Start subscription'}
            </button>
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
  onClose,
  onBack,
  onSuccess,
}: AddPaymentDialogProps) {
  const [stripe, setStripe] = useState<Stripe | null>(null);

  useEffect(() => {
    if (open) {
      void getStripe().then(setStripe);
    }
  }, [open]);

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
