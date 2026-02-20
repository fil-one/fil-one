import { createRoute } from '@tanstack/react-router'
import { Route as appRoute } from '../_app'
import { BucketDetailPage } from '../../components/pages/BucketDetailPage'

function BucketDetailRoute() {
  const { bucketName } = Route.useParams()
  return <BucketDetailPage bucketName={bucketName} />
}

export const Route = createRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => appRoute,
  component: BucketDetailRoute,
})
