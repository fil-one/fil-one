import z from 'zod';
import { createRoute, redirect } from '@tanstack/react-router';
import { S3Region, listBucketsUnavailableMessage } from '@filone/shared';
import type { ListBucketsResponse } from '@filone/shared';
import { Route as appRoute } from '../_app';
import { BucketDetailPage, BucketErrorState } from '../../pages/BucketDetailPage';
import { BucketRegionChooser } from '../../components/BucketRegionChooser';
import { apiRequest } from '../../lib/api.js';
import { LIST_STALE_TIME, queryClient, queryKeys } from '../../lib/query-client.js';

// `region` is optional so that a link without it (a bookmark, a shared URL, a
// refresh of an old link) reaches `beforeLoad`, which looks the region up.
// A region that is present but not one of ours still fails validation.
const regionSchema = z.enum(S3Region);

const bucketSearchSchema = z.object({
  prefix: z.string().optional(),
  region: regionSchema.optional(),
});

/** What the buckets listing says about a name, when it cannot settle on one region. */
export interface BucketRegionsListed {
  /** Regions holding a bucket by this name. */
  regions: S3Region[];
  /** Regions whose listing failed, so they may hold one too. */
  unavailableRegions: S3Region[];
}

/** The buckets listing failed as a whole, so it says nothing about the name. */
export interface BucketListingFailed {
  error: Error;
}

export type BucketRegionLookup = BucketRegionsListed | BucketListingFailed;

async function findBucketRegions(bucketName: string): Promise<BucketRegionLookup> {
  let listing: ListBucketsResponse;
  try {
    listing = await queryClient.fetchQuery({
      queryKey: queryKeys.buckets,
      queryFn: () => apiRequest<ListBucketsResponse>('/buckets'),
      staleTime: LIST_STALE_TIME,
    });
  } catch (err) {
    // Kept for the page to show in the bucket's own error state; thrown out of
    // `beforeLoad`, it would end on the router's generic error page.
    return { error: err instanceof Error ? err : new Error('Cannot list buckets.') };
  }
  const { buckets, unavailableRegions = [] } = listing;
  // The listing types a region as any string; only one this console knows can
  // go in the URL.
  const regions = buckets
    .filter((b) => b.bucketName === bucketName)
    .flatMap((b) => {
      const region = regionSchema.safeParse(b.region);
      return region.success ? [region.data] : [];
    });
  return { regions, unavailableRegions };
}

function BucketDetailRoute() {
  const { bucketName } = Route.useParams();
  const { prefix, region } = Route.useSearch();
  const { regionLookup } = Route.useRouteContext();
  if (region) {
    return <BucketDetailPage bucketName={bucketName} prefix={prefix} region={region} />;
  }
  // `beforeLoad` sets the lookup whenever the URL has no region.
  const lookup = regionLookup ?? { regions: [], unavailableRegions: [] };
  if ('error' in lookup) {
    return (
      <BucketErrorState bucketName={bucketName} error={lookup.error} fallback="Bucket not found" />
    );
  }
  const { regions, unavailableRegions } = lookup;
  if (regions.length === 0) {
    const fallback =
      unavailableRegions.length > 0
        ? listBucketsUnavailableMessage(unavailableRegions)
        : 'Bucket not found';
    return <BucketErrorState bucketName={bucketName} error={null} fallback={fallback} />;
  }
  return (
    <BucketRegionChooser
      bucketName={bucketName}
      prefix={prefix}
      regions={regions}
      unavailableRegions={unavailableRegions}
    />
  );
}

export const Route = createRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => appRoute,
  beforeLoad: async ({ params, search }) => {
    if (search.region) return { regionLookup: undefined };
    const regionLookup = await findBucketRegions(params.bucketName);
    // Open the bucket only when the listing proves it is the one by that name:
    // a second match, or a region that did not answer, leaves the choice to
    // the user.
    if (
      !('error' in regionLookup) &&
      regionLookup.regions.length === 1 &&
      regionLookup.unavailableRegions.length === 0
    ) {
      throw redirect({
        to: '/buckets/$bucketName',
        params,
        search: { ...search, region: regionLookup.regions[0] },
        replace: true,
      });
    }
    return { regionLookup };
  },
  component: BucketDetailRoute,
  validateSearch: bucketSearchSchema,
});
