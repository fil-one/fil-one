import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { S3Region, type AccessKeyPermission, type GranularPermission } from '@filone/shared';
import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields.js';

function Harness({ region }: { region: S3Region }) {
  const [value, setValue] = useState<AccessKeyPermission[]>([]);
  const [granular, setGranular] = useState<GranularPermission[]>([]);
  return (
    <AccessKeyPermissionsFields
      value={value}
      onChange={setValue}
      granularPermissions={granular}
      onGranularPermissionsChange={setGranular}
      region={region}
    />
  );
}

describe('AccessKeyPermissionsFields — bucket-info permissions', () => {
  it('renders the bucket versioning permission checkbox', () => {
    render(<Harness region={S3Region.UsEast1} />);
    expect(screen.getByTestId('permission-GetBucketVersioning')).toBeInTheDocument();
  });

  it('renders the object lock configuration permission checkbox', () => {
    render(<Harness region={S3Region.UsEast1} />);
    expect(screen.getByTestId('permission-GetBucketObjectLockConfiguration')).toBeInTheDocument();
  });

  it('keeps bucket-info permissions enabled in the Aurora region', () => {
    render(<Harness region={S3Region.EuWest1} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Read bucket versioning' });
    expect(checkbox).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('disables bucket-management permissions in the Aurora region', () => {
    render(<Harness region={S3Region.EuWest1} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Create bucket' });
    expect(checkbox).toHaveAttribute('aria-disabled', 'true');
  });

  it('selects a bucket-info permission when its checkbox is toggled', () => {
    render(<Harness region={S3Region.EuWest1} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Read bucket versioning' });
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });
});
