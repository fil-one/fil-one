import type { Meta, StoryObj } from '@storybook/react-vite';

import { Checkbox } from './Checkbox';

const meta: Meta<typeof Checkbox> = {
  title: 'Components/Checkbox',
  component: Checkbox,
  decorators: [
    (Story, ctx) => (
      <div className="flex items-center gap-2">
        <Story />
        <label
          htmlFor={ctx.args?.id as string}
          className="text-[13px] font-medium text-zinc-700 cursor-pointer"
        >
          {ctx.name}
        </label>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Checkbox>;

export const Unchecked: Story = {
  args: {
    id: 'checkbox-unchecked',
  },
};

export const Checked: Story = {
  args: {
    id: 'checkbox-checked',
    defaultChecked: true,
  },
};

export const Disabled: Story = {
  args: {
    id: 'checkbox-disabled',
    disabled: true,
  },
};

export const DisabledChecked: Story = {
  args: {
    id: 'checkbox-disabled-checked',
    disabled: true,
    defaultChecked: true,
  },
};

export const AllVariants: Story = {
  decorators: [],
  render: () => (
    <div className="flex flex-col gap-3">
      {[
        { id: 'av-unchecked', label: 'Unchecked', props: {} },
        { id: 'av-checked', label: 'Checked', props: { defaultChecked: true } },
        { id: 'av-disabled', label: 'Disabled', props: { disabled: true } },
        {
          id: 'av-disabled-checked',
          label: 'Disabled checked',
          props: { disabled: true, defaultChecked: true },
        },
      ].map(({ id, label, props }) => (
        <div key={id} className="flex items-center gap-2">
          <Checkbox id={id} {...props} />
          <label htmlFor={id} className="text-[13px] font-medium text-zinc-700 cursor-pointer">
            {label}
          </label>
        </div>
      ))}
    </div>
  ),
};
