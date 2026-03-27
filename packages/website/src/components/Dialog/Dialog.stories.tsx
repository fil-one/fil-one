import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { Dialog, DialogHeader, DialogBody, DialogFooter } from './Dialog';

const meta: Meta<typeof Dialog> = {
  title: 'Components/Dialog',
  component: Dialog,
  parameters: {
    a11y: {
      config: {
        rules: [
          {
            // HeadlessUI injects hidden focus-guard buttons for focus trapping.
            // These are intentionally aria-hidden yet focusable — false positive.
            id: 'aria-hidden-focus',
            selector: '[data-headlessui-focus-guard]',
            enabled: false,
          },
        ],
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Dialog>;

export const Default: Story = {
  render: () => (
    <Dialog open={true} onClose={() => {}}>
      <DialogHeader onClose={() => {}}>Dialog title</DialogHeader>
      <DialogBody>
        <p className="text-sm">This is the dialog body content. You can place any content here.</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => {}}>
          Cancel
        </Button>
        <Button variant="default" onClick={() => {}}>
          Confirm
        </Button>
      </DialogFooter>
    </Dialog>
  ),
};

export const Small: Story = {
  render: () => (
    <Dialog open={true} onClose={() => {}} size="sm">
      <DialogHeader onClose={() => {}}>Small dialog</DialogHeader>
      <DialogBody>
        <p className="text-sm">A smaller dialog for simple confirmations.</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => {}}>
          Cancel
        </Button>
        <Button variant="default" onClick={() => {}}>
          OK
        </Button>
      </DialogFooter>
    </Dialog>
  ),
};

export const Large: Story = {
  render: () => (
    <Dialog open={true} onClose={() => {}} size="lg">
      <DialogHeader onClose={() => {}}>Large dialog</DialogHeader>
      <DialogBody>
        <p className="text-sm">A larger dialog for complex content and forms.</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => {}}>
          Cancel
        </Button>
        <Button variant="default" onClick={() => {}}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  ),
};
