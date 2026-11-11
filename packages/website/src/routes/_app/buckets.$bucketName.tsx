import z from 'zod';
import { createRoute } from '@tanstack/react-router';
import { S3Region } from '@filone/shared';
import { Route as appRoute } from '../_app';
import { BucketDetailPage } from '../../pages/BucketDetailPage';

const bucketSearchSchema = z.object({
  prefix: z.string().optional(),
  region: z.enum(S3Region),
  // The object open in the details panel, kept in the URL so back closes it and a
  // reload keeps it open
  object: z.string().optional(),
  version: z.string().optional(),
});

function BucketDetailRoute() {
  const { bucketName } = Route.useParams();
  const { prefix, region, object, version } = Route.useSearch();
  return (
    <BucketDetailPage
      bucketName={bucketName}
      prefix={prefix}
      region={region}
      openObject={object === undefined ? undefined : { key: object, versionId: version }}
    />
  );
}

export const Route = createRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => appRoute,
  component: BucketDetailRoute,
  validateSearch: bucketSearchSchema,
});
