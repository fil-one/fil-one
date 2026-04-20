import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Textarea } from './TextArea';

const meta: Meta<typeof Textarea> = {
  title: 'Components/Textarea',
  component: Textarea,
};

export default meta;
type Story = StoryObj<typeof Textarea>;

export const Default: Story = {
  args: {
    placeholder: 'Enter text...',
  },
};

export const WithValue: Story = {
  args: {
    value: 'This is some existing content.',
    rows: 4,
  },
};

export const Invalid: Story = {
  args: {
    value: 'Invalid content here',
    invalid: true,
    rows: 4,
  },
};

export const Disabled: Story = {
  args: {
    placeholder: 'Disabled textarea',
    disabled: true,
    rows: 4,
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <Textarea
        value={value}
        onChange={setValue}
        rows={5}
        placeholder="Tell us about your use case, questions, or anything else..."
      />
    );
  },
};
