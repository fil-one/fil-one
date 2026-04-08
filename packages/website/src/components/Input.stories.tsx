import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './Input';

const meta: Meta<typeof Input> = {
  title: 'Components/Input',
  component: Input,
  args: {
    type: 'text',
  },
  decorators: [
    (Story, ctx) => (
      <div className="flex flex-col gap-1.5 w-80">
        <label htmlFor={ctx.args?.id as string} className="text-[13px] font-medium text-zinc-700">
          {ctx.name}
        </label>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    id: { table: { disable: true } },
  },
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {
  args: {
    id: 'input-default',
    placeholder: 'Enter a value...',
  },
};

export const WithValue: Story = {
  args: {
    id: 'input-with-value',
    defaultValue: 'my-bucket-name',
  },
};

export const Email: Story = {
  args: {
    id: 'input-email',
    type: 'email',
    placeholder: 'you@example.com',
  },
};

export const Password: Story = {
  args: {
    id: 'input-password',
    type: 'password',
    placeholder: 'Enter password...',
  },
};

export const Disabled: Story = {
  args: {
    id: 'input-disabled',
    placeholder: 'Not editable',
    disabled: true,
  },
};

export const AllVariants: Story = {
  decorators: [],
  render: () => (
    <div className="flex flex-col gap-4 w-80">
      {[
        { id: 'av-default', label: 'Default', props: { placeholder: 'Default' } },
        { id: 'av-value', label: 'With value', props: { defaultValue: 'my-bucket-name' } },
        {
          id: 'av-email',
          label: 'Email',
          props: { type: 'email', placeholder: 'you@example.com' },
        },
        {
          id: 'av-password',
          label: 'Password',
          props: { type: 'password', placeholder: 'Password' },
        },
        {
          id: 'av-disabled',
          label: 'Disabled',
          props: { placeholder: 'Disabled', disabled: true },
        },
      ].map(({ id, label, props }) => (
        <div key={id} className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-[13px] font-medium text-zinc-700">
            {label}
          </label>
          <Input id={id} {...props} />
        </div>
      ))}
    </div>
  ),
};
