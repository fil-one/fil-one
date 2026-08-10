import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToggleConfirmModal } from './ToggleConfirmModal';

describe('ToggleConfirmModal', () => {
  it('renders the enable copy without pricing when disabled', () => {
    render(
      <ToggleConfirmModal
        enabled={false}
        bucketName="my-docs"
        pending={false}
        open
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('Index this bucket?')).toBeInTheDocument();
    expect(screen.getByText(/Files in “my-docs” become queryable/)).toBeInTheDocument();
    // Indexing is cron-driven, so the dialog must not imply upload-triggered indexing.
    expect(screen.getByText('Ready in')).toBeInTheDocument();
    expect(screen.getByText(/not on upload/)).toBeInTheDocument();
    expect(screen.queryByText(/uploads are indexed automatically/i)).not.toBeInTheDocument();
    // Naming the file types is what prevents enabling an all-images bucket blindly.
    expect(
      screen.getByText(/PDF, Word, PowerPoint, Markdown, HTML, plain text/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\$15/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pricing')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start indexing' })).toBeInTheDocument();
  });

  it('renders the disable copy when enabled', () => {
    render(
      <ToggleConfirmModal
        enabled
        bucketName="my-docs"
        pending={false}
        open
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByText('$15 / TB / month')).not.toBeInTheDocument();
    expect(screen.getByText('Stop indexing this bucket?')).toBeInTheDocument();
    expect(screen.getByText(/“my-docs” will stop being indexed/)).toBeInTheDocument();
    expect(screen.getByText(/index built from them are kept/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop indexing' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <ToggleConfirmModal
        enabled={false}
        bucketName="my-docs"
        pending={false}
        open={false}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByText('Index this bucket?')).not.toBeInTheDocument();
  });

  it('calls onConfirm and onClose from the footer buttons', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ToggleConfirmModal
        enabled={false}
        bucketName="my-docs"
        pending={false}
        open
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start indexing' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables both actions while pending', () => {
    render(
      <ToggleConfirmModal
        enabled={false}
        bucketName="my-docs"
        pending
        open
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Start indexing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
