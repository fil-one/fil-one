import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './Input';

const meta: Meta<typeof Input> = {
  title: 'Components/Input',
  component: Input,
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {
  args: {
    'aria-label': 'Default input',
    placeholder: 'Enter text...',
  },
};

export const WithValue: Story = {
  args: {
    'aria-label': 'Input with a value',
    value: 'my-bucket-name',
    placeholder: 'e.g., my-bucket-name',
  },
};

export const Invalid: Story = {
  args: {
    'aria-label': 'Invalid input',
    value: 'Production@Key#1',
    placeholder: 'e.g., Production API Key',
    invalid: true,
  },
};

export const Disabled: Story = {
  args: {
    'aria-label': 'Disabled input',
    placeholder: 'Disabled input',
    disabled: true,
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <Input
        aria-label="Example input"
        value={value}
        onChange={setValue}
        placeholder="Type something..."
      />
    );
  },
};
