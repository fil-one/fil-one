import type { Meta, StoryObj } from '@storybook/react-vite';
import { Elements } from '@stripe/react-stripe-js';

import { Modal } from '../Modal/index.js';

import { PaymentForm } from './PaymentForm';

const meta: Meta<typeof PaymentForm> = {
  title: 'Components/Billing/PaymentForm',
  component: PaymentForm,
  decorators: [
    (Story) => (
      <Elements stripe={null}>
        <Modal open onClose={() => {}} size="sm">
          <Story />
        </Modal>
      </Elements>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PaymentForm>;

export const Default: Story = {
  args: {
    initialClientSecret: 'cs_test_demo',
    onClose: () => {},
    onBack: () => {},
    onSuccess: () => {},
    onRefreshSetupIntent: () => Promise.resolve('cs_test_demo_refreshed'),
  },
};
