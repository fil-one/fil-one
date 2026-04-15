import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';
import { CreateAccessKeyModal } from './CreateAccessKeyModal';

const meta: Meta<typeof CreateAccessKeyModal> = {
  title: 'Components/CreateAccessKeyModal',
  component: CreateAccessKeyModal,
};

export default meta;
type Story = StoryObj<typeof CreateAccessKeyModal>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Create access key
        </Button>
        <CreateAccessKeyModal
          open={open}
          onClose={() => setOpen(false)}
          onDone={() => setOpen(false)}
        />
      </>
    );
  },
};
