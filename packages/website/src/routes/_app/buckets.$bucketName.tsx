import z from 'zod';
import { createRoute, redirect } from '@tanstack/react-router';
import { S3Region } from '@filone/shared';
import type { ListBucketsResponse } from '@filone/shared';
import { Route as appRoute } from '../_app';
import { BucketDetailPage, BucketErrorState } from '../../pages/BucketDetailPage';
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

function BucketDetailRoute() {
  const { bucketName } = Route.useParams();
  const { prefix, region } = Route.useSearch();
  // `beforeLoad` redirects whenever the bucket exists, so no region here means
  // no bucket by this name.
  if (!region) {
    return <BucketErrorState bucketName={bucketName} error={null} fallback="Bucket not found" />;
  }
  return <BucketDetailPage bucketName={bucketName} prefix={prefix} region={region} />;
}

export const Route = createRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => appRoute,
  beforeLoad: async ({ params, search }) => {
    if (search.region) return;
    const { buckets } = await queryClient.fetchQuery({
      queryKey: queryKeys.buckets,
      queryFn: () => apiRequest<ListBucketsResponse>('/buckets'),
      staleTime: LIST_STALE_TIME,
    });
    const bucket = buckets.find((b) => b.bucketName === params.bucketName);
    // The listing types a region as any string; only one this console knows
    // can go in the URL.
    const region = regionSchema.safeParse(bucket?.region);
    if (!region.success) return;
    throw redirect({
      to: '/buckets/$bucketName',
      params,
      search: { ...search, region: region.data },
      replace: true,
    });
  },
  component: BucketDetailRoute,
  validateSearch: bucketSearchSchema,
});
