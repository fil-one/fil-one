import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ListBucketsResponse } from '@filone/shared';

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

import { Route } from './buckets.$bucketName';
import { apiRequest } from '../../lib/api.js';
import { queryClient } from '../../lib/query-client.js';

type Search = { prefix?: string; region?: string };

/** `beforeLoad` reads only the params and search from the router's context bag. */
function runBeforeLoad(search: Search): Promise<unknown> {
  const beforeLoad = Route.options.beforeLoad as unknown as (ctx: {
    params: { bucketName: string };
    search: Search;
  }) => Promise<void>;
  return beforeLoad({ params: { bucketName: 'any-bucket' }, search }).catch((err: unknown) => err);
}

function listBuckets(buckets: { bucketName: string; region: string }[]) {
  vi.mocked(apiRequest).mockResolvedValue({ buckets } as ListBucketsResponse);
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

  it('stays on the route without a region when no bucket has that name', async () => {
    listBuckets([{ bucketName: 'other-bucket', region: 'eu-west-1' }]);

    await expect(runBeforeLoad({})).resolves.toBeUndefined();
  });

  it('does not look up the region when the URL has one', async () => {
    await expect(runBeforeLoad({ region: 'eu-west-1' })).resolves.toBeUndefined();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('shows the not-found state when the URL has no region', () => {
    vi.spyOn(Route, 'useParams').mockReturnValue({ bucketName: 'any-bucket' } as never);
    vi.spyOn(Route, 'useSearch').mockReturnValue({} as never);
    const Component = Route.options.component as React.ComponentType;

    render(<Component />);

    expect(screen.getByTestId('bucket-error').textContent).toBe('Bucket not found');
  });

  it('rejects a region that is not one of ours', () => {
    // `mars-1` is not an S3Region.
    const validate = Route.options.validateSearch as { parse: (input: unknown) => unknown };

    expect(() => validate.parse({ region: 'mars-1' })).toThrow(/region/);
  });
});
