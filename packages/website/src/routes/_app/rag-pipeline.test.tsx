import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

import type { MeResponse } from '@filone/shared';

const mockGetMe = vi.fn();
vi.mock('../../lib/api.js', () => ({
  getMe: (...args: unknown[]) => mockGetMe(...args),
}));

import { Route } from './rag-pipeline.js';
import { RagPipelinePage } from '../../pages/RagPipelinePage.js';
import { queryClient } from '../../lib/query-client.js';

function me(ragAccess: boolean): MeResponse {
  return {
    orgId: 'org-1',
    orgName: 'Acme',
    emailVerified: true,
    email: 'user@example.com',
    name: 'User',
    mfaEnrollments: [],
    ragAccess,
  };
}

describe('rag-pipeline route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  // Route option fields exist at runtime but the public RouteOptions union does
  // not surface `path`/`component`/`beforeLoad` for narrowing — read them via a
  // typed view of the same object.
  const options = Route.options as {
    path: string;
    component: unknown;
    getParentRoute: unknown;
    beforeLoad: (ctx: never) => Promise<void>;
  };

  it('is registered at /rag-pipeline and renders RagPipelinePage', () => {
    expect(options.path).toBe('/rag-pipeline');
    expect(options.component).toBe(RagPipelinePage);
    expect(typeof options.getParentRoute).toBe('function');
  });

  it('lets users with RAG access through the guard', async () => {
    mockGetMe.mockResolvedValue(me(true));
    // beforeLoad resolves without throwing a redirect.
    await expect(options.beforeLoad({} as never)).resolves.toBeUndefined();
  });

  it('redirects users without RAG access to /dashboard', async () => {
    mockGetMe.mockResolvedValue(me(false));
    try {
      await options.beforeLoad({} as never);
      throw new Error('expected beforeLoad to throw a redirect');
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      expect((err as { options: { to?: string } }).options.to).toBe('/dashboard');
    }
  });

  it('lets the request through when /me cannot be fetched (page guards itself)', async () => {
    mockGetMe.mockRejectedValue(new Error('network'));
    await expect(options.beforeLoad({} as never)).resolves.toBeUndefined();
  });
});
