import type { Meta, StoryObj } from '@storybook/react-vite';

import { DatabaseIcon, KeyIcon, GearIcon, CheckCircleIcon } from '@phosphor-icons/react/dist/ssr';

import { Icon } from './Icon';

const meta: Meta<typeof Icon> = {
  title: 'Components/Icon',
  component: Icon,
};

export default meta;
type Story = StoryObj<typeof Icon>;

export const Default: Story = {
  args: {
    component: DatabaseIcon,
  },
};

export const SuccessColor: Story = {
  args: {
    component: CheckCircleIcon,
    color: 'success',
  },
};

export const SmallSize: Story = {
  args: {
    component: KeyIcon,
    size: 16,
  },
};

export const BoldWeight: Story = {
  args: {
    component: GearIcon,
    weight: 'bold',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <Icon component={DatabaseIcon} />
      <Icon component={KeyIcon} size={16} />
      <Icon component={GearIcon} size={32} weight="bold" />
      <Icon component={CheckCircleIcon} color="success" size={32} />
    </div>
  ),
};
