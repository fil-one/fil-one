import { describe, it, expect, vi } from 'vitest';
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

describe('AccessKeysTable — permission detail', () => {
  it('offers a details trigger when a key carries more than its object permissions', () => {
    const keys = [makeKey({ permissions: ['read', 'GetBucketVersioning'] })];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);
    expect(screen.getByTestId('permission-badge-details')).toBeInTheDocument();
  });

  it('counts every permission past the object ones and names the total for a screen reader', () => {
    const keys = [
      makeKey({
        permissions: ['read', 'write', 'GetBucketVersioning', 'CreateBucket'],
        granularPermissions: ['GetObjectVersion'],
      }),
    ];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);

    expect(screen.getByTestId('permission-badge-details')).toMatchObject({
      textContent: '+3',
      ariaLabel: 'Show all 5 permissions',
    });
  });

  it('drops the details trigger when the key carries only object permissions', () => {
    const keys = [makeKey({ permissions: ['read', 'write'] })];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);
    expect(screen.queryByTestId('permission-badge-details')).not.toBeInTheDocument();
  });

  it('opens the details drawer on the bucket-info permission granted', () => {
    const keys = [makeKey({ permissions: ['read', 'GetBucketVersioning'] })];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);

    fireEvent.click(screen.getByTestId('permission-badge-details'));

    expect(
      screen.getByTestId('access-key-details-drawer-section-bucket-management'),
    ).toHaveTextContent('Read bucket versioning');
  });
});

describe('AccessKeysTable — the details drawer', () => {
  const scopedKey = makeKey({
    keyName: 'any-key',
    bucketScope: 'specific',
    buckets: ['bucket-a', 'bucket-b', 'bucket-c', 'bucket-d'],
  });

  it('opens with every bucket listed when the row is clicked', () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);

    fireEvent.click(screen.getByTestId('access-key-row'));

    expect(
      [...screen.getByTestId('access-key-details-buckets').querySelectorAll('li')].map(
        (item) => item.textContent,
      ),
    ).toStrictEqual(['bucket-a', 'bucket-b', 'bucket-c', 'bucket-d']);
  });

  it('opens from the key name button, for a keyboard or screen reader', () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);

    fireEvent.click(screen.getByRole('button', { name: 'any-key' }));

    expect(screen.getByRole('dialog', { name: 'Details for any-key' })).toBeInTheDocument();
  });

  it('stays closed when the row click lands on its checkbox', () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} onBulkDelete={async () => {}} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select any-key' }));

    expect(screen.queryByTestId('access-key-details-drawer')).not.toBeInTheDocument();
  });

  it('says a principal key follows bucket policy in place of a permission list', () => {
    const principalKey: AccessKey = {
      id: '2',
      type: 'principal',
      principalId: 'any-user',
      keyName: 'any-personal-key',
      accessKeyId: 'ACCESS_KEY_PRINCEXAMPL',
      createdAt: '2026-01-15T10:00:00Z',
      status: 'active',
    };
    renderWithProviders(<AccessKeysTable keys={[principalKey]} />);

    fireEvent.click(screen.getByTestId('access-key-row'));

    expect(
      screen.getByTestId('access-key-details-drawer-section-follows-bucket-policy'),
    ).toHaveTextContent("Each bucket's policy decides what it can reach.");
  });

  it('runs Delete key for the open key and closes the drawer', () => {
    const onDelete = vi.fn(async () => {});
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId('access-key-row'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));

    expect({
      deleted: onDelete.mock.calls,
      drawerOpen: screen.queryByTestId('access-key-details-drawer') !== null,
    }).toStrictEqual({ deleted: [[scopedKey.id]], drawerOpen: false });
  });

  it('offers no actions in the drawer when the caller may neither rotate nor delete', () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);

    fireEvent.click(screen.getByTestId('access-key-row'));

    expect(screen.queryByTestId('access-key-details-drawer-footer')).not.toBeInTheDocument();
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
    expect(screen.queryByText('All buckets')).not.toBeInTheDocument();
  });
});

describe('AccessKeysTable — the Buckets column', () => {
  it('lists the first two bucket names and counts the rest', () => {
    const key = makeKey({
      bucketScope: 'specific',
      buckets: ['bucket-a', 'bucket-b', 'bucket-c', 'bucket-d'],
    });
    renderWithProviders(<AccessKeysTable keys={[key]} showBuckets />);

    // The flex gap, not a space character, separates the parts on screen.
    expect(
      [...screen.getByTestId('bucket-summary').children].map((part) => part.textContent),
    ).toStrictEqual(['bucket-a', ',', 'bucket-b', '+2']);
  });

  it('names the scope in sentence case when the key reaches every bucket', () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({ bucketScope: 'all' })]} showBuckets />);

    expect(screen.getByText('All buckets')).toBeInTheDocument();
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

  const serviceKey = makeKey({ id: '1', keyName: 'Backups' });

  it('labels a principal key Personal beside its name and leaves a service key unlabelled', () => {
    const { container } = renderWithProviders(
      <AccessKeysTable keys={[serviceKey, principalKey]} />,
    );
    const badges = [...container.querySelectorAll('[data-key-type]')].map((badge) => [
      badge.closest('[data-testid="access-key-row"]')?.getAttribute('data-access-key-id'),
      badge.textContent,
    ]);
    expect(badges).toStrictEqual([[principalKey.accessKeyId, 'Personal']]);
  });

  it('has no Type column, the type riding in the Name column instead', () => {
    renderWithProviders(<AccessKeysTable keys={[serviceKey, principalKey]} />);
    expect(screen.queryByRole('columnheader', { name: 'Type' })).not.toBeInTheDocument();
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
