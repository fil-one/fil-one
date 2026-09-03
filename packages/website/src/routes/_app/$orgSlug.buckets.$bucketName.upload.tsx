import z from 'zod';
import { S3Region } from '@filone/shared';
import { createRoute } from '@tanstack/react-router';
import { Route as orgSlugRoute } from './$orgSlug';
import { UploadObjectPage } from '../../pages/UploadObjectPage';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';

const uploadObjectSearchSchema = z.object({
  region: z.enum(S3Region),
});

function UploadObjectRoute() {
  const { bucketName } = Route.useParams();
  const { region } = Route.useSearch();
  return (
    <RequirePermissionPage
      permission="objects.write"
      title="Upload object"
      deniedMessage="Uploading objects is not part of your role. You can browse and download what is already stored here."
    >
      <UploadObjectPage bucketName={bucketName} region={region} />
    </RequirePermissionPage>
  );
}

export const Route = createRoute({
  path: '/buckets/$bucketName/upload',
  getParentRoute: () => orgSlugRoute,
  component: UploadObjectRoute,
  validateSearch: uploadObjectSearchSchema,
});
