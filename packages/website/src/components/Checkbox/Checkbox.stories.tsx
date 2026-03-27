import type { Meta, StoryObj } from '@storybook/react-vite';

import { Label } from '../Label';
import { Checkbox } from './Checkbox';

const meta: Meta<typeof Checkbox> = {
  title: 'Components/Checkbox',
  component: Checkbox,
};

export default meta;
type Story = StoryObj<typeof Checkbox>;

export const Default: Story = {
  render: () => (
    <label className="flex items-center gap-2">
      <Checkbox />
      <Label className="cursor-pointer">Accept terms and conditions</Label>
    </label>
  ),
};

export const Checked: Story = {
  render: () => (
    <label className="flex items-center gap-2">
      <Checkbox defaultChecked />
      <Label className="cursor-pointer">Receive notifications</Label>
    </label>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2">
        <Checkbox disabled />
        <Label className="cursor-not-allowed opacity-50">Disabled unchecked</Label>
      </label>
      <label className="flex items-center gap-2">
        <Checkbox disabled defaultChecked />
        <Label className="cursor-not-allowed opacity-50">Disabled checked</Label>
      </label>
    </div>
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2">
        <Checkbox />
        <Label className="cursor-pointer">Unchecked</Label>
      </label>
      <label className="flex items-center gap-2">
        <Checkbox defaultChecked />
        <Label className="cursor-pointer">Checked</Label>
      </label>
      <label className="flex items-center gap-2">
        <Checkbox disabled />
        <Label className="cursor-not-allowed opacity-50">Disabled unchecked</Label>
      </label>
      <label className="flex items-center gap-2">
        <Checkbox disabled defaultChecked />
        <Label className="cursor-not-allowed opacity-50">Disabled checked</Label>
      </label>
    </div>
  ),
};
