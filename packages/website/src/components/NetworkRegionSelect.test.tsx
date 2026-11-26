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
// exists for: a key on it works at both. No network serves two regions today,
// so us-east-1 stands in as the forge network's second region; the component
// reads only the mocked network list and each region's label.
beforeEach(() => {
  mockNetworks.mockReturnValue([
    { id: 'aurora', regions: [S3Region.EuWest1] },
    { id: 'forge', regions: [S3Region.EuCentral3, S3Region.UsEast1] },
  ]);
});

async function openList() {
  fireEvent.click(screen.getByRole('button', { name: /^Regions/ }));
  return await screen.findAllByRole('option');
}

describe('NetworkRegionSelect', () => {
  it('names the field with every region the chosen network serves', () => {
    render(<NetworkRegionSelect value={S3Region.EuCentral3} onChange={() => {}} />);

    expect(
      screen.getByRole('button', { name: 'Regions, eu-central-3, us-east-1' }),
    ).toBeInTheDocument();
  });

  it('shows the chosen region in the closed field, name and code', () => {
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={() => {}} />);

    expect(screen.getByRole('button', { name: /^Regions/ })).toHaveTextContent(
      'Europe (France)eu-west-1',
    );
  });

  it('shows every region of a multi-region network in the closed field', () => {
    // The field answers "which regions", so the closed control echoes the rows
    // the list drew rather than shortening them to codes.
    render(<NetworkRegionSelect value={S3Region.EuCentral3} onChange={() => {}} />);
    const button = screen.getByRole('button', { name: /^Regions/ });

    expect(button).toHaveTextContent('Europe (Amsterdam)eu-central-3');
    expect(button).toHaveTextContent('US East (Michigan)us-east-1');
  });

  it('offers a row per region, named like any other region', async () => {
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={() => {}} />);

    const options = await openList();

    expect(options.map((o) => o.getAttribute('aria-label'))).toStrictEqual([
      'Europe (France) eu-west-1',
      'Europe (Amsterdam) eu-central-3',
      'US East (Michigan) us-east-1',
    ]);
  });

  it('divides the rows into their networks', async () => {
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={() => {}} />);
    await openList();

    // One rule between each pair of networks, and none before the first.
    expect(document.querySelectorAll('hr')).toHaveLength(1);
  });

  it('ticks the chosen network once, however many regions it serves', async () => {
    render(<NetworkRegionSelect value={S3Region.EuCentral3} onChange={() => {}} />);
    const options = await openList();

    // One tick for the network, not one per region: the key reaches the
    // network, and a tick a row would read as several separate choices.
    const ticks = screen.getAllByTestId('network-tick');
    expect(ticks).toHaveLength(1);

    // And it sits on the chosen network's rows, not another's.
    const forgeRow = options.find((o) => o.getAttribute('data-region') === S3Region.UsEast1);
    expect(ticks[0]!.parentElement).toBe(forgeRow!.parentElement);
  });

  it('reports the region picked', async () => {
    const onChange = vi.fn();
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={onChange} />);

    await openList();
    fireEvent.click(screen.getByRole('option', { name: 'Europe (Amsterdam) eu-central-3' }));

    expect(onChange).toHaveBeenCalledWith(S3Region.EuCentral3);
  });

  it('takes the whole network from a row that is not its first region', async () => {
    const onChange = vi.fn();
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={onChange} />);

    await openList();
    fireEvent.click(screen.getByRole('option', { name: 'US East (Michigan) us-east-1' }));

    // Any region of a network names that network, so the caller is given the
    // one that was clicked rather than the network's first.
    expect(onChange).toHaveBeenCalledWith(S3Region.UsEast1);
  });

  it('highlights a whole network, not the one row under the pointer', async () => {
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={() => {}} />);
    const options = await openList();

    // Every region of a network shares the box that carries the highlight,
    // and no two networks share one, so lighting it lights exactly the rows
    // picking it would take. The lighting itself is CSS: Headless UI's focus
    // does not move under jsdom's synthetic key events — `RegionSelect`,
    // which has no box at all, behaves the same — so there is nothing here
    // for a keyboard test to assert.
    const box = (region: S3Region) =>
      options.find((o) => o.getAttribute('data-region') === region)?.closest('[class*="has-["]');

    expect(box(S3Region.EuCentral3)).toBe(box(S3Region.UsEast1));
    expect(box(S3Region.EuWest1)).not.toBe(box(S3Region.EuCentral3));
    expect(box(S3Region.EuWest1)).not.toBeNull();
  });

  it('shows the network a secondary region belongs to, not that region alone', () => {
    // us-east-1 is the forge network's second region; the field still reads as
    // the whole network, so the user sees what the key will reach.
    render(<NetworkRegionSelect value={S3Region.UsEast1} onChange={() => {}} />);

    expect(
      screen.getByRole('button', { name: 'Regions, eu-central-3, us-east-1' }),
    ).toBeInTheDocument();
  });

  it('is disabled when only one network is available', () => {
    mockNetworks.mockReturnValue([{ id: 'aurora', regions: [S3Region.EuWest1] }]);
    render(<NetworkRegionSelect value={S3Region.EuWest1} onChange={() => {}} />);

    expect(screen.getByRole('button', { name: /^Regions/ })).toBeDisabled();
  });
});
