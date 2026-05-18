import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';
import { SaveCredentialsModal } from './SaveCredentialsModal';

const meta: Meta<typeof SaveCredentialsModal> = {
  title: 'Components/SaveCredentialsModal',
  component: SaveCredentialsModal,
};

export default meta;
type Story = StoryObj<typeof SaveCredentialsModal>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Show credentials
        </Button>
        <SaveCredentialsModal
          open={open}
          onDone={() => setOpen(false)}
          credentials={{
            accessKeyId: 'ACCESS_KEY_ID_EXAMPLE',
            secretAccessKey: 'SECRET_ACCESS_KEY_EXAMPLE',
          }}
        />
      </>
    );
  },
};
