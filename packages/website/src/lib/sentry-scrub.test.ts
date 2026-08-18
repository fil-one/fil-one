import { describe, it, expect } from 'vitest';

import { scrubBreadcrumb, scrubEvent, scrubInviteToken } from './sentry-scrub.js';

const LINK = 'https://app.filone.ai/invite/accept#token=super-secret-token';
const SCRUBBED = 'https://app.filone.ai/invite/accept#token=REDACTED';

describe('scrubInviteToken', () => {
  it('redacts the token and keeps the rest of the link', () => {
    expect(scrubInviteToken(LINK)).toBe(SCRUBBED);
  });

  it('redacts a token sitting beside other fragment parameters', () => {
    expect(scrubInviteToken('https://app.filone.ai/invite/accept#a=1&token=secret&b=2')).toBe(
      'https://app.filone.ai/invite/accept#a=1&token=REDACTED&b=2',
    );
  });

  it('leaves a URL with no fragment alone', () => {
    expect(scrubInviteToken('https://app.filone.ai/dashboard')).toBe(
      'https://app.filone.ai/dashboard',
    );
  });

  it('leaves a fragment that is not a token alone', () => {
    expect(scrubInviteToken('https://app.filone.ai/docs#installation')).toBe(
      'https://app.filone.ai/docs#installation',
    );
  });

  it('does not mistake a query parameter for the fragment one', () => {
    // The accept link puts the token in the fragment precisely so it is not a
    // query parameter; a `token` in the query belongs to something else.
    expect(scrubInviteToken('https://app.filone.ai/x?token=abc')).toBe(
      'https://app.filone.ai/x?token=abc',
    );
  });
});

describe('scrubBreadcrumb', () => {
  it('redacts the URL a navigation came from', () => {
    // `history.replaceState` is instrumented, so stripping the fragment is
    // itself the thing that records it.
    const scrubbed = scrubBreadcrumb({
      category: 'navigation',
      data: { from: LINK, to: 'https://app.filone.ai/invite/accept' },
    });

    expect(scrubbed.data).toEqual({ from: SCRUBBED, to: 'https://app.filone.ai/invite/accept' });
  });

  it('redacts a request URL', () => {
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: LINK } }).data?.url).toBe(SCRUBBED);
  });

  it('leaves a breadcrumb with no data alone', () => {
    const breadcrumb = { category: 'console', message: 'hello' };
    expect(scrubBreadcrumb(breadcrumb)).toBe(breadcrumb);
  });
});

describe('scrubEvent', () => {
  it('redacts the location the event was raised at and every breadcrumb on it', () => {
    const scrubbed = scrubEvent({
      type: undefined,
      request: { url: LINK, method: 'GET' },
      breadcrumbs: [{ category: 'navigation', data: { from: LINK, to: LINK } }],
    });

    expect(scrubbed.request?.url).toBe(SCRUBBED);
    expect(scrubbed.request?.method).toBe('GET');
    expect(scrubbed.breadcrumbs?.[0].data).toEqual({ from: SCRUBBED, to: SCRUBBED });
  });

  it('leaves an event carrying neither alone', () => {
    expect(scrubEvent({ type: undefined, message: 'boom' })).toEqual({
      type: undefined,
      message: 'boom',
    });
  });
});
