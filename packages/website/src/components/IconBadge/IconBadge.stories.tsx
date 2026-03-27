import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  InfoIcon,
  CheckCircleIcon,
  WarningIcon,
  WarningCircleIcon,
  DatabaseIcon,
} from '@phosphor-icons/react/dist/ssr';

import { IconBadge } from './IconBadge';

const meta: Meta<typeof IconBadge> = {
  title: 'Components/IconBadge',
  component: IconBadge,
};

export default meta;
type Story = StoryObj<typeof IconBadge>;

export const Info: Story = {
  args: { icon: InfoIcon, variant: 'info' },
};

export const Success: Story = {
  args: { icon: CheckCircleIcon, variant: 'success' },
};

export const Warning: Story = {
  args: { icon: WarningIcon, variant: 'warning' },
};

export const Error: Story = {
  args: { icon: WarningCircleIcon, variant: 'error' },
};

export const Brand: Story = {
  args: { icon: DatabaseIcon, variant: 'brand' },
};

export const LargeSize: Story = {
  args: { icon: DatabaseIcon, variant: 'brand', size: 'lg' },
};

export const SquareShape: Story = {
  args: { icon: DatabaseIcon, variant: 'brand', shape: 'square' },
};

const allIcons = [InfoIcon, CheckCircleIcon, WarningIcon, WarningCircleIcon, DatabaseIcon] as const;
const allVariants = ['info', 'success', 'warning', 'error', 'brand'] as const;

function Row({
  label,
  size,
  shape,
}: {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  shape?: 'circle' | 'square';
}) {
  return (
    <div>
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-600">{label}</p>
      <div className="flex items-center gap-4">
        {allVariants.map((variant, i) => (
          <IconBadge key={variant} icon={allIcons[i]} variant={variant} size={size} shape={shape} />
        ))}
      </div>
    </div>
  );
}

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      <Row label="Circle sm — Alert" size="sm" shape="circle" />
      <Row label="Circle lg — EmptyStateCard" size="lg" shape="circle" />
      <Row label="Square sm" size="sm" shape="square" />
      <Row label="Square lg" size="lg" shape="square" />
    </div>
  ),
};
