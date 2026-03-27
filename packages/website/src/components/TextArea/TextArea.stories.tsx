import type { Meta, StoryObj } from '@storybook/react-vite';

import { Label } from '../Label';
import { TextArea } from './TextArea';

const meta: Meta<typeof TextArea> = {
  title: 'Components/TextArea',
  component: TextArea,
};

export default meta;
type Story = StoryObj<typeof TextArea>;

export const Default: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Label htmlFor="message">Message</Label>
      <TextArea id="message" placeholder="Type your message here..." />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Label htmlFor="dis-msg">Message</Label>
      <TextArea id="dis-msg" placeholder="Cannot edit" disabled />
    </div>
  ),
};

export const WithValue: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Label htmlFor="val-msg">Message</Label>
      <TextArea id="val-msg" defaultValue="This is a pre-filled message with some content." />
    </div>
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Label htmlFor="ta1">Default</Label>
        <TextArea id="ta1" placeholder="Type your message here..." />
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="ta2">With value</Label>
        <TextArea id="ta2" defaultValue="Pre-filled content goes here." />
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="ta3">Disabled</Label>
        <TextArea id="ta3" placeholder="Cannot edit" disabled />
      </div>
    </div>
  ),
};
