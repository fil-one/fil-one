import type { Meta, StoryObj } from '@storybook/react-vite';

import { CopyButton } from './CopyButton';

const meta: Meta<typeof CopyButton> = {
  title: 'Components/CopyButton',
  component: CopyButton,
};

export default meta;
type Story = StoryObj<typeof CopyButton>;

export const Default: Story = {
  args: {
    value: 'https://s3.fil.one',
    ariaLabel: 'Copy endpoint',
  },
};

export const Small: Story = {
  args: {
    value: 'ak_1a2b3c4d',
    size: 12,
    ariaLabel: 'Copy access key',
  },
};
