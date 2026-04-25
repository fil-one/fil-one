import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge, type BadgeColor, type BadgeSize } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  argTypes: {
    color: { control: 'select', options: ['green', 'blue', 'red', 'grey', 'amber'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    weight: { control: 'select', options: ['regular', 'medium', 'semibold'] },
    dot: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Default: Story = {
  args: { children: 'Active', color: 'green', size: 'md' },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
        <div key={size} className="flex items-center gap-2">
          <Badge color="green" size={size}>
            size {size}
          </Badge>
          <Badge color="blue" size={size}>
            size {size}
          </Badge>
          <Badge color="red" size={size}>
            size {size}
          </Badge>
          <Badge color="grey" size={size}>
            size {size}
          </Badge>
          <Badge color="amber" size={size}>
            size {size}
          </Badge>
        </div>
      ))}
    </div>
  ),
};

export const WithDot: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge color="green" dot>
        Online
      </Badge>
      <Badge color="red" dot>
        Offline
      </Badge>
      <Badge color="grey" dot>
        Idle
      </Badge>
      <Badge color="blue" dot>
        Syncing
      </Badge>
    </div>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {(['green', 'blue', 'red', 'grey', 'amber'] as BadgeColor[]).map((color) => (
        <div key={color} className="flex flex-col gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{color}</p>
          <div className="flex flex-wrap items-center gap-2">
            {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
              <Badge key={size} color={color} size={size}>
                {size}
              </Badge>
            ))}
            {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
              <Badge key={`dot-${size}`} color={color} size={size} dot>
                {size}
              </Badge>
            ))}
            {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
              <Badge key={`med-${size}`} color={color} size={size} weight="medium">
                {size}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
