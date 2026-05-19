import type { Meta, StoryObj } from '@storybook/react-vite';

import { Overline } from './Overline';

const meta: Meta<typeof Overline> = {
  title: 'Components/Overline',
  component: Overline,
};

export default meta;
type Story = StoryObj<typeof Overline>;

export const Default: Story = {
  args: {
    children: 'Included by default',
  },
};

export const Examples: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Overline>Included by default</Overline>
      <Overline>Pay-as-you-go</Overline>
      <Overline>Need more?</Overline>
    </div>
  ),
};
