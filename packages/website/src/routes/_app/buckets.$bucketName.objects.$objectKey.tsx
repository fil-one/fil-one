import { createRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Route as appRoute } from '../_app';
import { ObjectDetailPage } from '../../pages/ObjectDetailPage';

const objectDetailSearchSchema = z.object({
  key: z.string(),
});

function ObjectDetailRoute() {
  const { bucketName } = Route.useParams();
  const { key: objectKey } = Route.useSearch();
  return <ObjectDetailPage bucketName={bucketName} objectKey={objectKey} />;
}

export const Route = createRoute({
  path: '/buckets/$bucketName/objects',
  getParentRoute: () => appRoute,
  component: ObjectDetailRoute,
  validateSearch: objectDetailSearchSchema,
});
