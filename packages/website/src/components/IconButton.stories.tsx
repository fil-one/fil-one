import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  CopySimpleIcon,
  TrashIcon,
  PencilIcon,
  DotsThreeIcon,
} from '@phosphor-icons/react/dist/ssr';

import { IconButton } from './IconButton';

const meta: Meta<typeof IconButton> = {
  title: 'Components/IconButton',
  component: IconButton,
};

export default meta;
type Story = StoryObj<typeof IconButton>;

export const Medium: Story = {
  args: {
    icon: CopySimpleIcon,
    'aria-label': 'Copy',
    size: 'md',
  },
};

export const Small: Story = {
  args: {
    icon: CopySimpleIcon,
    'aria-label': 'Copy',
    size: 'sm',
  },
};

export const Disabled: Story = {
  args: {
    icon: TrashIcon,
    'aria-label': 'Delete',
    disabled: true,
  },
};

export const Large: Story = {
  args: {
    icon: CopySimpleIcon,
    'aria-label': 'Copy',
    size: 'lg',
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <IconButton icon={PencilIcon} aria-label="Edit (lg)" size="lg" />
      <IconButton icon={PencilIcon} aria-label="Edit (md)" size="md" />
      <IconButton icon={PencilIcon} aria-label="Edit (sm)" size="sm" />
    </div>
  ),
};

export const Icons: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <IconButton icon={CopySimpleIcon} aria-label="Copy" />
      <IconButton icon={TrashIcon} aria-label="Delete" />
      <IconButton icon={PencilIcon} aria-label="Edit" />
      <IconButton icon={DotsThreeIcon} aria-label="More" />
    </div>
  ),
};
