import { createRoute } from '@tanstack/react-router'
import { Route as appRoute } from '../_app'
import { BucketDetailPage } from '../../components/pages/BucketDetailPage'

type BucketSearchParams = {
  prefix?: string
}

function BucketDetailRoute() {
  const { bucketName } = Route.useParams()
  const { prefix } = Route.useSearch()
  return <BucketDetailPage bucketName={bucketName} prefix={prefix} />
}

export const Route = createRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => appRoute,
  component: BucketDetailRoute,
  validateSearch: (search: Record<string, unknown>): BucketSearchParams => ({
    prefix: typeof search.prefix === 'string' ? search.prefix : undefined,
  }),
})
