import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AccessKey, ServiceAccessKey } from '@filone/shared';
import { AccessKeysTable } from './AccessKeysTable.js';
import { ToastProvider } from './Toast/ToastProvider';
import { formatCalendarDate } from '../lib/time.js';

const USER_1 = '00000000-0000-0000-0000-000000000001';
const USER_2 = '00000000-0000-0000-0000-000000000002';

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

function makeKey(overrides: Partial<ServiceAccessKey>): ServiceAccessKey {
  return {
    type: 'service',
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

describe('AccessKeysTable — a principal-bound key', () => {
  const keys: AccessKey[] = [
    {
      id: '1',
      type: 'principal',
      principalId: 'user-1',
      keyName: 'Test Key',
      accessKeyId: 'ACCESS_KEY_12345EXAMPL',
      createdAt: '2026-01-15T10:00:00Z',
      status: 'active',
    },
  ];

  it('shows Follows bucket policy in Permissions for a principal key', () => {
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);
    expect(screen.getByTestId('permission-badge-follows-bucket-policy')).toHaveTextContent(
      'Follows bucket policy',
    );
  });

  it('shows Per bucket policy in Buckets for a principal key', () => {
    renderWithProviders(<AccessKeysTable keys={keys} showBuckets />);
    expect(screen.getByText('Per bucket policy')).toBeInTheDocument();
    expect(screen.queryByText('All Buckets')).not.toBeInTheDocument();
  });
});

describe('AccessKeysTable — the key type', () => {
  const principalKey: AccessKey = {
    id: '2',
    type: 'principal',
    principalId: 'user-1',
    keyName: 'Laptop',
    accessKeyId: 'ACCESS_KEY_PRINCEXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    status: 'active',
  };

  // The badge renders twice: in its column and inline under the name on small screens.
  it.each([
    ['service', 'Service', makeKey({})],
    ['principal', 'Personal', principalKey],
  ] as const)('labels a %s key %s', (type, label, key) => {
    const { container } = renderWithProviders(<AccessKeysTable keys={[key]} />);
    const badges = [...container.querySelectorAll('[data-key-type]')].map((badge) => [
      badge.getAttribute('data-key-type'),
      badge.textContent,
    ]);
    expect(badges).toEqual([
      [type, label],
      [type, label],
    ]);
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
    userId === USER_1 ? { name: 'Ada Lovelace' } : { name: 'Grace Hopper' };

  it('names the rotator beneath the owner', () => {
    renderWithProviders(
      <AccessKeysTable
        keys={[
          makeKey({ createdBy: USER_1, rotatedBy: USER_2, rotatedAt: '2026-09-11T10:00:00Z' }),
        ]}
        creatorFor={names}
      />,
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(/^Rotated by Grace Hopper on /)).toBeInTheDocument();
  });

  it('shows the column for a rotated key that names no owner', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({ rotatedBy: USER_2 })]} creatorFor={names} />,
    );

    expect(screen.getByText('Created by')).toBeInTheDocument();
    expect(screen.getByText('Rotated by Grace Hopper')).toBeInTheDocument();
  });
});

describe('AccessKeysTable — key status', () => {
  // The status renders twice per row (inline on small screens, in its own
  // column from `sm` up), and jsdom applies no breakpoints, so each appears twice.
  it('shows Expired with the expiry date for an expired key', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({ status: 'expired', expiresAt: '2026-06-01' })]} />,
    );

    expect(screen.getAllByText('Expired')).toHaveLength(2);
    expect(screen.getAllByText(formatCalendarDate('2026-06-01'))).toHaveLength(2);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('shows Active and no date for a key that has not expired yet', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({ status: 'active', expiresAt: '2099-01-01' })]} />,
    );

    expect(screen.getAllByText('Active')).toHaveLength(2);
    expect(screen.queryByText(formatCalendarDate('2099-01-01'))).not.toBeInTheDocument();
  });

  it('has no Last Used column', () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({})]} />);

    expect(screen.queryByRole('columnheader', { name: 'Last Used' })).not.toBeInTheDocument();
  });
});
