import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseParams = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useParams: (...args: unknown[]) => mockUseParams(...args),
}));

import { prefixWithOrg, useOrgPath, useOrgSlug } from './use-org-path.js';

describe('prefixWithOrg', () => {
  it('prefixes an internal path with the org slug', () => {
    expect(prefixWithOrg('/buckets', 'acme')).toBe('/acme/buckets');
  });

  it('preserves a search string or hash after the pathname', () => {
    expect(prefixWithOrg('/buckets?region=us-east-1', 'acme')).toBe(
      '/acme/buckets?region=us-east-1',
    );
    expect(prefixWithOrg('/buckets#section', 'acme')).toBe('/acme/buckets#section');
  });

  it('leaves an unscoped path exactly as written', () => {
    expect(prefixWithOrg('/verify-email', 'acme')).toBe('/verify-email');
    expect(prefixWithOrg('/create-organization', 'acme')).toBe('/create-organization');
  });

  it('leaves the path unprefixed when there is no slug to prefix with', () => {
    expect(prefixWithOrg('/buckets', undefined)).toBe('/buckets');
  });

  it('leaves an external or non-internal href untouched', () => {
    expect(prefixWithOrg('https://docs.fil.one', 'acme')).toBe('https://docs.fil.one');
    expect(prefixWithOrg('mailto:support@fil.one', 'acme')).toBe('mailto:support@fil.one');
  });
});

describe('useOrgPath', () => {
  it('prefixes with the active org’s slug read from the route params', () => {
    mockUseParams.mockReturnValue({ orgSlug: 'acme' });

    const { result } = renderHook(() => useOrgPath());

    expect(result.current('/buckets')).toBe('/acme/buckets');
  });

  it('leaves paths unprefixed when useParams throws (no router context)', () => {
    mockUseParams.mockImplementation(() => {
      throw new Error('no router context');
    });

    const { result } = renderHook(() => useOrgPath());

    expect(result.current('/buckets')).toBe('/buckets');
  });
});

describe('useOrgSlug', () => {
  it('returns the active org’s slug', () => {
    mockUseParams.mockReturnValue({ orgSlug: 'acme' });

    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe('acme');
  });

  it('returns an empty string outside any org context', () => {
    mockUseParams.mockImplementation(() => {
      throw new Error('no router context');
    });

    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe('');
  });
});
