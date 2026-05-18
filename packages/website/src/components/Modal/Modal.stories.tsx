import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr';
import { Button } from '../Button';
import { Input } from '../Input';
import { Textarea } from '../TextArea';
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

export const ContactForm: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [name, setName] = useState('');
    const [company, setCompany] = useState('');
    const [message, setMessage] = useState('');

    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Talk to an expert
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} size="md">
          <ModalHeader
            description="Have questions about Fil One? Our team is here to help."
            onClose={() => setOpen(false)}
          >
            Talk to an expert
          </ModalHeader>
          <ModalBody>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-(--color-text-base)">Name</label>
                <Input value={name} onChange={setName} placeholder="Your name" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-1.5 text-sm font-medium text-(--color-text-base)">
                  Company name
                  <span className="text-sm font-normal text-(--color-paragraph-text-subtle)">
                    (optional)
                  </span>
                </label>
                <Input value={company} onChange={setCompany} placeholder="Your company" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-(--color-text-base)">
                  How can we help?
                </label>
                <Textarea
                  value={message}
                  onChange={setMessage}
                  rows={5}
                  placeholder="Tell us about your use case, questions, or anything else..."
                />
              </div>
            </div>
          </ModalBody>
          <ModalFooter fullWidth>
            <Button variant="primary" icon={PaperPlaneTiltIcon} onClick={() => setOpen(false)}>
              Send message
            </Button>
          </ModalFooter>
        </Modal>
      </>
    );
  },
};

export const WithDescription: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open modal with description
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} size="md">
          <ModalHeader
            description="Have questions about Fil One? Our team is here to help."
            onClose={() => setOpen(false)}
          >
            Talk to an expert
          </ModalHeader>
          <ModalBody>
            <p>Modal body content goes here.</p>
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

export const FullWidthFooter: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open modal with full-width footer
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} size="md">
          <ModalHeader
            description="This action will permanently delete your data and cannot be undone."
            onClose={() => setOpen(false)}
          >
            Confirm action
          </ModalHeader>
          <ModalBody>
            <p>Modal body content goes here.</p>
          </ModalBody>
          <ModalFooter fullWidth>
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
