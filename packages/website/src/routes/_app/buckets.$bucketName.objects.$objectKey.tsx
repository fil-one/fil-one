import { createRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Route as appRoute } from '../_app';
import { ObjectDetailPage } from '../../pages/ObjectDetailPage';
import { S3Region } from '@filone/shared';

const objectDetailSearchSchema = z.object({
  key: z.string(),
  region: z.enum(S3Region),
  versionId: z.string().optional(),
});

function ObjectDetailRoute() {
  const { bucketName } = Route.useParams();
  const { key: objectKey, region, versionId } = Route.useSearch();
  return (
    <ObjectDetailPage
      bucketName={bucketName}
      region={region}
      objectKey={objectKey}
      versionId={versionId}
    />
  );
}

export const Route = createRoute({
  path: '/buckets/$bucketName/objects',
  getParentRoute: () => appRoute,
  component: ObjectDetailRoute,
  validateSearch: objectDetailSearchSchema,
});
