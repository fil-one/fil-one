import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Dialog, DialogHeader, DialogBody, DialogFooter } from './Dialog';

describe('Dialog', () => {
  it('renders children when open', () => {
    render(
      <Dialog open={true} onClose={() => {}}>
        <DialogBody>Dialog content</DialogBody>
      </Dialog>,
    );
    expect(screen.getByText('Dialog content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <Dialog open={false} onClose={() => {}}>
        <DialogBody>Hidden content</DialogBody>
      </Dialog>,
    );
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
  });

  it('renders header with close button', () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogHeader onClose={onClose}>Title</DialogHeader>
      </Dialog>,
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders footer', () => {
    render(
      <Dialog open={true} onClose={() => {}}>
        <DialogFooter>Footer content</DialogFooter>
      </Dialog>,
    );
    expect(screen.getByText('Footer content')).toBeInTheDocument();
  });
});
