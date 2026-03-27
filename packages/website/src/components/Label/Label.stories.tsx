import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from '../Input';
import { Label } from './Label';

const meta: Meta<typeof Label> = {
  title: 'Components/Label',
  component: Label,
};

export default meta;
type Story = StoryObj<typeof Label>;

export const Default: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Label htmlFor="email">Email address</Label>
      <Input id="email" type="email" placeholder="you@example.com" />
    </div>
  ),
};

export const Required: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Label htmlFor="req-email">
        Email address <span className="text-red-500">*</span>
      </Label>
      <Input id="req-email" type="email" placeholder="you@example.com" required />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Label htmlFor="dis-email">Email address</Label>
      <Input id="dis-email" type="email" placeholder="you@example.com" disabled />
    </div>
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Label htmlFor="s1">Email address</Label>
        <Input id="s1" placeholder="you@example.com" />
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="s2">
          Email address <span className="text-red-500">*</span>
        </Label>
        <Input id="s2" placeholder="you@example.com" required />
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="s3">Email address</Label>
        <Input id="s3" placeholder="you@example.com" disabled />
      </div>
    </div>
  ),
};
