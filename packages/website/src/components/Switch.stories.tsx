import type { Meta, StoryObj } from '@storybook/react-vite';

import { Switch } from './Switch';

const meta: Meta<typeof Switch> = {
  title: 'Components/Switch',
  component: Switch,
  decorators: [
    (Story, ctx) => (
      <div className="flex items-center gap-3">
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
type Story = StoryObj<typeof Switch>;

export const Off: Story = {
  args: {
    id: 'switch-off',
  },
};

export const On: Story = {
  args: {
    id: 'switch-on',
    defaultChecked: true,
  },
};

export const Disabled: Story = {
  args: {
    id: 'switch-disabled',
    disabled: true,
  },
};

export const DisabledOn: Story = {
  args: {
    id: 'switch-disabled-on',
    defaultChecked: true,
    disabled: true,
  },
};

export const AllVariants: Story = {
  decorators: [],
  render: () => (
    <div className="flex flex-col gap-4">
      {[
        { id: 'av-off', label: 'Off', props: {} },
        { id: 'av-on', label: 'On', props: { defaultChecked: true } },
        { id: 'av-disabled', label: 'Disabled', props: { disabled: true } },
        {
          id: 'av-disabled-on',
          label: 'Disabled on',
          props: { defaultChecked: true, disabled: true },
        },
      ].map(({ id, label, props }) => (
        <div key={id} className="flex items-center gap-3">
          <Switch id={id} {...props} />
          <label htmlFor={id} className="text-[13px] font-medium text-zinc-700 cursor-pointer">
            {label}
          </label>
        </div>
      ))}
    </div>
  ),
};
