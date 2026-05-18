import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { FormField } from './FormField';
import { Input } from './Input';

const meta: Meta<typeof FormField> = {
  title: 'Components/FormField',
  component: FormField,
};

export default meta;
type Story = StoryObj<typeof FormField>;

export const Default: Story = {
  render: () => (
    <FormField label="Key name" htmlFor="key-name">
      <Input id="key-name" placeholder="e.g., Production API Key" onChange={() => {}} />
    </FormField>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <FormField
      label="Key name"
      htmlFor="key-name"
      description="A descriptive name helps identify this key in your list."
    >
      <Input id="key-name" placeholder="e.g., Production API Key" onChange={() => {}} />
    </FormField>
  ),
};

export const WithError: Story = {
  render: () => (
    <FormField
      label="Key name"
      htmlFor="key-name"
      description="A descriptive name helps identify this key in your list."
      error='Not allowed: "@", "#"'
    >
      <Input id="key-name" value="Production@Key#1" invalid onChange={() => {}} />
    </FormField>
  ),
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('');
    const invalidChars = [...new Set(value.match(/[^a-zA-Z0-9 _\-.]/g) ?? [])];
    const hasError = invalidChars.length > 0;
    return (
      <FormField
        label="Key name"
        htmlFor="key-name"
        description="A descriptive name helps identify this key in your list."
        error={
          hasError ? `Not allowed: ${invalidChars.map((c) => `"${c}"`).join(', ')}` : undefined
        }
      >
        <Input
          id="key-name"
          value={value}
          invalid={hasError}
          onChange={setValue}
          placeholder="e.g., Production API Key"
        />
      </FormField>
    );
  },
};
