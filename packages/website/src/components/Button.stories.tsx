import type { Meta, StoryObj } from '@storybook/react-vite';

import { PlusIcon, TrashIcon, ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Button, type ButtonVariant, type ButtonSize } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  argTypes: {
    variant: { control: 'select', options: ['primary', 'ghost', 'tertiary', 'destructive'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    iconPosition: { control: 'select', options: ['left', 'right'] },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: { variant: 'primary', children: 'Create bucket' },
};

const icons: Record<ButtonVariant, typeof PlusIcon> = {
  primary: PlusIcon,
  ghost: TrashIcon,
  tertiary: ArrowRightIcon,
  destructive: TrashIcon,
};

const labels: Record<ButtonVariant, string> = {
  primary: 'Create',
  ghost: 'Cancel',
  tertiary: 'Learn more',
  destructive: 'Delete',
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-10 p-4">
      {(['primary', 'ghost', 'tertiary', 'destructive'] as ButtonVariant[]).map((variant) => (
        <div key={variant} className="flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{variant}</p>

          {/* Sizes — no icon */}
          <div className="flex items-center gap-3">
            {(['sm', 'md', 'lg'] as ButtonSize[]).map((size) => (
              <Button key={size} variant={variant} size={size}>
                {labels[variant]}
              </Button>
            ))}
          </div>

          {/* Icon left */}
          <div className="flex items-center gap-3">
            {(['sm', 'md', 'lg'] as ButtonSize[]).map((size) => (
              <Button
                key={size}
                variant={variant}
                size={size}
                icon={icons[variant]}
                iconPosition="left"
              >
                {labels[variant]}
              </Button>
            ))}
          </div>

          {/* Icon right */}
          <div className="flex items-center gap-3">
            {(['sm', 'md', 'lg'] as ButtonSize[]).map((size) => (
              <Button
                key={size}
                variant={variant}
                size={size}
                icon={icons[variant]}
                iconPosition="right"
              >
                {labels[variant]}
              </Button>
            ))}
          </div>

          {/* Disabled */}
          <div className="flex items-center gap-3">
            {(['sm', 'md', 'lg'] as ButtonSize[]).map((size) => (
              <Button key={size} variant={variant} size={size} disabled>
                {labels[variant]}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
