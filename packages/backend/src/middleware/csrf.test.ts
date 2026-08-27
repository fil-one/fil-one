import { describe, it, expect } from 'vitest';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import {
  expectErrorResponse,
  expectRefreshedCookies,
  REFRESHED_TOKENS,
} from '../test/assert-helpers.js';
import { csrfMiddleware } from './csrf.js';

describe('csrfMiddleware', () => {
  describe('safe methods', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])(
      'passes through %s requests without CSRF check',
      async (method) => {
        const { before } = csrfMiddleware();
        const event = buildEvent({
          requestContext: {
            http: {
              method,
              path: '/test',
              protocol: 'HTTP/1.1',
              sourceIp: '127.0.0.1',
              userAgent: 'test',
            },
          },
        });
        const request = buildMiddyRequest(event);

        const result = await before(request);

        expect(result).toBeUndefined();
      },
    );
  });

  describe('mutating methods', () => {
    const validToken = 'test-csrf-token-123';

    function buildPostEvent(opts: { cookie?: string; header?: string }) {
      const event = buildEvent({
        requestContext: {
          http: {
            method: 'POST',
            path: '/test',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
        },
        ...(opts.cookie ? { cookies: [`hs_csrf_token=${opts.cookie}`] } : {}),
      });
      if (opts.header) {
        event.headers['x-csrf-token'] = opts.header;
      }
      return event;
    }

    it('returns 403 when X-CSRF-Token header is missing', async () => {
      const { before } = csrfMiddleware();
      const event = buildPostEvent({ cookie: validToken });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expectErrorResponse(result, 403, { message: 'CSRF validation failed' });
    });

    it('returns 403 when CSRF cookie is missing', async () => {
      const { before } = csrfMiddleware();
      const event = buildPostEvent({ header: validToken });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expectErrorResponse(result, 403, { message: 'CSRF validation failed' });
    });

    it('returns 403 when header and cookie do not match', async () => {
      const { before } = csrfMiddleware();
      const event = buildPostEvent({ cookie: validToken, header: 'wrong-token' });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expectErrorResponse(result, 403, { message: 'CSRF validation failed' });
    });

    it('passes through when header and cookie match', async () => {
      const { before } = csrfMiddleware();
      const event = buildPostEvent({ cookie: validToken, header: validToken });
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
    });

    it('carries the rotated cookies on its denial', async () => {
      // A stale CSRF token is an ordinary thing after an idle tab wakes up.
      // Dropping the session this request just refreshed would turn it into a
      // logout on every tab the user has open.
      const { before } = csrfMiddleware();
      const request = buildMiddyRequest(buildPostEvent({ cookie: validToken }), {
        internal: { newTokens: REFRESHED_TOKENS },
      });

      expectRefreshedCookies(await before(request));
    });

    it('works for DELETE requests too', async () => {
      const { before } = csrfMiddleware();
      const event = buildEvent({
        requestContext: {
          http: {
            method: 'DELETE',
            path: '/test',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
        },
        cookies: [`hs_csrf_token=${validToken}`],
      });
      event.headers['x-csrf-token'] = validToken;
      const request = buildMiddyRequest(event);

      const result = await before(request);

      expect(result).toBeUndefined();
    });
  });
});
