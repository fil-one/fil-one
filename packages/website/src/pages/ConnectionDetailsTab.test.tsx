import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { S3Region, supportsBucketManagement } from '@filone/shared';

import { BucketPrerequisite, ConnectionDetailsTab } from './ConnectionDetailsTab.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

/** CopyButton reports through a toast, so the tab renders inside its provider. */
function renderTab() {
  return render(
    <ToastProvider>
      <ConnectionDetailsTab />
    </ToastProvider>,
  );
}

describe('ConnectionDetailsTab', () => {
  it('offers each client as a tab in one Connect section', () => {
    renderTab();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual([
      'AWS CLI',
      'Python',
      'Node.js',
      'Go',
    ]);
  });

  it('shows the same two steps for the client in view', () => {
    renderTab();

    expect(screen.getByText('Configure the CLI')).toBeInTheDocument();
    expect(screen.getByText('Upload a file')).toBeInTheDocument();
  });

  it('says once, before the code, that a bucket comes from Buckets', () => {
    renderTab();

    expect(screen.getByRole('link', { name: 'Buckets' })).toHaveAttribute('href', '/buckets');
  });

  it('lists the connection facts without a Credentials row', () => {
    renderTab();

    expect(screen.queryByText('Credentials')).not.toBeInTheDocument();
  });
});

describe('BucketPrerequisite', () => {
  it.each([
    ['allows creating a bucket over S3', true],
    ['does not allow it', false],
  ] as const)('points at the CLI step only when the region %s', (_case, allowed) => {
    const region = Object.values(S3Region).find(
      (candidate) => supportsBucketManagement(candidate) === allowed,
    );
    if (!region) throw new Error('No region of this kind to test with');
    render(<BucketPrerequisite region={region} />);

    expect(screen.queryByText(/AWS CLI/) !== null).toBe(allowed);
  });
});
