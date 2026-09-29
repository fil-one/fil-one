import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AccessKey } from '@filone/shared';
import { AccessKeysTable } from './AccessKeysTable.js';
import { ToastProvider } from './Toast/ToastProvider';

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

function makeKey(overrides: Partial<AccessKey>): AccessKey {
  return {
    id: '1',
    keyName: 'Test Key',
    accessKeyId: 'ACCESS_KEY_12345EXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    status: 'active',
    permissions: ['read'],
    bucketScope: 'all',
    ...overrides,
  };
}

describe('AccessKeysTable — bucket-info permissions', () => {
  it('renders a bucket-info group badge when a bucket-info permission is granted', () => {
    const keys = [makeKey({ permissions: ['read', 'GetBucketVersioning'] })];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);
    expect(screen.getByTestId('permission-badge-bucket-info')).toBeInTheDocument();
  });

  it('does not render the bucket-info group badge when no bucket-info permission is granted', () => {
    const keys = [makeKey({ permissions: ['read', 'write'] })];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);
    expect(screen.queryByTestId('permission-badge-bucket-info')).not.toBeInTheDocument();
  });
});

describe('AccessKeysTable — the controls a caller may not use', () => {
  // The table's own gating is prop-driven: a page that finds the caller cannot
  // mint or revoke keys passes undefined, and the surface disappears. That is
  // the shape ApiKeysPage and BucketAccessTab both drive from `usePermissions`.
  it('drops the actions column when revoking is not on offer', () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({})]} showPermissions />);

    expect(screen.queryByRole('button', { name: /actions/i })).not.toBeInTheDocument();
  });

  it('keeps the actions column when it is', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({})]} showPermissions onDelete={async () => {}} />,
    );

    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('drops the empty-state create button when minting is not on offer', () => {
    renderWithProviders(<AccessKeysTable keys={[]} />);

    expect(screen.queryByRole('button', { name: 'Create your first key' })).not.toBeInTheDocument();
  });

  it('keeps the empty-state create button when it is', () => {
    renderWithProviders(<AccessKeysTable keys={[]} onCreateOpen={() => {}} />);

    expect(screen.getByRole('button', { name: 'Create your first key' })).toBeInTheDocument();
  });
});

describe('AccessKeysTable — the row menu', () => {
  /** The menu is a popover, so its items exist only once it is open. */
  function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: 'Key actions' }));
  }

  it('offers rotation only when the page passes it', () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({})]} onDelete={async () => {}} />);
    openMenu();

    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
  });

  it('carries both actions when both are on offer', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({})]} onDelete={async () => {}} onRotate={async () => {}} />,
    );
    openMenu();

    expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('answers per row, not per table', () => {
    // A Member may rotate the key they could still mint and not the one they
    // could not, and both rows keep their Delete.
    renderWithProviders(
      <AccessKeysTable
        keys={[makeKey({ id: '1' }), makeKey({ id: '2', keyName: 'Other' })]}
        onDelete={async () => {}}
        onRotate={async () => {}}
        canRotate={(key) => key.id === '1'}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Key actions' })[1]);
    expect(screen.queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('keeps the actions column for a row that may only be rotated', () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({})]} onRotate={async () => {}} />);
    openMenu();

    expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});

describe('AccessKeysTable — who rotated a key', () => {
  const names = (userId: string) =>
    userId === 'user-1' ? { name: 'Ada Lovelace' } : { name: 'Grace Hopper' };

  it('names the rotator beneath the owner', () => {
    renderWithProviders(
      <AccessKeysTable
        keys={[
          makeKey({ createdBy: 'user-1', rotatedBy: 'user-2', rotatedAt: '2026-09-11T10:00:00Z' }),
        ]}
        creatorFor={names}
      />,
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(/^Rotated by Grace Hopper on /)).toBeInTheDocument();
  });

  it('shows the column for a rotated key that names no owner', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({ rotatedBy: 'user-2' })]} creatorFor={names} />,
    );

    expect(screen.getByText('Created by')).toBeInTheDocument();
    expect(screen.getByText('Rotated by Grace Hopper')).toBeInTheDocument();
  });
});
