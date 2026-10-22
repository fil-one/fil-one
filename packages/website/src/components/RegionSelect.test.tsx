import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { S3Region } from '@filone/shared';

const mockAvailableRegions = vi.fn<() => S3Region[]>();
vi.mock('../lib/use-available-regions.js', () => ({
  useAvailableRegions: () => mockAvailableRegions(),
}));

import { RegionSelect } from './RegionSelect';

beforeEach(() => {
  mockAvailableRegions.mockReturnValue([S3Region.EuWest1, S3Region.UsEast1]);
});

describe('RegionSelect', () => {
  it('names the field with its label and the chosen region', () => {
    render(<RegionSelect value={S3Region.EuWest1} onChange={() => {}} />);

    expect(
      screen.getByRole('button', { name: 'Region, Europe (France) eu-west-1' }),
    ).toBeInTheDocument();
  });

  it('reports the region picked from the list', async () => {
    const onChange = vi.fn();
    render(<RegionSelect value={S3Region.EuWest1} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /^Region/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'US East (Michigan) us-east-1' }));

    expect(onChange).toHaveBeenCalledWith(S3Region.UsEast1);
  });

  it('is disabled when only one region is available', () => {
    mockAvailableRegions.mockReturnValue([S3Region.EuWest1]);
    render(<RegionSelect value={S3Region.EuWest1} onChange={() => {}} />);

    expect(screen.getByRole('button', { name: /^Region/ })).toBeDisabled();
  });
});
