import { createRoute } from '@tanstack/react-router';
import { isSupportedRegion, type S3Region } from '@filone/shared';
import { Route as appRoute } from '../_app';
import { BucketDetailPage } from '../../pages/BucketDetailPage';
import { FILONE_STAGE } from '../../env';

type BucketSearchParams = {
  prefix?: string;
  region?: S3Region;
};

function BucketDetailRoute() {
  const { bucketName } = Route.useParams();
  const { prefix, region } = Route.useSearch();
  return <BucketDetailPage bucketName={bucketName} prefix={prefix} region={region} />;
}

export const Route = createRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => appRoute,
  component: BucketDetailRoute,
  validateSearch: (search: Record<string, unknown>): BucketSearchParams => ({
    prefix: typeof search.prefix === 'string' ? search.prefix : undefined,
    region:
      typeof search.region === 'string' 
        ? search.region
        : undefined,
  }),
});
