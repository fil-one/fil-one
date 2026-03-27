import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './Input';

const meta: Meta<typeof Input> = {
  title: 'Components/Input',
  component: Input,
  args: {
    placeholder: 'Enter text...',
  },
  argTypes: {
    disabled: { control: 'boolean' },
    type: {
      control: 'select',
      options: ['text', 'email', 'password', 'number', 'search', 'url'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {};

export const WithValue: Story = {
  args: { value: 'hello@example.com', readOnly: true },
};

export const Email: Story = {
  args: { type: 'email', placeholder: 'you@example.com' },
};

export const Password: Story = {
  args: { type: 'password', placeholder: 'Enter password...' },
};

export const Disabled: Story = {
  args: { disabled: true, value: 'Cannot edit this', readOnly: true },
};

export const WithFile: Story = {
  args: { type: 'file' },
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-3 w-80">
      <Input placeholder="Default" />
      <Input value="With value" readOnly aria-label="With value" />
      <Input placeholder="Disabled" disabled />
      <Input type="password" placeholder="Password" />
    </div>
  ),
};
