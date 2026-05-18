import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Badge,
  type BadgeColor,
  type BadgeSize,
  type BadgeStrength,
  type BadgeVariant,
} from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  argTypes: {
    color: { control: 'select', options: ['green', 'blue', 'red', 'amber', 'grey'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    weight: { control: 'select', options: ['regular', 'medium', 'semibold'] },
    strength: { control: 'select', options: ['subtle', 'strong'] },
    variant: { control: 'select', options: ['default', 'solid'] },
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
          {(['green', 'blue', 'red', 'grey', 'amber'] as BadgeColor[]).map((color) => (
            <Badge key={color} color={color} size={size}>
              size {size}
            </Badge>
          ))}
        </div>
      ))}
    </div>
  ),
};

export const Strength: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['subtle', 'strong'] as BadgeStrength[]).map((strength) => (
        <div key={strength} className="flex flex-col gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
            {strength}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {(['green', 'blue', 'red', 'grey', 'amber'] as BadgeColor[]).map((color) => (
              <Badge key={color} color={color} strength={strength}>
                {color}
              </Badge>
            ))}
          </div>
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

export const WithTooltip: Story = {
  args: {
    children: 'Data protection',
    color: 'blue',
    size: 'sm',
    description: (
      <>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          Data protection
        </p>
        <ul className="flex flex-col gap-0.5">
          <li className="text-xs text-zinc-700">Prevent deletion</li>
          <li className="text-xs text-zinc-700">Prevent overwrite</li>
        </ul>
      </>
    ),
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      {(
        [
          { label: 'Default', variant: 'default', strength: 'subtle' },
          { label: 'Default / Strong', variant: 'default', strength: 'strong' },
          { label: 'Solid', variant: 'solid', strength: 'subtle' },
        ] as { label: string; variant: BadgeVariant; strength: BadgeStrength }[]
      ).map(({ label, variant, strength }) => (
        <div key={label} className="flex flex-col gap-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            {label}
          </p>
          {(['green', 'blue', 'red', 'amber', 'grey'] as BadgeColor[]).map((color) => (
            <div key={color} className="flex flex-col gap-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                {color}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
                  <Badge key={size} color={color} size={size} variant={variant} strength={strength}>
                    {size}
                  </Badge>
                ))}
                {(['sm', 'md', 'lg'] as BadgeSize[]).map((size) => (
                  <Badge
                    key={`dot-${size}`}
                    color={color}
                    size={size}
                    variant={variant}
                    strength={strength}
                    dot
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
