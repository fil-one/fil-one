import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, OrgRole, ROUTE_MANIFEST, roleHasPermission } from '@filone/shared';
import type { Permission, RouteManifestEntry } from '@filone/shared';
import type { OrgMembership } from './lib/org-membership.js';
import { sstResourceMock } from './test/sst-resource-mock.js';
import { authPartialMock } from './test/auth-partial-mock.js';
import {
  buildContext,
  buildEvent,
  membershipFor,
  NO_MEMBERSHIP,
} from './test/lambda-test-utilities.js';

/**
 * The manifest's completeness check, which only the backend can make: the
 * shared package declares every route and what it requires, and this test is
 * what stops that declaration from drifting away from the handlers it
 * describes. A new route with no manifest entry is a red build rather than an
 * ungated endpoint nobody notices.
 *
 * Both halves matter. The first is coverage — every handler module is named by
 * the manifest and every manifest entry names a real module. The second is
 * enforcement — every route the manifest gates on a permission refuses the
 * roles that do not hold it, proved by running the route's own Middy chain.
 */

const HANDLERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'handlers');

// The service-orchestrator registry builds its API clients as it is imported and
// reads their base URLs from the environment, so a handler that reaches storage
// needs these set before the first import. No request is ever sent: the gate
// refuses the caller first, and an unreachable host would be a 500 rather than
// the 403 every case here asserts.
process.env.FILONE_STAGE ??= 'test';
process.env.FTH_MANAGEMENT_API_URL ??= 'https://fth.test.invalid';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

// Two mocks stand between the chains and the world. The `sst` one answers the
// resource reads a handler module makes while it is being imported; the auth
// one stands in for the middleware that would have resolved a cookie session,
// so the caller arrives on the event instead. Nothing else is mocked — see the
// derived suite below.
//
// This suite imports every gated handler, so it reaches resources no single
// handler test does: the argument covers what the shared list leaves out. The
// values are never read, only their presence — a handler that reads one at
// import time throws on `undefined` before any test runs.
vi.mock('sst', () =>
  sstResourceMock({
    BillingTable: { name: 'BillingTable' },
    BulkDeleteQueue: { url: 'https://sqs.test.invalid/bulk-delete' },
    BulkDeleteTable: { name: 'BulkDeleteTable' },
    DeletionChallengeTable: { name: 'DeletionChallengeTable' },
    DeletionCodeHmacKey: { value: 'test-deletion-hmac-key' },
    ForgeManagementApiToken: { value: 'test-forge-token' },
    FthManagementApiToken: { value: 'test-fth-token' },
    RagIndexerTable: { name: 'RagIndexerTable' },
    RagVectorBucket: { name: 'RagVectorBucket' },
    SendGridApiKey: { value: 'test-sendgrid-key' },
    StripePriceId: { value: 'price_test_fake' },
    StripePublishableKey: { value: 'pk_test_fake' },
    StripeSecretKey: { value: 'sk_test_fake' },
  }),
);
vi.mock('./middleware/auth.js', () => authPartialMock());

function handlerModules(): string[] {
  return readdirSync(HANDLERS_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

function handlerSource(handler: string): string {
  return readFileSync(path.join(HANDLERS_DIR, `${handler}.ts`), 'utf8');
}

/** A manifest value inside a regexp: `buckets.read` must not match `bucketsxread`. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a gate is installed and installed before the subscription guard.
 * Both `.use()` calls are in the same chain expression, so their order in the
 * file is the order the request meets them.
 */
function gateRunsFirst(source: string, gate: string): boolean {
  const gateAt = source.indexOf(`.use(${gate}`);
  const guardAt = source.indexOf('.use(subscriptionGuardMiddleware(');
  if (gateAt === -1) return false;
  return guardAt === -1 || gateAt < guardAt;
}

const byRequirement = (requires: RouteManifestEntry['requires']) =>
  ROUTE_MANIFEST.filter(
    (route) => route.category === 'authenticated' && route.requires === requires,
  );

/**
 * The gated routes with their declared permission, narrowed rather than cast:
 * the permission each route is checked for comes from the manifest entry
 * itself, so a test can never assert against a requirement the manifest does
 * not declare.
 */
const permissionGated: { handler: string; permission: Permission }[] = ROUTE_MANIFEST.filter(
  (route) => route.category === 'authenticated',
).flatMap((route) =>
  route.requires === undefined || route.requires === 'self' || route.requires === 'in-handler'
    ? []
    : [{ handler: route.handler, permission: route.requires }],
);

describe('route manifest coverage', () => {
  it('names every handler module in packages/backend/src/handlers', () => {
    const declared = ROUTE_MANIFEST.map((route) => route.handler).sort();
    const modules = handlerModules();
    // Fails in both directions on purpose: a handler with no entry is an
    // ungated route, and an entry with no handler is a stale declaration that
    // would make the checks below vacuously pass.
    const undeclared = modules.filter((module) => !declared.includes(module));
    const stale = declared.filter((handler) => !modules.includes(handler));
    expect(
      undeclared.map(
        (module) => `add a manifest entry for ${module}, or move shared code out of src/handlers/`,
      ),
    ).toStrictEqual([]);
    expect(stale).toStrictEqual([]);
  });

  it('gates the in-handler routes on membership, ahead of the billing read', () => {
    // A route whose permission depends on the body still has a requirement that
    // does not: being in the org. Left to the handler alone, this PR would ship
    // four routes a non-member reaches, and their denials would be invisible to
    // NotAMemberDenialCount.
    const ungated = byRequirement('in-handler')
      .filter(
        (route) => !gateRunsFirst(handlerSource(route.handler), 'requireMembershipMiddleware('),
      )
      .map((route) => route.handler);
    expect(ungated).toStrictEqual([]);
  });

  it('leaves the self-service routes without an org-permission gate', () => {
    // `self` waives the role gate: changing your own password or unenrolling
    // your own authenticator is not an org action, and gating it on a role
    // would lock a ReadOnly member out of their own account.
    const gated = byRequirement('self')
      .filter((route) => /\bauthorize\(/.test(handlerSource(route.handler)))
      .map((route) => route.handler);
    expect(gated).toStrictEqual([]);
  });

  it('leaves the routes that bypass the cookie session without an authorize call', () => {
    const gated = ROUTE_MANIFEST.filter(
      (route) => route.category === 'public' || route.category === 'webhook',
    )
      .filter((route) => /\bauthorize\(/.test(handlerSource(route.handler)))
      .map((route) => route.handler);
    expect(gated).toStrictEqual([]);
  });

  it('passes the declared cookie requirement into the bearer routes', () => {
    const missing = ROUTE_MANIFEST.filter((route) => route.category === 'bearer')
      .filter(
        (route) =>
          !new RegExp(`cookieRequires:\\s*['"]${literal(route.cookieRequires ?? '')}['"]`).test(
            handlerSource(route.handler),
          ),
      )
      .map((route) => route.handler);
    expect(missing).toStrictEqual([]);
  });
});

/**
 * Enforcement, derived from the manifest rather than described twice: every
 * route declaring a permission owes the same denials, so the suite is generated
 * from the declarations instead of listed. A route added to the manifest is
 * covered the moment it is declared.
 *
 * The chain runs for real. Each case invokes the handler module's exported
 * Middy chain with a caller in a role the capability matrix refuses, and with a
 * caller who has no membership row at all, and reads the status and error code
 * off the response.
 *
 * Nothing billing-related is mocked, and that is the point: `authorize` runs
 * ahead of `subscriptionGuardMiddleware`, so a refused caller never reaches the
 * BillingTable read. A chain that installed the gate too late would answer 500
 * from the unreachable table rather than 403, which is how this suite carries
 * the ordering guarantee as well as the gate.
 *
 * The refused roles come from the registry rather than a list, so a change to
 * the capability matrix shows up here instead of quietly narrowing the test. A
 * permission every role holds (`buckets.read`) has no refused roles and leaves
 * only the absent-row case, which is the honest thing for it to assert.
 */
describe('enforcement derived from the manifest', () => {
  beforeEach(() => {
    // The absent-row branch writes an EMF metric to stdout and logs the denial;
    // neither belongs in the test output.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const { handler, permission } of permissionGated) {
    describe(`${handler} (${permission})`, () => {
      const denial = async (
        membership: OrgMembership | typeof NO_MEMBERSHIP,
      ): Promise<APIGatewayProxyStructuredResultV2> => {
        // `.ts`, against the repo's usual `.js` specifiers: a dynamic import
        // with a variable in it compiles to a glob over the literal part of the
        // pattern, and `./handlers/*.js` matches nothing on disk.
        const module = (await import(`./handlers/${handler}.ts`)) as {
          handler: (event: unknown, context: unknown) => Promise<APIGatewayProxyResultV2>;
        };
        const event = buildEvent({ userInfo: { userId: USER_ID, orgId: ORG_ID, membership } });
        // Every route here answers with a ResponseBuilder, so the union's string
        // arm never occurs; middy's declared return type carries it anyway.
        return (await module.handler(event, buildContext())) as APIGatewayProxyStructuredResultV2;
      };

      const refused = Object.values(OrgRole).filter((role) => !roleHasPermission(role, permission));

      if (refused.length > 0) {
        it.each(refused)('refuses %s', async (role) => {
          const result = await denial(membershipFor(ORG_ID, USER_ID, role));

          expect(result.statusCode).toBe(403);
          expect(JSON.parse(result.body ?? '{}').code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
        });
      }

      it('refuses a caller with no membership row', async () => {
        const result = await denial(NO_MEMBERSHIP);

        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body ?? '{}').code).toBe(ApiErrorCode.NOT_A_MEMBER);
      });
    });
  }
});
