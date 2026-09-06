import type { ComponentType } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { isRedirect } from '@tanstack/react-router';
import type { MeResponse } from '@filone/shared';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
const mockGetMe = vi.fn();
const mockUpdateOrg = vi.fn();

// The route's parent is the root layout, which this component never renders
// inside — only `createRoute` needs it, so an empty stand-in is enough.
vi.mock('./__root.js', () => ({ Route: {} }));

// `useNavigate` is the seam the post-naming redirect is read through; everything
// else about the router stays real so `createRoute`/`redirect` still work.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// `getMe` is faked at the `apiRequest` layer so both the `beforeLoad` read and
// the component's `useQuery` see it; `updateOrg` fakes the save. `errorMessageOf`
// and `logout` stay real so the page behaves as it ships.
vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    getMe: (...args: unknown[]) => mockGetMe(...args),
    updateOrg: (...args: unknown[]) => mockUpdateOrg(...args),
  };
});

import { Route } from './create-organization';
import { queryClient, queryKeys } from '../lib/query-client.js';

const WelcomeRoute = Route.options.component as ComponentType;

const me = (over: Partial<MeResponse>): MeResponse =>
  ({ slug: 'acme', orgName: 'Acme', email: 'a@b.co', ...over }) as unknown as MeResponse;

/** What `beforeLoad` threw (the cookie is present so it reaches the `/me` read). */
function runBeforeLoad(): Promise<unknown> {
  return (Route.options.beforeLoad as () => Promise<void>)().catch((err: unknown) => err);
}

function renderRoute() {
  render(
    <QueryClientProvider client={queryClient}>
      <WelcomeRoute />
    </QueryClientProvider>,
  );
}

describe('the /create-organization route', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    document.cookie = 'hs_logged_in=1';
    mockUpdateOrg.mockResolvedValue({ name: 'Acme' });
  });

  describe('beforeLoad', () => {
    it('sends a caller who arrives already named straight to their dashboard', async () => {
      mockGetMe.mockResolvedValue(me({ nameConfirmed: true }));

      const thrown = await runBeforeLoad();

      expect(isRedirect(thrown)).toBe(true);
      expect((thrown as { options: { href?: string } }).options.href).toBe('/acme/dashboard');
    });

    it('lets an unconfirmed org through to the naming step', async () => {
      mockGetMe.mockResolvedValue(me({ nameConfirmed: false }));

      expect(await runBeforeLoad()).toBeUndefined();
    });
  });

  describe('the naming step', () => {
    beforeEach(() => {
      // The page reads `/me` for its suggested name and target slug; `beforeLoad`
      // primes that cache before the component mounts, so seed it here too rather
      // than let the first render run with no `me` and fall back to `/dashboard`.
      mockGetMe.mockResolvedValue(me({ nameConfirmed: false }));
      queryClient.setQueryData(queryKeys.me, me({ nameConfirmed: false }));
    });

    it('shows the naming form rather than redirecting anywhere', async () => {
      renderRoute();

      expect(
        await screen.findByRole('button', { name: 'Create organization' }),
      ).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('sends the freshly-named account to get-started, never the dashboard', async () => {
      renderRoute();

      fireEvent.change(await screen.findByLabelText('Organization name'), {
        target: { value: 'Acme Storage' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ href: '/acme/get-started' }));
      expect(mockNavigate).not.toHaveBeenCalledWith({ href: '/acme/dashboard' });
    });
  });
});
