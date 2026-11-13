import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { S3Region } from '@filone/shared';
import type { StorageNetwork } from '@filone/shared';

const mockNetworks = vi.fn<() => StorageNetwork[]>();
vi.mock('@filone/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@filone/shared')>()),
  getAvailableNetworks: () => mockNetworks(),
}));

import { NetworkRegionSelect } from './NetworkRegionSelect';

// Two networks, one of them serving two regions, which is the case the field
// exists for: a key on it works at both.
beforeEach(() => {
  mockNetworks.mockReturnValue([
    { id: 'aurora', regions: [S3Region.EuWest1] },
    { id: 'forge', regions: [S3Region.EuCentral3, S3Region.UsEast9] },
  ]);
});

describe('NetworkRegionSelect', () => {
  it('names the field with every region the chosen network serves', () => {
    render(<NetworkRegionSelect value={S3Region.EuCentral3} onChange={() => {}} />);

    expect(
      screen.getByRole('button', { name: 'Regions, eu-central-3, us-east-9' }),
    ).toBeInTheDocument();
  });

  it('offers one option per network, not per region', async () => {
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /^Regions/ }));

    expect(await screen.findAllByRole('option')).toHaveLength(2);
  });

  it('reports a region of the network picked', async () => {
    const onChange = vi.fn();
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /^Regions/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'eu-central-3, us-east-9' }));

    expect(onChange).toHaveBeenCalledWith(S3Region.EuCentral3);
  });

  it('shows the network a secondary region belongs to, not that region alone', () => {
    // us-east-9 is the forge network's second region; the field still reads as
    // the whole network, so the user sees what the key will reach.
    render(<NetworkRegionSelect value={S3Region.UsEast9} onChange={() => {}} />);

    expect(
      screen.getByRole('button', { name: 'Regions, eu-central-3, us-east-9' }),
    ).toBeInTheDocument();
  });

  it('is disabled when only one network is available', () => {
    mockNetworks.mockReturnValue([{ id: 'aurora', regions: [S3Region.EuWest1] }]);
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={() => {}} />);

    expect(screen.getByRole('button', { name: /^Regions/ })).toBeDisabled();
  });
});
