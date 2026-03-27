import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ConfirmDialog } from './ConfirmDialog';

vi.mock('../../components/Toast/index.js', () => ({
  useToast: () => ({ toast: { error: vi.fn() } }),
}));

describe('ConfirmDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn().mockResolvedValue(undefined),
    title: 'Delete item',
    description: 'Are you sure?',
  };

  it('renders title and description when open', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Delete item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('renders default confirm and cancel labels', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('renders custom labels', () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Remove" cancelLabel="Keep" />);
    expect(screen.getByText('Remove')).toBeInTheDocument();
    expect(screen.getByText('Keep')).toBeInTheDocument();
  });
});
