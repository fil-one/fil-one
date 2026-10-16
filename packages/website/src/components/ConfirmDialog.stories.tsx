import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';

const meta: Meta<typeof ConfirmDialog> = {
  title: 'Components/ConfirmDialog',
  component: ConfirmDialog,
};

export default meta;
type Story = StoryObj<typeof ConfirmDialog>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        {!open && (
          <Button variant="primary" onClick={() => setOpen(true)}>
            Open confirm dialog
          </Button>
        )}
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          onConfirm={() => Promise.resolve()}
          title="Delete bucket?"
          description="This action cannot be undone. All objects in this bucket will be permanently deleted."
        />
      </>
    );
  },
};

export const CustomLabels: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        {!open && (
          <Button variant="primary" onClick={() => setOpen(true)}>
            Open confirm dialog
          </Button>
        )}
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          onConfirm={() => Promise.resolve()}
          title="Revoke API key?"
          description="Any applications using this key will lose access immediately."
          confirmLabel="Revoke"
          cancelLabel="Keep"
        />
      </>
    );
  },
};

// The confirm never settles, so clicking it holds the dialog in its loading
// state: the button keeps its red and shows a spinner beside the label.
export const Confirming: Story = {
  render: () => (
    <ConfirmDialog
      open
      onClose={() => {}}
      onConfirm={() => new Promise<void>(() => {})}
      title="Delete bucket"
      description="This bucket will be permanently deleted. The bucket must be empty: delete its objects and object versions first."
      confirmLabel="Delete bucket"
    />
  ),
};
