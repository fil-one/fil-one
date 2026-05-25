import { useState } from 'react';
import { Elements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { Modal } from '../Modal';
import { PaymentForm } from './AddPaymentDialog';

// Storybook visual-only test key. Stripe Elements may log warnings but the
// surrounding dialog UI (labels, buttons, footer copy) renders for review.
const STORYBOOK_PUBLISHABLE_KEY = 'pk_test_STORYBOOK_PLACEHOLDER_NOT_A_REAL_KEY';
const STORYBOOK_CLIENT_SECRET = 'seti_storybook_placeholder_secret';

const stripePromise = loadStripe(STORYBOOK_PUBLISHABLE_KEY);

const meta: Meta<typeof PaymentForm> = {
  title: 'Components/Billing/AddPaymentDialog',
  component: PaymentForm,
};

export default meta;
type Story = StoryObj<typeof PaymentForm>;

function StoryShell({ addPaymentOnly }: { addPaymentOnly: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} size="sm">
        <Elements stripe={stripePromise} options={{ clientSecret: STORYBOOK_CLIENT_SECRET }}>
          <PaymentForm
            clientSecret={STORYBOOK_CLIENT_SECRET}
            saveCardOnly={addPaymentOnly}
            onClose={() => setOpen(false)}
            onBack={() => setOpen(false)}
            onSuccess={() => setOpen(false)}
          />
        </Elements>
      </Modal>
    </>
  );
}

export const Activate: Story = {
  name: 'Activate (default)',
  render: () => <StoryShell addPaymentOnly={false} />,
};

export const AddCardOnly: Story = {
  name: 'Add card only',
  render: () => <StoryShell addPaymentOnly />,
};
