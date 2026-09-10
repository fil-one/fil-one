import { createRoute } from '@tanstack/react-router';
import { Route as orgSlugRoute } from './$orgSlug';
import { CreateBucketPage } from '../../pages/CreateBucketPage';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';

function CreateBucketRoute() {
  return (
    <RequirePermissionPage
      permission="buckets.create"
      title="Create bucket"
      deniedMessage="Creating buckets is not part of your role. Ask an organization owner or admin to create one."
    >
      <CreateBucketPage />
    </RequirePermissionPage>
  );
}

export const Route = createRoute({
  path: '/buckets/create',
  getParentRoute: () => orgSlugRoute,
  component: CreateBucketRoute,
});
