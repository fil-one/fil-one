import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { BulkActionsBar } from './BulkActionsBar';

describe('BulkActionsBar', () => {
  it('reports how many rows are selected', () => {
    render(<BulkActionsBar count={7} onClear={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('7 selected')).toBeInTheDocument();
  });

  it('clears the selection', () => {
    const onClear = vi.fn();
    render(<BulkActionsBar count={2} onClear={onClear} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('triggers the bulk action', () => {
    const onDelete = vi.fn();
    render(<BulkActionsBar count={2} onClear={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('takes a different label where deleting is not the word', () => {
    render(<BulkActionsBar count={1} onClear={vi.fn()} onDelete={vi.fn()} deleteLabel="Revoke" />);
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('only sets an id when one is given, so two bars can coexist', () => {
    const { rerender } = render(<BulkActionsBar count={1} onClear={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Delete' })).not.toHaveAttribute('id');

    rerender(
      <BulkActionsBar
        count={1}
        onClear={vi.fn()}
        onDelete={vi.fn()}
        deleteButtonId="objects-bulk"
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('id', 'objects-bulk');
  });
});
