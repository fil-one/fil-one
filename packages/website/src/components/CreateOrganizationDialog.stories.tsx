import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { Button } from './Button';
import { CreateOrganizationDialog } from './CreateOrganizationDialog';

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const meta: Meta<typeof CreateOrganizationDialog> = {
  title: 'Components/CreateOrganizationDialog',
  component: CreateOrganizationDialog,
};

export default meta;
type Story = StoryObj<typeof CreateOrganizationDialog>;

/**
 * The avatar starts as a generated monogram from whatever name is typed, and
 * Create stays inert until there is a name to send.
 */
export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [queryClient] = useState(createQueryClient);
    return (
      <QueryClientProvider client={queryClient}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Create organization
        </Button>
        <CreateOrganizationDialog open={open} onClose={() => setOpen(false)} />
      </QueryClientProvider>
    );
  },
};
