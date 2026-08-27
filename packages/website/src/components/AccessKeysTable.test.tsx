import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
