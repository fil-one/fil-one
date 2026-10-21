import type { Meta, StoryObj } from '@storybook/react-vite';

import { PlusIcon, TrashIcon, ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Button, type ButtonVariant, type ButtonSize } from './Button';
import { Input, type InputSize } from './Input';
import { Select } from './Select';
import { SplitButton } from './SplitButton';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'ghost', 'tertiary', 'destructive', 'warning'],
    },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    iconPosition: { control: 'select', options: ['left', 'right'] },
    iconSize: { control: 'number' },
    loading: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: { variant: 'primary', children: 'Create bucket' },
};

// iconSize overrides the size-derived glyph (sm=14) so it can carry more weight
// without enlarging the whole control — used by the bucket Upload object button.
export const CustomIconSize: Story = {
  args: {
    variant: 'primary',
    size: 'sm',
    icon: PlusIcon,
    iconPosition: 'left',
    iconSize: 18,
    children: 'Upload object',
  },
};

const icons: Record<ButtonVariant, typeof PlusIcon> = {
  primary: PlusIcon,
  ghost: TrashIcon,
  tertiary: ArrowRightIcon,
  destructive: TrashIcon,
  warning: ArrowRightIcon,
};

const labels: Record<ButtonVariant, string> = {
  primary: 'Create',
  ghost: 'Cancel',
  tertiary: 'Learn more',
  destructive: 'Delete',
  warning: 'Upgrade',
};

export const Loading: Story = {
  args: { variant: 'destructive', children: 'Delete bucket', loading: true },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-10 p-4">
      {(['primary', 'ghost', 'tertiary', 'destructive', 'warning'] as ButtonVariant[]).map(
        (variant) => (
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

            {/* Loading: the variant's colour stays, a spinner takes the icon's place */}
            <div className="flex items-center gap-3">
              {(['sm', 'md', 'lg'] as ButtonSize[]).map((size) => (
                <Button key={size} variant={variant} size={size} loading>
                  {labels[variant]}
                </Button>
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  ),
};

// The base `.button` class sets `whitespace-nowrap`, so a label never breaks
// mid-phrase ("Select / files"). A row too tight for its buttons must give them
// room to reflow — `flex-wrap` here — because a button whose parent is a fixed
// width narrower than its own label will overflow that parent rather than wrap.
export const LabelsNeverWrap: Story = {
  render: () => (
    <div className="flex w-[220px] flex-col gap-5 p-4">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-zinc-500">Row narrower than the pair needs, labels intact:</p>
        <div className="flex flex-wrap gap-2 rounded-md border border-dashed border-zinc-300 p-2">
          <Button variant="ghost" size="sm" icon={PlusIcon}>
            Select files
          </Button>
          <Button variant="ghost" size="sm" icon={PlusIcon}>
            Select folder
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-zinc-500">A long label stays on one line:</p>
        <Button variant="primary" size="sm">
          Generate access key
        </Button>
      </div>
    </div>
  ),
};

// Every control takes its height from `--control-height-*`, so a search field,
// a filter and an action in one row share their top and bottom edges exactly.
// Input and Select stop at `md`, so `lg` has no row here.
export const AlignedWithFormControls: Story = {
  render: () => (
    <div className="flex flex-col gap-6 p-4">
      {(['sm', 'md', 'lg'] as InputSize[]).map((size) => (
        <div key={size} className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{size}</p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-40">
              <Input
                aria-label="Search buckets"
                placeholder="Search buckets"
                inputSize={size}
                onChange={() => {}}
              />
            </div>
            <div className="w-36">
              <Select aria-label="Region" selectSize={size} onChange={() => {}}>
                <option value="eu-west-1">eu-west-1</option>
              </Select>
            </div>
            <Button variant="ghost" size={size}>
              Cancel
            </Button>
            <SplitButton
              size={size}
              label="Download"
              onMainClick={() => {}}
              items={[{ label: 'Download .env', onClick: () => {} }]}
            />
            <Button variant="primary" size={size} icon={PlusIcon}>
              Create bucket
            </Button>
          </div>
        </div>
      ))}
    </div>
  ),
};
