import type { Meta, StoryObj } from '@storybook/react-vite';

import { Alert, type AlertVariant } from './Alert';

const meta: Meta<typeof Alert> = {
  title: 'Components/Alert',
  component: Alert,
  argTypes: {
    variant: { control: 'select', options: ['blue', 'green', 'red', 'grey', 'amber'] },
  },
};

export default meta;
type Story = StoryObj<typeof Alert>;

export const Default: Story = {
  args: {
    variant: 'blue',
    title: 'Heads up',
    description: 'This is an informational alert to notify you of something important.',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-3 w-96">
      {(['blue', 'green', 'red', 'grey', 'amber'] as AlertVariant[]).map((variant) => (
        <Alert
          key={variant}
          variant={variant}
          title={variant.charAt(0).toUpperCase() + variant.slice(1)}
          description="This is an example alert message for this variant."
        />
      ))}
    </div>
  ),
};

export const WithoutTitle: Story = {
  args: {
    variant: 'amber',
    description: 'Save your credentials in a safe place. Do not share your secret key with anyone.',
  },
};

export const LongDescription: Story = {
  args: {
    variant: 'red',
    title: 'Storage limit approaching',
    description:
      'You have used 95% of your available storage. Consider upgrading your plan or removing unused objects to free up space before uploads are disabled.',
  },
};
