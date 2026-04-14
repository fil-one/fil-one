import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { ChoosePlanDialog } from './ChoosePlanDialog';

const meta: Meta<typeof ChoosePlanDialog> = {
  title: 'Components/Billing/ChoosePlanDialog',
  component: ChoosePlanDialog,
};

export default meta;
type Story = StoryObj<typeof ChoosePlanDialog>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Choose plan
        </Button>
        <ChoosePlanDialog
          open={open}
          onClose={() => setOpen(false)}
          onSelectPayAsYouGo={() => setOpen(false)}
          onContactSales={() => setOpen(false)}
        />
      </>
    );
  },
};
