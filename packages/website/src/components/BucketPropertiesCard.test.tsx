import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { Bucket, BucketAnalyticsResponse } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { BucketProperties } from './BucketPropertiesCard';

const bucket: Bucket = {
  bucketName: 'customer-exports',
  region: S3Region.EuWest1,
  createdAt: '2026-04-17T09:24:00Z',
  isPublic: false,
  versioning: false,
  objectLockEnabled: false,
  encrypted: true,
};

const analytics: BucketAnalyticsResponse = { objectCount: 1, bytesUsed: 72_192 };

function renderProperties(
  overrides: Partial<Bucket> = {},
  a: BucketAnalyticsResponse | undefined = analytics,
) {
  return render(<BucketProperties bucket={{ ...bucket, ...overrides }} analytics={a} />);
}

const openDetails = () => fireEvent.click(screen.getByRole('button', { name: /Details/ }));

describe('BucketProperties', () => {
  // ---------------------------------------------------------------------------
  // The line
  // ---------------------------------------------------------------------------

  it('shows region, storage and creation date', () => {
    renderProperties();
    expect(screen.getByText('Europe (France)')).toBeInTheDocument();
    expect(screen.getByText('72.2 KB used')).toBeInTheDocument();
    expect(screen.getByText(/Created Apr 17, 2026/)).toBeInTheDocument();
  });

  it('holds the storage value while analytics is in flight', () => {
    render(<BucketProperties bucket={bucket} analytics={undefined} />);
    // Never "0 B used", which would be a claim rather than an absence.
    expect(screen.queryByText(/used/)).not.toBeInTheDocument();
  });

  it('keeps the exact timestamp and region code on the title, not on the line', () => {
    renderProperties();
    expect(screen.getByText(/Created Apr 17, 2026/)).toHaveAttribute(
      'title',
      expect.stringContaining('2026') as unknown as string,
    );
    expect(screen.getByText('Europe (France)')).toHaveAttribute('title', 'eu-west-1');
  });

  it('leaves configuration off the line, including when it is on', () => {
    renderProperties({ versioning: true, objectLockEnabled: true });
    // Collapsed, the line carries no state: the panel is where configuration lives.
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // The details panel
  // ---------------------------------------------------------------------------

  it('keeps the panel collapsed until asked', () => {
    renderProperties();
    expect(screen.getByRole('button', { name: /Details/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('Versioning')).not.toBeInTheDocument();
  });

  it('expands and collapses, and points at the panel it controls', () => {
    renderProperties();
    const toggle = screen.getByRole('button', { name: /Details/ });

    openDetails();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeInTheDocument();
    expect(screen.getByText('Versioning')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText('Versioning')).not.toBeInTheDocument();
  });

  it('reports each feature as enabled or disabled', () => {
    renderProperties({ versioning: true, objectLockEnabled: false });
    openDetails();

    expect(screen.getByText('Versioning').parentElement).toHaveTextContent('Enabled');
    expect(screen.getByText('Object Lock').parentElement).toHaveTextContent('Disabled');
    // Always on for every bucket, so it is stated only here.
    expect(screen.getByText('Encryption').parentElement).toHaveTextContent('Enabled');
  });

  it('shows the retention policy when set', () => {
    renderProperties({
      versioning: true,
      objectLockEnabled: true,
      defaultRetention: 'governance',
      retentionDuration: 15,
      retentionDurationType: 'd',
    });
    openDetails();

    expect(screen.getByText('Governance · 15 days')).toBeInTheDocument();
  });

  it('reads retention as None when no policy is set', () => {
    renderProperties({ objectLockEnabled: true });
    openDetails();

    expect(screen.getByText('Retention').parentElement).toHaveTextContent('None');
  });

  it('gives the full timestamp and the region code in the panel', () => {
    renderProperties();
    openDetails();

    expect(screen.getByText('Created').parentElement).toHaveTextContent(/2026/);
    expect(screen.getByText('Region').parentElement).toHaveTextContent('eu-west-1');
  });
});
