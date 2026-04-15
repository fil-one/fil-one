import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { useToast } from './useToast';

import { ToastProvider } from './ToastProvider';

const meta: Meta<typeof ToastProvider> = {
  title: 'Components/Toast',
  component: ToastProvider,
};

export default meta;
type Story = StoryObj<typeof ToastProvider>;

function ToastDemo() {
  const { toast } = useToast();

  return (
    <div className="flex gap-3">
      <Button variant="primary" onClick={() => toast.success('Operation completed successfully!')}>
        Success
      </Button>
      <Button variant="ghost" onClick={() => toast.error('Something went wrong.')}>
        Error
      </Button>
      <Button variant="tertiary" onClick={() => toast.info('Here is some information.')}>
        Info
      </Button>
    </div>
  );
}

export const Default: Story = {
  render: () => <ToastDemo />,
};
