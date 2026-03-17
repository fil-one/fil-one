import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '.';

describe('Modal', () => {
  it('renders children when open', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <ModalBody>Modal content</ModalBody>
      </Modal>,
    );
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <Modal open={false} onClose={() => {}}>
        <ModalBody>Hidden content</ModalBody>
      </Modal>,
    );
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
  });

  it('renders header with close button', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose}>
        <ModalHeader onClose={onClose}>Title</ModalHeader>
      </Modal>,
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders footer', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <ModalFooter>Footer content</ModalFooter>
      </Modal>,
    );
    expect(screen.getByText('Footer content')).toBeInTheDocument();
  });
});
