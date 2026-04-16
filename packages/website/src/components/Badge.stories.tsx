import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge, type BadgeColor, type BadgeSize } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  argTypes: {
    color: { control: 'select', options: ['green', 'blue', 'red', 'amber', 'grey'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    weight: { control: 'select', options: ['regular', 'medium'] },
    variant: { control: 'select', options: ['subtle', 'solid'] },
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
          <Badge color="amber" size={size}>
            size {size}
          </Badge>
          <Badge color="grey" size={size}>
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
      <Badge color="amber" dot>
        Pending
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
    <div className="flex flex-col gap-8">
      {(['subtle', 'solid'] as const).map((variant) => (
        <div key={variant} className="flex flex-col gap-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            {variant}
          </p>
          {(['green', 'blue', 'red', 'amber', 'grey'] as BadgeColor[]).map((color) => (
            <div key={color} className="flex flex-col gap-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-300">
                {color}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
                  <Badge key={size} color={color} size={size} variant={variant}>
                    {size}
                  </Badge>
                ))}
                {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
                  <Badge key={`dot-${size}`} color={color} size={size} variant={variant} dot>
                    {size}
                  </Badge>
                ))}
                {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
                  <Badge
                    key={`med-${size}`}
                    color={color}
                    size={size}
                    variant={variant}
                    weight="medium"
                  >
                    {size}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
};

export const Solid: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {(['green', 'blue', 'red', 'amber', 'grey'] as BadgeColor[]).map((color) => (
        <div key={color} className="flex flex-col gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{color}</p>
          <div className="flex flex-wrap items-center gap-2">
            {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
              <Badge key={size} color={color} size={size} variant="solid">
                {size}
              </Badge>
            ))}
            {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
              <Badge key={`dot-${size}`} color={color} size={size} variant="solid" dot>
                {size}
              </Badge>
            ))}
            {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
              <Badge key={`med-${size}`} color={color} size={size} variant="solid" weight="medium">
                {size}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
