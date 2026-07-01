import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region } from '@filone/shared';

import type { RagBucket } from '../lib/rag-bucket-api';
import { QuerySources } from './QuerySources';

const bucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 1,
  indexSize: 1,
};

function renderWithRouter(ui: () => React.JSX.Element) {
  const rootRoute = createRootRoute({ component: ui });
  const objectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([objectsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(<RouterProvider router={router} />);
}

describe('QuerySources', () => {
  it('renders nothing when there are no sources', () => {
    const { container } = renderWithRouter(() => <QuerySources bucket={bucket} sources={[]} />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders one link per source, labelled by basename', async () => {
    renderWithRouter(() => (
      <QuerySources bucket={bucket} sources={['policies/data-retention.pdf', 'top-level.pdf']} />
    ));
    expect(await screen.findByRole('link', { name: 'data-retention.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'top-level.pdf' })).toBeInTheDocument();
  });

  it('forwards the key and bucket region into the object-viewer link', async () => {
    renderWithRouter(() => (
      <QuerySources bucket={bucket} sources={['policies/data-retention.pdf']} />
    ));
    const link = await screen.findByRole('link', { name: 'data-retention.pdf' });
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('/buckets/my-docs-bucket/objects');
    expect(href).toContain('key=policies%2Fdata-retention.pdf');
    expect(href).toContain('region=us-east-1');
  });
});
