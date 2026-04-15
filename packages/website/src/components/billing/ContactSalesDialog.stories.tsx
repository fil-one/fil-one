import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { ContactSalesDialog } from './ContactSalesDialog';

const meta: Meta<typeof ContactSalesDialog> = {
  title: 'Components/Billing/ContactSalesDialog',
  component: ContactSalesDialog,
};

export default meta;
type Story = StoryObj<typeof ContactSalesDialog>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Contact sales
        </Button>
        <ContactSalesDialog open={open} onClose={() => setOpen(false)} />
      </>
    );
  },
};
