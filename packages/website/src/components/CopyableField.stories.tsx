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
    label: 'Access Key',
    value: 'demo-access-key-12345',
  },
};

export const LongValue: Story = {
  args: {
    label: 'Secret Key',
    value: 'demo-secret-key-placeholder-67890',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-3">
      <CopyableField label="Access Key" value="demo-access-key-12345" />
      <CopyableField label="Secret Key" value="demo-secret-key-placeholder-67890" />
      <CopyableField label="Endpoint" value="https://s3.filone.io" />
    </div>
  ),
};
