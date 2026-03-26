import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { UploadObjectPage } from '../../pages/UploadObjectPage';

function UploadObjectRoute() {
  const { bucketName } = Route.useParams();
  return <UploadObjectPage bucketName={bucketName} />;
}

export const Route = createRoute({
  path: '/buckets/$bucketName/upload',
  getParentRoute: () => appRoute,
  component: UploadObjectRoute,
});
