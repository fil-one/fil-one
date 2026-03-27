import type { Meta, StoryObj } from '@storybook/react-vite';

import { Alert } from './Alert';

const meta: Meta<typeof Alert> = {
  title: 'Components/Alert',
  component: Alert,
};

export default meta;
type Story = StoryObj<typeof Alert>;

export const Info: Story = {
  args: {
    title: 'Heads up',
    description: 'Your trial expires in 7 days. Upgrade to keep your data.',
  },
};

export const Success: Story = {
  args: {
    title: 'Bucket created',
    description: 'Your new bucket is ready to use.',
    variant: 'success',
  },
};

export const Warning: Story = {
  args: {
    title: 'Storage almost full',
    description: 'You have used 90% of your storage quota.',
    variant: 'warning',
  },
};

export const Error: Story = {
  args: {
    title: 'Payment failed',
    description: 'Please update your payment method to avoid service interruption.',
    variant: 'error',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Alert title="Info" description="This is an informational alert." variant="info" />
      <Alert title="Success" description="Operation completed successfully." variant="success" />
      <Alert title="Warning" description="Please review before proceeding." variant="warning" />
      <Alert title="Error" description="Something went wrong." variant="error" />
    </div>
  ),
};
