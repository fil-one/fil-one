import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { S3Region } from '@filone/shared';

import { BucketRegionChooser } from './BucketRegionChooser';

/**
 * The chooser mounted inside a router, because each choice is a router `Link`
 * to the bucket route, and its `href` is what the test reads.
 */
function withRouter(prefix?: string) {
  const rootRoute = createRootRoute();
  const chooserRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <BucketRegionChooser
        bucketName="any-bucket"
        prefix={prefix}
        regions={[S3Region.UsEast1, S3Region.EuWest1]}
        unavailableRegions={[]}
      />
    ),
  });
  const bucketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chooserRoute, bucketRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
}

function choiceHrefs(): (string | null)[] {
  const choices = within(screen.getByTestId('bucket-region-choices')).getAllByRole('link');
  return choices.map((link) => link.getAttribute('href'));
}

describe('BucketRegionChooser', () => {
  it('keeps the folder the link pointed into on each region choice', async () => {
    render(withRouter('reports/'));
    await screen.findByTestId('bucket-region-choices');

    expect(choiceHrefs()).toStrictEqual([
      '/buckets/any-bucket?prefix=reports%2F&region=us-east-1',
      '/buckets/any-bucket?prefix=reports%2F&region=eu-west-1',
    ]);
  });

  it('opens the bucket root in each region when the link had no folder', async () => {
    render(withRouter());
    await screen.findByTestId('bucket-region-choices');

    expect(choiceHrefs()).toStrictEqual([
      '/buckets/any-bucket?region=us-east-1',
      '/buckets/any-bucket?region=eu-west-1',
    ]);
  });
});
