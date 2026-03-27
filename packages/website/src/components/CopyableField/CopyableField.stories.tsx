import type { Meta, StoryObj } from '@storybook/react-vite';

import { CopyableField } from './CopyableField';

const meta: Meta<typeof CopyableField> = {
  title: 'Components/CopyableField',
  component: CopyableField,
};

export default meta;
type Story = StoryObj<typeof CopyableField>;

export const Default: Story = {
  args: {
    label: 'Endpoint',
    value: 'https://s3.fil.one',
  },
};

export const LongValue: Story = {
  args: {
    label: 'Access Key',
    value: 'ak_1a2b3c4d5e6f7g8h9i0jklmnopqrstuvwxyz1234567890',
  },
};

export const MultipleFields: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-3">
      <CopyableField label="Endpoint" value="https://s3.fil.one" />
      <CopyableField label="Access Key" value="ak_1a2b3c4d5e6f7g8h" />
      <CopyableField label="Secret Key" value="sk_9z8y7x6w5v4u3t2s" />
    </div>
  ),
};
