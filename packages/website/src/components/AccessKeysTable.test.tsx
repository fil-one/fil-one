import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('AccessKeysTable: permission detail', () => {
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

  it('counts a bucket-configuration write, alone or beside object permissions', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({ permissions: ['PutBucketCORS'] })]} showPermissions />,
    );
    expect(screen.getByTestId('permission-badge-details')).toMatchObject({
      textContent: '+1',
      ariaLabel: 'Show all 1 permissions',
    });
  });

  it('counts a bucket-configuration write with the other extras', () => {
    const keys = [makeKey({ permissions: ['read', 'GetBucketVersioning', 'PutBucketCORS'] })];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);
    expect(screen.getByTestId('permission-badge-details')).toMatchObject({
      textContent: '+2',
      ariaLabel: 'Show all 3 permissions',
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

  it.each([
    ['alone', ['PutBucketCORS']],
    ['beside object permissions', ['read', 'PutBucketCORS']],
  ] as const)('shows a bucket-configuration write in the drawer, %s', (_, permissions) => {
    const keys = [makeKey({ permissions: [...permissions] })];
    renderWithProviders(<AccessKeysTable keys={keys} showPermissions />);

    fireEvent.click(screen.getByTestId('permission-badge-details'));

    expect(
      screen.getByTestId('access-key-details-drawer-section-bucket-management'),
    ).toHaveTextContent('Set bucket CORS');
  });
});

describe('AccessKeysTable: the details drawer', () => {
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

  it('lists the first five buckets and reveals the rest on Show all', () => {
    const buckets = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'b-6', 'b-7'];
    renderWithProviders(<AccessKeysTable keys={[makeKey({ bucketScope: 'specific', buckets })]} />);
    fireEvent.click(screen.getByTestId('access-key-row'));
    const listed = () =>
      [...screen.getByTestId('access-key-details-buckets').querySelectorAll('li')].map(
        (item) => item.textContent,
      );

    expect(listed()).toStrictEqual(buckets.slice(0, 5));
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(listed()).toStrictEqual(buckets);
  });

  it('shows bucket names as plain text when the caller does not ask for links', () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);
    fireEvent.click(screen.getByTestId('access-key-row'));

    expect(screen.getByTestId('access-key-details-buckets').querySelectorAll('a')).toHaveLength(0);
  });

  it.each([
    ['every bucket', makeKey({ bucketScope: 'all' }), 'All buckets in this region'],
    [
      'bucket policies',
      {
        id: '2',
        type: 'principal',
        principalId: 'any-user',
        keyName: 'any-personal-key',
        accessKeyId: 'ACCESS_KEY_PRINCEXAMPL',
        createdAt: '2026-01-15T10:00:00Z',
        status: 'active',
      } satisfies AccessKey,
      'Per bucket policy',
    ],
  ] as const)('names the scope for a key that reaches %s', (_case, key, scope) => {
    renderWithProviders(<AccessKeysTable keys={[key]} />);
    fireEvent.click(screen.getByTestId('access-key-row'));

    expect(screen.getByTestId('access-key-details-drawer-section-buckets')).toHaveTextContent(
      scope,
    );
  });

  it('opens from the key name button, for a keyboard or screen reader', () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);

    fireEvent.click(screen.getByRole('button', { name: 'any-key' }));

    expect(screen.getByRole('dialog', { name: 'any-key' })).toBeInTheDocument();
  });

  it('moves focus into the drawer when it opens', async () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);

    fireEvent.click(screen.getByRole('button', { name: 'any-key' }));

    const dialog = screen.getByRole('dialog', { name: 'any-key' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('closes on Escape and hands focus back to the key name that opened it', async () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);
    const trigger = screen.getByRole('button', { name: 'any-key' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'any-key' });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'any-key' })).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(trigger);
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

  it('runs Delete from the header menu for the open key and closes the drawer', async () => {
    const onDelete = vi.fn(async () => {});
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId('access-key-row'));
    fireEvent.click(screen.getByRole('button', { name: 'Key actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(scopedKey.id));
    expect(screen.queryByTestId('access-key-details-drawer')).not.toBeInTheDocument();
  });

  // The action's confirm dialog returns focus to whatever held it when it
  // opened, so it has to be the row's name, not the drawer's vanishing menu.
  it('puts focus back on the key name before running an action from the drawer', async () => {
    const focusedWhenDeleting: Element[] = [];
    const onDelete = vi.fn(async () => {
      if (document.activeElement) focusedWhenDeleting.push(document.activeElement);
    });
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId('access-key-row'));
    fireEvent.click(screen.getByRole('button', { name: 'Key actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalled());
    expect(focusedWhenDeleting).toStrictEqual([screen.getByRole('button', { name: 'any-key' })]);
  });

  it('shows the key as the list now has it, updating while the drawer is open', () => {
    const { rerender } = renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);
    fireEvent.click(screen.getByTestId('access-key-row'));

    rerender(
      <ToastProvider>
        <AccessKeysTable keys={[{ ...scopedKey, keyName: 'renamed-key' }]} />
      </ToastProvider>,
    );

    expect(screen.getByRole('dialog', { name: 'renamed-key' })).toBeInTheDocument();
  });

  it('closes when the key it shows leaves the list', async () => {
    const { rerender } = renderWithProviders(
      <AccessKeysTable keys={[scopedKey, makeKey({ id: '9' })]} />,
    );
    fireEvent.click(screen.getAllByTestId('access-key-row')[0]);

    rerender(
      <ToastProvider>
        <AccessKeysTable keys={[makeKey({ id: '9' })]} />
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('access-key-details-drawer')).not.toBeInTheDocument(),
    );
  });

  it('offers no actions in the drawer when the caller may neither rotate nor delete', () => {
    renderWithProviders(<AccessKeysTable keys={[scopedKey]} />);

    fireEvent.click(screen.getByTestId('access-key-row'));

    expect(screen.queryByTestId('access-key-details-drawer-actions')).not.toBeInTheDocument();
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

describe('AccessKeysTable: the Buckets column', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /^Actions for / }));
  }

  it('offers rotation only when the page passes it', async () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({})]} onDelete={async () => {}} />);
    openMenu();

    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rotate' })).not.toBeInTheDocument();
  });

  it('carries both actions when both are on offer', async () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({})]} onDelete={async () => {}} onRotate={async () => {}} />,
    );
    openMenu();

    expect(await screen.findByRole('menuitem', { name: 'Rotate' })).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('answers per row, not per table', async () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: /^Actions for / })[1]);
    expect(screen.queryByRole('menuitem', { name: 'Rotate' })).not.toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('keeps the actions column for a row that may only be rotated', async () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({})]} onRotate={async () => {}} />);
    openMenu();

    expect(await screen.findByRole('menuitem', { name: 'Rotate' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
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
  it('shows Expired without the date in the row, which lives in the drawer', () => {
    renderWithProviders(
      <AccessKeysTable keys={[makeKey({ status: 'expired', expiresAt: '2026-06-01' })]} />,
    );

    // Twice: in the Status column and inline under the name below `sm`.
    expect(screen.getAllByText('Expired')).toHaveLength(2);
    expect(screen.queryByText(formatCalendarDate('2026-06-01'))).not.toBeInTheDocument();
  });

  it.each([
    ['an expired key', 'expired', 'Expired'],
    ['an active key', 'active', 'Expires'],
  ] as const)('labels the expiry date in the drawer for %s', (_case, status, label) => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({ status, expiresAt: '2026-06-01' })]} />);
    fireEvent.click(screen.getByTestId('access-key-row'));

    const facts = [...screen.getByTestId('access-key-details-facts').querySelectorAll('dt')];
    const fact = facts.find((term) => term.textContent === label);
    expect(fact?.nextElementSibling?.textContent).toBe(formatCalendarDate('2026-06-01'));
  });

  it('has no Last Used column', () => {
    renderWithProviders(<AccessKeysTable keys={[makeKey({})]} />);

    expect(screen.queryByRole('columnheader', { name: 'Last Used' })).not.toBeInTheDocument();
  });
});

describe('AccessKeysTable: bulk selection', () => {
  const mine = makeKey({ id: 'mine', keyName: 'mine' });
  const theirs = makeKey({ id: 'theirs', keyName: 'theirs' });
  // A Member may revoke their own key and not a colleague's.
  const canDelete = (key: AccessKey) => key.id === 'mine';

  it('offers a checkbox only on the keys the caller may delete', () => {
    renderWithProviders(
      <AccessKeysTable keys={[mine, theirs]} onBulkDelete={async () => {}} canDelete={canDelete} />,
    );

    expect(
      screen.getAllByRole('checkbox').map((checkbox) => checkbox.getAttribute('aria-label')),
    ).toStrictEqual(['Select all keys', 'Select mine']);
  });

  it('marks select-all as partly checked while only some keys are selected', () => {
    renderWithProviders(
      <AccessKeysTable
        keys={[mine, makeKey({ id: 'also-mine', keyName: 'also-mine' })]}
        onBulkDelete={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select mine' }));

    expect(screen.getByRole('checkbox', { name: 'Select all keys' })).toHaveAttribute(
      'aria-checked',
      'mixed',
    );
  });

  it('bulk-deletes only the keys the caller may delete when all are selected', () => {
    const onBulkDelete = vi.fn(async () => {});
    renderWithProviders(
      <AccessKeysTable keys={[mine, theirs]} onBulkDelete={onBulkDelete} canDelete={canDelete} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all keys' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onBulkDelete.mock.calls).toStrictEqual([[['mine']]]);
  });
});

describe("AccessKeysTable: keyboard order and the drawer's key", () => {
  const personalKey: AccessKey = {
    id: 'personal',
    type: 'principal',
    principalId: 'any-user',
    keyName: 'any-personal-key',
    accessKeyId: 'ACCESS_KEY_PRINCEXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    status: 'active',
  };

  // Each explanation is in the key's drawer, which the name button opens.
  it('keeps the row explanations out of the tab order', () => {
    const { container } = renderWithProviders(
      <AccessKeysTable keys={[personalKey]} showBuckets showPermissions />,
    );

    expect(container.querySelectorAll('[role="note"][tabindex]')).toHaveLength(0);
  });

  it('keeps the drawer open on a key the current filters no longer show', () => {
    const key = makeKey({ id: 'shown-then-filtered', keyName: 'any-key' });
    const other = makeKey({ id: 'still-shown', keyName: 'other-key' });
    const { rerender } = renderWithProviders(
      <AccessKeysTable keys={[key, other]} allKeys={[key, other]} />,
    );
    fireEvent.click(screen.getAllByTestId('access-key-row')[0]);

    // It expires under an Active filter: gone from the rows, still in the list.
    rerender(
      <ToastProvider>
        <AccessKeysTable keys={[other]} allKeys={[{ ...key, status: 'expired' }, other]} />
      </ToastProvider>,
    );

    expect(screen.getByRole('dialog', { name: 'any-key' })).toBeInTheDocument();
  });
});
