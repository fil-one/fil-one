import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { ConfirmDialog } from './ConfirmDialog';

const meta: Meta<typeof ConfirmDialog> = {
  title: 'Components/ConfirmDialog',
  component: ConfirmDialog,
};

export default meta;
type Story = StoryObj<typeof ConfirmDialog>;

function ConfirmDialogDemo() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        Delete bucket
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          await new Promise((r) => setTimeout(r, 1000));
        }}
        title="Delete bucket"
        description="Are you sure you want to delete this bucket? This action cannot be undone and all objects inside will be permanently removed."
      />
    </>
  );
}

export const Default: Story = {
  render: () => <ConfirmDialogDemo />,
};
