import { describe, it, expect, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

vi.mock('../_app', () => ({ Route: {} }));

import { Route } from './organization';

import { parseSearch } from '../../lib/search-params.js';

type Search = { tab?: string; portal_return?: string };
type BeforeLoad = (ctx: { search: Search }) => unknown;

function redirectFor(search: Search) {
  let thrown: unknown;
  try {
    (Route.options.beforeLoad as unknown as BeforeLoad)({ search });
  } catch (err) {
    thrown = err;
  }
  expect(isRedirect(thrown)).toBe(true);
  const {
    to,
    search: nextSearch,
    replace,
  } = (thrown as { options: { to?: string; search?: unknown; replace?: boolean } }).options;
  return { to, search: nextSearch, replace };
}

// `/organization` opened on Members before it split apart. `?tab=billing` is
// Stripe's billing return, and `?tab=invitations` and `?tab=audit` are in
// bookmarks and emailed links, so each still lands where it used to.
describe('the old /organization URL', () => {
  it('opens on Members, as the old page did', () => {
    expect(redirectFor({})).toEqual({ to: '/members', search: {}, replace: true });
    expect(redirectFor({ tab: 'members' })).toEqual({
      to: '/members',
      search: {},
      replace: true,
    });
  });

  it('sends tab=invitations to the Invitations tab of Members', () => {
    expect(redirectFor({ tab: 'invitations' })).toEqual({
      to: '/members',
      search: { tab: 'invitations' },
      replace: true,
    });
  });

  it('sends tab=billing to Billing, carrying portal_return', () => {
    expect(redirectFor({ tab: 'billing', portal_return: '1' })).toEqual({
      to: '/billing',
      search: { portal_return: '1' },
      replace: true,
    });
    expect(redirectFor({ tab: 'billing' })).toEqual({
      to: '/billing',
      search: {},
      replace: true,
    });
  });

  // Through the router's own search parsing, as a real navigation goes:
  // Stripe returns with `portal_return=true`, which a JSON-parsing default
  // would hand the schema as a boolean.
  it("takes Stripe's return string as the URL writes it", () => {
    const search = (Route.options.validateSearch as { parse: (input: unknown) => Search }).parse(
      parseSearch('?tab=billing&portal_return=true'),
    );

    expect(redirectFor(search)).toEqual({
      to: '/billing',
      search: { portal_return: 'true' },
      replace: true,
    });
  });

  it('sends tab=audit to the audit log', () => {
    expect(redirectFor({ tab: 'audit' })).toMatchObject({ to: '/audit', replace: true });
  });
});
