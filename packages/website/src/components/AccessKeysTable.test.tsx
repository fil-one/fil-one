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
