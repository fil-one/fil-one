import z from 'zod';
import { createRoute } from '@tanstack/react-router';
import { S3Region } from '@filone/shared';
import { Route as orgSlugRoute } from './$orgSlug';
import { BucketDetailPage } from '../../pages/BucketDetailPage';

const bucketSearchSchema = z.object({
  prefix: z.string().optional(),
  region: z.enum(S3Region),
});

function BucketDetailRoute() {
  const { bucketName } = Route.useParams();
  const { prefix, region } = Route.useSearch();
  return <BucketDetailPage bucketName={bucketName} prefix={prefix} region={region} />;
}

export const Route = createRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => orgSlugRoute,
  component: BucketDetailRoute,
  validateSearch: bucketSearchSchema,
});
