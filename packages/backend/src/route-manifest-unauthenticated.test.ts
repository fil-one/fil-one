import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ROUTE_MANIFEST } from '@filone/shared';
import { sstResourceMock } from './test/sst-resource-mock.js';
import { buildContext, buildEvent } from './test/lambda-test-utilities.js';

/**
 * What each route answers a caller who presents nothing at all: no cookies, no
 * Authorization header.
 *
 * The one claim its sibling file cannot make. Stubbing `authMiddleware` is what
 * lets that file drive roles through the gates behind it, and it also means a
 * handler that dropped `authMiddleware` from its chain would pass every case
 * there — the stub it no longer installs was doing nothing anyway. So this file
 * mocks no part of auth and runs the real middleware, which reads the cookies
 * that are not there and refuses.
 *
 * The manifest supplies the routes and their categories, so a route added to it
 * is covered the moment it is declared. What each open route answers instead of
 * a denial is pinned per route below, because there is no general form of it: a
 * missing webhook signature is a 400, and a login round trip is a redirect.
 */

// Read at import time by the service-orchestrator registry and by the auth
// middleware. The Auth0 values are never used against a live tenant: no request
// carries a token, so nothing is ever verified and the JWKS set is built but
// never fetched from.
process.env.FILONE_STAGE ??= 'test';
process.env.FTH_MANAGEMENT_API_URL ??= 'https://fth.test.invalid';
process.env.AUTH0_DOMAIN ??= 'test.auth0.invalid';
process.env.AUTH0_AUDIENCE ??= 'https://api.test.invalid';
process.env.WEBSITE_URL ??= 'https://console.test.invalid';

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;

// The same resource list the sibling file uses, for the same reason: this file
// imports every route in the manifest, so it reaches resources no single
// handler test does.
vi.mock('sst', () =>
  sstResourceMock({
    BillingTable: { name: 'BillingTable' },
    BulkDeleteQueue: { url: 'https://sqs.test.invalid/bulk-delete' },
    BulkDeleteTable: { name: 'BulkDeleteTable' },
    DeletionChallengeTable: { name: 'DeletionChallengeTable' },
    DeletionCodeHmacKey: { value: 'test-deletion-hmac-key' },
    ForgeManagementApiToken: { value: 'test-forge-token' },
    ForgeDevManagementApiToken: { value: 'test-forge-dev-token' },
    FthManagementApiToken: { value: 'test-fth-token' },
    RagIndexerTable: { name: 'RagIndexerTable' },
    RagVectorBucket: { name: 'RagVectorBucket' },
    SendGridApiKey: { value: 'test-sendgrid-key' },
    StripePriceId: { value: 'price_test_fake' },
    StripePublishableKey: { value: 'pk_test_fake' },
    StripeSecretKey: { value: 'sk_test_fake' },
  }),
);

// Both ways out of the process reject, so a route that answered without
// refusing first cannot do it quietly: it fails on the call it should never
// have reached. Nothing in this file is supposed to touch either — a request
// with no credentials is settled from what is on the event.
vi.mock('./lib/ddb-client.js', () => ({
  getDynamoClient: () => ({
    send: () => Promise.reject(new Error('DynamoDB is unreachable in this test')),
  }),
}));
vi.stubGlobal('fetch', () => Promise.reject(new Error('the network is unreachable in this test')));

type LambdaModule = {
  handler: (event: unknown, context: unknown) => Promise<APIGatewayProxyResultV2>;
};

/**
 * Run one route's real chain against a request carrying no credentials.
 *
 * `.ts`, against the repo's usual `.js` specifiers: a dynamic import with a
 * variable in it compiles to a glob over the literal part of the pattern, and
 * `./handlers/*.js` matches nothing on disk.
 */
async function invokeUnauthenticated(handler: string): Promise<APIGatewayProxyStructuredResultV2> {
  const module = (await import(`./handlers/${handler}.ts`)) as LambdaModule;
  return (await module.handler(buildEvent(), buildContext())) as APIGatewayProxyStructuredResultV2;
}

function bodyMessage(result: APIGatewayProxyStructuredResultV2): string | undefined {
  try {
    return (JSON.parse(result.body ?? '{}') as { message?: string }).message;
  } catch {
    return undefined;
  }
}

/** Where a redirect points, with the query string dropped. */
function redirectTarget(result: APIGatewayProxyStructuredResultV2): string {
  return String(result.headers?.Location ?? '').split('?')[0];
}

/** The auth middleware logs every refusal; the run is not the place to read it. */
function quietRefusalLog(): void {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}

/**
 * Every route that expects a session — the permission-gated ones, the
 * body-dependent ones, the self-service ones, and the RAG query route on its
 * cookie branch, which delegates to the same middleware when no Authorization
 * header is present.
 */
const behindASession = ROUTE_MANIFEST.filter(
  (route) => route.category === 'authenticated' || route.category === 'bearer',
).map((route) => route.handler);

describe('routes behind a session refuse a request carrying no credentials', () => {
  quietRefusalLog();

  it.each(behindASession)('%s answers 401', async (handler) => {
    const result = await invokeUnauthenticated(handler);

    expect(result.statusCode).toBe(401);
  });
});

/**
 * What each open route answers instead. The login round trip is three
 * redirects — out to Auth0, back to the error page when the callback carries no
 * authorization code, and out to Auth0's logout — and the webhook refuses an
 * unsigned body. Pinned per route because the answers have nothing in common
 * beyond not being a denial.
 */
const OPEN_ROUTE_ANSWERS: Record<string, (result: APIGatewayProxyStructuredResultV2) => void> = {
  'auth-login': (result) => {
    expect(result.statusCode).toBe(302);
    expect(redirectTarget(result)).toBe(`https://${AUTH0_DOMAIN}/authorize`);
  },
  // No `code` and no `state`, so the callback never reaches the token exchange
  // and sends the caller to the console's login-error page.
  'auth-callback': (result) => {
    expect(result.statusCode).toBe(302);
    expect(result.headers?.Location).toBe(
      `${process.env.WEBSITE_URL}/login-error?error=Authentication%20failed`,
    );
  },
  'auth-logout': (result) => {
    expect(result.statusCode).toBe(302);
    expect(redirectTarget(result)).toBe(`https://${AUTH0_DOMAIN}/v2/logout`);
  },
  // The signature is the webhook's whole authentication, and a body arriving
  // without one is refused before anything is read or written.
  'stripe-webhook': (result) => {
    expect(result.statusCode).toBe(400);
    expect(bodyMessage(result)).toBe('Missing stripe-signature header');
  },
};

const openRoutes = ROUTE_MANIFEST.filter(
  (route) => route.category === 'public' || route.category === 'webhook',
).map((route) => route.handler);

describe('routes that take no session answer on their own terms', () => {
  quietRefusalLog();

  it.each(openRoutes)('%s does not refuse the caller for having no session', async (handler) => {
    const result = await invokeUnauthenticated(handler);

    expect([401, 403]).not.toContain(result.statusCode);
  });

  it.each(openRoutes)('%s answers what it is there to answer', async (handler) => {
    const pin = OPEN_ROUTE_ANSWERS[handler];
    // A new open route with no pin is the case this file exists to catch: it
    // reaches the internet with no credential check, and nothing here says what
    // it does with an anonymous caller.
    expect(pin, `add an OPEN_ROUTE_ANSWERS entry for ${handler}`).toBeDefined();

    pin(await invokeUnauthenticated(handler));
  });
});
