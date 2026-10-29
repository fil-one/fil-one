import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ListBucketsResponse, S3Region } from '@filone/shared';

vi.mock('../_app', () => ({ Route: {} }));
vi.mock('../../lib/api.js', () => ({ apiRequest: vi.fn() }));
// The real states link through the router; these stand-ins show only what the
// route chose to render.
vi.mock('../../pages/BucketDetailPage', () => ({
  BucketDetailPage: () => <p data-testid="bucket-detail" />,
  BucketErrorState: ({ fallback }: { fallback: string }) => (
    <p data-testid="bucket-error">{fallback}</p>
  ),
}));
vi.mock('../../components/BucketRegionChooser', () => ({
  BucketRegionChooser: ({ regions }: { regions: string[] }) => (
    <p data-testid="bucket-region-chooser">{regions.join(' ')}</p>
  ),
}));

import { Route } from './buckets.$bucketName';
import type { BucketRegionLookup } from './buckets.$bucketName';
import { apiRequest } from '../../lib/api.js';
import { queryClient } from '../../lib/query-client.js';

type Search = { prefix?: string; region?: string };

/** `beforeLoad` reads only the params and search from the router's context bag. */
function runBeforeLoad(search: Search): Promise<unknown> {
  const beforeLoad = Route.options.beforeLoad as unknown as (ctx: {
    params: { bucketName: string };
    search: Search;
  }) => Promise<unknown>;
  return beforeLoad({ params: { bucketName: 'any-bucket' }, search }).catch((err: unknown) => err);
}

function listBuckets(
  buckets: { bucketName: string; region: string }[],
  unavailableRegions?: string[],
) {
  vi.mocked(apiRequest).mockResolvedValue({ buckets, unavailableRegions } as ListBucketsResponse);
}

function renderWithoutRegion(regionLookup: BucketRegionLookup) {
  vi.spyOn(Route, 'useParams').mockReturnValue({ bucketName: 'any-bucket' } as never);
  vi.spyOn(Route, 'useSearch').mockReturnValue({} as never);
  vi.spyOn(Route, 'useRouteContext').mockReturnValue({ regionLookup } as never);
  const Component = Route.options.component as React.ComponentType;
  render(<Component />);
}

describe('the bucket detail route', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    queryClient.clear();
  });

  it('redirects to the bucket’s region when the URL has none', async () => {
    listBuckets([
      { bucketName: 'other-bucket', region: 'us-east-1' },
      { bucketName: 'any-bucket', region: 'eu-west-1' },
    ]);

    await expect(runBeforeLoad({ prefix: 'any/prefix/' })).resolves.toMatchObject({
      options: {
        to: '/buckets/$bucketName',
        params: { bucketName: 'any-bucket' },
        search: { prefix: 'any/prefix/', region: 'eu-west-1' },
        replace: true,
      },
    });
  });

  it('leaves the choice to the user when buckets in two regions share the name', async () => {
    listBuckets([
      { bucketName: 'any-bucket', region: 'us-east-1' },
      { bucketName: 'any-bucket', region: 'eu-west-1' },
    ]);

    await expect(runBeforeLoad({})).resolves.toStrictEqual({
      regionLookup: { regions: ['us-east-1', 'eu-west-1'], unavailableRegions: [] },
    });
  });

  it('leaves the choice to the user when a region that may hold the name did not answer', async () => {
    listBuckets([{ bucketName: 'any-bucket', region: 'eu-west-1' }], ['us-east-1']);

    await expect(runBeforeLoad({})).resolves.toStrictEqual({
      regionLookup: { regions: ['eu-west-1'], unavailableRegions: ['us-east-1'] },
    });
  });

  it('stays on the route without a region when no bucket has that name', async () => {
    listBuckets([{ bucketName: 'other-bucket', region: 'eu-west-1' }]);

    await expect(runBeforeLoad({})).resolves.toStrictEqual({
      regionLookup: { regions: [], unavailableRegions: [] },
    });
  });

  it('does not look up the region when the URL has one', async () => {
    await expect(runBeforeLoad({ region: 'eu-west-1' })).resolves.toStrictEqual({
      regionLookup: undefined,
    });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('shows the not-found state when no region holds the name', () => {
    renderWithoutRegion({ regions: [], unavailableRegions: [] });

    expect(screen.getByTestId('bucket-error').textContent).toBe('Bucket not found');
  });

  it('names the failed regions instead of not found when the name may be in one of them', () => {
    renderWithoutRegion({ regions: [], unavailableRegions: ['us-east-1' as S3Region] });

    expect(screen.getByTestId('bucket-error').textContent).toBe(
      'Cannot list buckets in the us-east-1 region. Please try again later.',
    );
  });

  it('offers each region holding the name when the lookup found any', () => {
    renderWithoutRegion({
      regions: ['us-east-1', 'eu-west-1'] as S3Region[],
      unavailableRegions: [],
    });

    expect(screen.getByTestId('bucket-region-chooser').textContent).toBe('us-east-1 eu-west-1');
  });

  it('rejects a region that is not one of ours', () => {
    // `mars-1` is not an S3Region.
    const validate = Route.options.validateSearch as { parse: (input: unknown) => unknown };

    expect(() => validate.parse({ region: 'mars-1' })).toThrow(/region/);
  });
});
