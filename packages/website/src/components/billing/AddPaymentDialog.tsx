import { useEffect, useState } from 'react';

import { ShieldCheckIcon, CreditCardIcon, ArrowLeftIcon } from '@phosphor-icons/react/dist/ssr';
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
        <div className="flex items-center gap-2 rounded-lg bg-[#f0f6ff] px-3 py-2.5 mb-5">
          <ShieldCheckIcon size={18} className="text-[#0066ff] flex-shrink-0" weight="fill" />
          <span className="text-xs text-[#3a4252]">
            Your payment information is encrypted and secure
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {/* Card Number */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#3a4252]">Card number</label>
            <div className="rounded-md border border-[#e1e4ea] bg-[#fcfbf8] px-3 py-2.5">
              <CardNumberElement
                options={{ ...ELEMENT_OPTIONS, showIcon: true }}
                onChange={handleCardChange}
              />
            </div>
          </div>

          {/* Expiry + CVC */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-[#3a4252]">Expiry date</label>
              <div className="rounded-md border border-[#e1e4ea] bg-[#fcfbf8] px-3 py-2.5">
                <CardExpiryElement options={ELEMENT_OPTIONS} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-[#3a4252]">CVC</label>
              <div className="rounded-md border border-[#e1e4ea] bg-[#fcfbf8] px-3 py-2.5">
                <CardCvcElement options={ELEMENT_OPTIONS} />
              </div>
            </div>
          </div>

          {/* Error */}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {/* Buttons */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-lg border border-[#e1e4ea] px-4 py-2.5 text-sm font-medium text-[#3a4252] transition-colors hover:bg-zinc-50"
          >
            <ArrowLeftIcon size={14} />
            Back
          </button>

          <button
            type="submit"
            disabled={!stripe || loading}
            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-[#0066ff] to-[#0052cc] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <CreditCardIcon size={16} weight="bold" />
            {loading ? 'Processing...' : 'Start subscription'}
          </button>
        </div>

        <p className="mt-4 text-center text-xs text-[#99a0ae]">
          Pay only for what you use. Cancel anytime.
        </p>
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
