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

// `analytics` is passed positionally rather than defaulted, because a default
// parameter would swallow the explicit `undefined` the loading case needs.
function renderProperties(
  overrides: Partial<Bucket> = {},
  a: BucketAnalyticsResponse | undefined = analytics,
) {
  return render(<BucketProperties bucket={{ ...bucket, ...overrides }} analytics={a} />);
}

describe('BucketProperties', () => {
  it('shows region, storage and creation date inline', () => {
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

  // ---------------------------------------------------------------------------
  // Protection chips: present only when the feature is on
  // ---------------------------------------------------------------------------

  it('shows no protection chips on an ordinary bucket', () => {
    renderProperties();
    expect(screen.queryByText('Versioning')).not.toBeInTheDocument();
    expect(screen.queryByText(/Object Lock/)).not.toBeInTheDocument();
  });

  it('chips versioning when it is on', () => {
    renderProperties({ versioning: true });
    expect(screen.getByText('Versioning')).toBeInTheDocument();
  });

  it('folds the retention policy into the object lock chip', () => {
    renderProperties({
      versioning: true,
      objectLockEnabled: true,
      defaultRetention: 'governance',
      retentionDuration: 15,
      retentionDurationType: 'd',
    });
    expect(screen.getByText('Object Lock · Governance · 15 days')).toBeInTheDocument();
  });

  it('chips object lock without a policy when none is set', () => {
    renderProperties({ versioning: true, objectLockEnabled: true });
    expect(screen.getByText('Object Lock')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // The details disclosure
  // ---------------------------------------------------------------------------

  it('keeps the details collapsed until asked', () => {
    renderProperties();
    const toggle = screen.getByRole('button', { name: /Details/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Keeps multiple versions of each object')).not.toBeInTheDocument();
  });

  it('expands and collapses, and points at the panel it controls', () => {
    renderProperties();
    const toggle = screen.getByRole('button', { name: /Details/ });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Keeps multiple versions of each object')).toBeInTheDocument();
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Hide details/ }));
    expect(screen.queryByText('Keeps multiple versions of each object')).not.toBeInTheDocument();
  });

  it('reads retention as None in the panel when no policy is set', () => {
    renderProperties({ objectLockEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));

    expect(screen.getByText('Default retention').parentElement).toHaveTextContent('None');
  });

  it('gives the full timestamp in the panel, not on the line', () => {
    renderProperties();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));

    expect(screen.getByText('Created').parentElement).toHaveTextContent(/2026/);
  });
});
