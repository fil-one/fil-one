import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Select } from './Select';

const meta: Meta<typeof Select> = {
  title: 'Components/Select',
  component: Select,
};

export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = {
  render: () => (
    <Select>
      <option value="eu-west-1">Europe (eu-west-1)</option>
      <option value="us-east-1">US East (us-east-1)</option>
      <option value="ap-southeast-1">Asia Pacific (ap-southeast-1)</option>
    </Select>
  ),
};

export const WithValue: Story = {
  render: () => (
    <Select value="us-east-1" onChange={() => {}}>
      <option value="eu-west-1">Europe (eu-west-1)</option>
      <option value="us-east-1">US East (us-east-1)</option>
      <option value="ap-southeast-1">Asia Pacific (ap-southeast-1)</option>
    </Select>
  ),
};

export const WithPlaceholder: Story = {
  render: () => (
    <Select value="" onChange={() => {}}>
      <option value="" disabled>
        Select a region...
      </option>
      <option value="eu-west-1">Europe (eu-west-1)</option>
      <option value="us-east-1">US East (us-east-1)</option>
      <option value="ap-southeast-1">Asia Pacific (ap-southeast-1)</option>
    </Select>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Select value="" invalid onChange={() => {}}>
      <option value="" disabled>
        Select a region...
      </option>
      <option value="eu-west-1">Europe (eu-west-1)</option>
      <option value="us-east-1">US East (us-east-1)</option>
    </Select>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Select value="eu-west-1" disabled onChange={() => {}}>
      <option value="eu-west-1">Europe (eu-west-1)</option>
    </Select>
  ),
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('eu-west-1');
    return (
      <Select value={value} onChange={setValue}>
        <option value="eu-west-1">Europe (eu-west-1)</option>
        <option value="us-east-1">US East (us-east-1)</option>
        <option value="ap-southeast-1">Asia Pacific (ap-southeast-1)</option>
      </Select>
    );
  },
};
