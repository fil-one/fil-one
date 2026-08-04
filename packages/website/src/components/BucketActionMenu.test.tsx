import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
