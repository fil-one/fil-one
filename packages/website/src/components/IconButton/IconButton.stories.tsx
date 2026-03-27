import type { Meta, StoryObj } from '@storybook/react-vite';
import { CopyIcon, EyeIcon, TrashIcon, GearSixIcon } from '@phosphor-icons/react/dist/ssr';

import { IconButton } from './IconButton';

const meta: Meta<typeof IconButton> = {
  title: 'Components/IconButton',
  component: IconButton,
};

export default meta;
type Story = StoryObj<typeof IconButton>;

export const Default: Story = {
  render: () => (
    <IconButton aria-label="Copy">
      <CopyIcon size={16} />
    </IconButton>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <IconButton aria-label="Copy">
        <CopyIcon size={16} />
      </IconButton>
      <IconButton aria-label="Show">
        <EyeIcon size={16} />
      </IconButton>
      <IconButton aria-label="Delete">
        <TrashIcon size={16} />
      </IconButton>
      <IconButton aria-label="Settings">
        <GearSixIcon size={16} />
      </IconButton>
    </div>
  ),
};
