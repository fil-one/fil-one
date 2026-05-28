import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { UploadObjectPage } from '../../pages/UploadObjectPage';
import { S3Region } from '@filone/shared';
import z from 'zod';

const uploadObjectSearchSchema = z.object({
  region: z.enum(S3Region),
});

function UploadObjectRoute() {
  const { bucketName } = Route.useParams();
  const { region } = Route.useSearch();
  return <UploadObjectPage bucketName={bucketName} region={region} />;
}

export const Route = createRoute({
  path: '/buckets/$bucketName/upload',
  getParentRoute: () => appRoute,
  component: UploadObjectRoute,
  validateSearch: uploadObjectSearchSchema,
});
