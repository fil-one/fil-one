import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { QueryBucketResponse } from '@filone/shared';
import { S3Region } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api';
import { QueryAnswer } from './QueryAnswer';

const bucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 1,
  indexSize: 1,
};

const base = {
  bucket,
  question: 'What is the retention period?',
  isPending: false,
  isError: false,
  error: undefined,
  result: undefined as QueryBucketResponse | undefined,
};

// Org-scoped like every other real route now: the sources this renders link
// through `$orgSlug`, so that ancestor needs registering too.
function renderWithRouter(ui: () => React.JSX.Element) {
  const rootRoute = createRootRoute();
  const orgSlugRoute = createRoute({ getParentRoute: () => rootRoute, path: '$orgSlug' });
  const hostRoute = createRoute({
    getParentRoute: () => orgSlugRoute,
    path: '/host',
    component: ui,
  });
  const objectsRoute = createRoute({
    getParentRoute: () => orgSlugRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgSlugRoute.addChildren([hostRoute, objectsRoute])]),
    history: createMemoryHistory({ initialEntries: ['/acme/host'] }),
  });
  return render(<RouterProvider router={router} />);
}

describe('QueryAnswer', () => {
  it('renders nothing when idle with no question, result, or error', () => {
    const { container } = renderWithRouter(() => <QueryAnswer {...base} question={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the loading skeleton while pending', async () => {
    renderWithRouter(() => <QueryAnswer {...base} isPending />);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading answer');
    expect(screen.getByText('"What is the retention period?"')).toBeInTheDocument();
  });

  it('shows the error message when the query fails', async () => {
    renderWithRouter(() => (
      <QueryAnswer {...base} isError error={new globalThis.Error('Query failed')} />
    ));
    expect(await screen.findByText('Query failed')).toBeInTheDocument();
  });

  it('falls back to a generic error for a non-Error rejection', async () => {
    renderWithRouter(() => <QueryAnswer {...base} isError error="boom" />);
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });

  it('renders the answer and source links on success', async () => {
    renderWithRouter(() => (
      <QueryAnswer
        {...base}
        result={{ answer: 'Retention is 90 days.', sources: ['policies/data-retention.pdf'] }}
      />
    ));
    expect(await screen.findByText('Retention is 90 days.')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'data-retention.pdf' })).toBeInTheDocument();
  });
});
