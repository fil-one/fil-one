import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';

const meta: Meta<typeof Modal> = {
  title: 'Components/Modal',
  component: Modal,
};

export default meta;
type Story = StoryObj<typeof Modal>;

export const Small: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open small modal
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} size="sm">
          <ModalHeader onClose={() => setOpen(false)}>Small Modal</ModalHeader>
          <ModalBody>
            <p>This is a small modal dialog.</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Confirm
            </Button>
          </ModalFooter>
        </Modal>
      </>
    );
  },
};

export const Medium: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open medium modal
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} size="md">
          <ModalHeader onClose={() => setOpen(false)}>Medium Modal</ModalHeader>
          <ModalBody>
            <p>This is a medium modal dialog with more room for content.</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Confirm
            </Button>
          </ModalFooter>
        </Modal>
      </>
    );
  },
};

export const Large: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open large modal
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} size="lg">
          <ModalHeader onClose={() => setOpen(false)}>Large Modal</ModalHeader>
          <ModalBody>
            <p>This is a large modal dialog suitable for complex forms or detailed content.</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Confirm
            </Button>
          </ModalFooter>
        </Modal>
      </>
    );
  },
};
