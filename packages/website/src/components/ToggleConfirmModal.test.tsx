import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToggleConfirmModal } from './ToggleConfirmModal';

describe('ToggleConfirmModal', () => {
  it('renders the enable copy without pricing when disabled', () => {
    render(
      <ToggleConfirmModal
        enabled={false}
        pending={false}
        open
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('Enable RAG Pipeline?')).toBeInTheDocument();
    expect(screen.queryByText(/\$15/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pricing')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('renders the disable copy when enabled', () => {
    render(
      <ToggleConfirmModal enabled pending={false} open onClose={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.getByText('Disable RAG Pipeline?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <ToggleConfirmModal
        enabled={false}
        pending={false}
        open={false}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByText('Enable RAG Pipeline?')).not.toBeInTheDocument();
  });

  it('calls onConfirm and onClose from the footer buttons', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ToggleConfirmModal
        enabled={false}
        pending={false}
        open
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables both actions while pending', () => {
    render(
      <ToggleConfirmModal enabled={false} pending open onClose={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
