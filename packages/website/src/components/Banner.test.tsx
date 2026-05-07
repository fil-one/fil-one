import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Banner } from './Banner';

describe('Banner', () => {
  it('renders with role=alert', () => {
    render(<Banner>Test message</Banner>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows dismiss button for warning and info variants', () => {
    const { rerender } = render(<Banner variant="warning">msg</Banner>);
    expect(screen.getByLabelText('Dismiss')).toBeInTheDocument();

    rerender(<Banner variant="info">msg</Banner>);
    expect(screen.getByLabelText('Dismiss')).toBeInTheDocument();
  });

  it('does not show dismiss button for error variant', () => {
    render(<Banner variant="error">msg</Banner>);
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument();
  });

  it('removes the banner when dismissed', () => {
    render(<Banner variant="info">msg</Banner>);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('calls onClose when dismissed', () => {
    const onClose = vi.fn();
    render(
      <Banner variant="warning" onClose={onClose}>
        msg
      </Banner>,
    );
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
