import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FolderOpenIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import { BucketActionMenu } from './BucketActionMenu';

describe('BucketActionMenu', () => {
  it('is closed by default', () => {
    render(<BucketActionMenu onDisable={() => {}} />);
    expect(screen.queryByRole('menuitem', { name: 'Stop indexing' })).not.toBeInTheDocument();
  });

  it('opens and closes when the trigger is toggled', () => {
    render(<BucketActionMenu onDisable={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Bucket actions' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Stop indexing' })).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menuitem', { name: 'Stop indexing' })).not.toBeInTheDocument();
  });

  it('dismisses on an outside click', () => {
    render(<BucketActionMenu onDisable={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bucket actions' }));
    expect(screen.getByRole('menuitem', { name: 'Stop indexing' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menuitem', { name: 'Stop indexing' })).not.toBeInTheDocument();
  });

  it('calls onDisable and closes when Disable is clicked', () => {
    const onDisable = vi.fn();
    render(<BucketActionMenu onDisable={onDisable} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bucket actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop indexing' }));
    expect(onDisable).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem', { name: 'Stop indexing' })).not.toBeInTheDocument();
  });

  describe('actions list', () => {
    const actions = [
      { label: 'Browse objects', icon: FolderOpenIcon, onSelect: vi.fn() },
      {
        label: 'Delete bucket',
        icon: TrashIcon,
        onSelect: vi.fn(),
        disabled: true,
        hint: 'Not available yet',
      },
    ];

    it('renders every action, with disabled ones inert', () => {
      render(<BucketActionMenu actions={actions} />);
      fireEvent.click(screen.getByTestId('bucket-action-menu-trigger'));

      expect(screen.getByRole('menuitem', { name: /Browse objects/ })).toBeEnabled();
      const remove = screen.getByRole('menuitem', { name: /Delete bucket/ });
      expect(remove).toBeDisabled();
      expect(remove).toHaveTextContent('Not available yet');
    });

    it('calls the selected action and closes', () => {
      render(<BucketActionMenu actions={actions} />);
      fireEvent.click(screen.getByTestId('bucket-action-menu-trigger'));
      fireEvent.click(screen.getByRole('menuitem', { name: /Browse objects/ }));

      expect(actions[0]!.onSelect).toHaveBeenCalledOnce();
      expect(screen.queryByRole('menuitem', { name: /Browse objects/ })).not.toBeInTheDocument();
    });

    it('derives a test id from the label', () => {
      render(<BucketActionMenu actions={actions} />);
      fireEvent.click(screen.getByTestId('bucket-action-menu-trigger'));
      expect(screen.getByTestId('bucket-action-menu-browse-objects')).toBeInTheDocument();
    });

    it('takes precedence over the onDisable shorthand', () => {
      render(<BucketActionMenu actions={actions} onDisable={() => {}} />);
      fireEvent.click(screen.getByTestId('bucket-action-menu-trigger'));
      expect(screen.queryByRole('menuitem', { name: 'Stop indexing' })).not.toBeInTheDocument();
    });
  });
});
