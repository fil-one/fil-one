import { useEffect, useState } from 'react';

import { Elements } from '@stripe/react-stripe-js';
import type { Stripe } from '@stripe/stripe-js';

import { Modal } from '../Modal/index.js';

import { getStripe } from '../../lib/stripe.js';

import { PaymentForm } from './PaymentForm.js';

type AddPaymentDialogProps = {
  open: boolean;
  clientSecret: string;
  stripePublishableKey: string;
  onClose: () => void;
  onBack: () => void;
  onSuccess: () => void;
  onRefreshSetupIntent: () => Promise<string>;
};

export function AddPaymentDialog({
  open,
  clientSecret,
  stripePublishableKey,
  onClose,
  onBack,
  onSuccess,
  onRefreshSetupIntent,
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
          initialClientSecret={clientSecret}
          onClose={onClose}
          onBack={onBack}
          onSuccess={onSuccess}
          onRefreshSetupIntent={onRefreshSetupIntent}
        />
      </Elements>
    </Modal>
  );
}
