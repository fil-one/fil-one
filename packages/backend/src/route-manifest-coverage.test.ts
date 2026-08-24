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
 * What the route manifest declares, proved by running the routes.
 *
 * The manifest says of every route which credential reaches it and what the
 * caller's role must carry. Each claim below is checked by invoking that
 * route's own Middy chain and reading the answer off the response: the
 * permission-gated routes refuse every role the capability matrix refuses, the
 * body-dependent routes refuse a caller with no membership row, the RAG query
 * route gates its cookie caller, and the self-service routes serve a caller
 * whose missing membership row is the very thing they exist to repair.
 *
 * Nothing here reads a handler's source. Matching `authorize(` in a file proves
 * a string is present, not that a request is refused, and it stays green on a
 * chain that installs the gate after the work it was meant to guard. Which
 * routes exist at all is a deployment fact rather than a source fact:
 * sst.config.ts builds the API from this manifest, so a handler module with no
 * entry gets no Lambda and no route.
 *
 * One claim needs the real auth middleware and so cannot share this file's
 * mocks — that every route behind a session refuses a request carrying no
 * credentials. It lives in route-manifest-unauthenticated.test.ts.
 */

// The service-orchestrator registry builds its API clients as it is imported and
// reads their base URLs from the environment, so a handler that reaches storage
// needs these set before the first import.
process.env.FILONE_STAGE ??= 'test';
process.env.FTH_MANAGEMENT_API_URL ??= 'https://fth.test.invalid';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

// The `sst` mock answers the resource reads a handler module makes while it is
// being imported, and the auth one stands in for the middleware that would have
// resolved a cookie session, so the caller arrives on the event instead.
//
// This file imports every gated handler, so it reaches resources no single
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

// Neither the network nor the BillingTable is available, and that is the point.
// Every gate below refuses its caller before the subscription guard reads
// billing, so the 403s are also the proof of the ordering: a chain that
// installed its gate after the guard would answer 500 from the rejected read
// instead of the 403 each case asserts. Nothing about billing is stubbed —
// the table is simply not there.
//
// Every other table answers an empty item, which is what the self-service
// routes need: they are meant to run, and a route that runs has to reach the
// end of its own work to say what it answers a caller with no membership row.
vi.mock('./lib/ddb-client.js', () => ({
  getDynamoClient: () => ({
    send: (command: { input?: { TableName?: string } }) =>
      command.input?.TableName === 'BillingTable'
        ? Promise.reject(new Error('BillingTable is unreachable in this test'))
        : Promise.resolve({}),
  }),
}));
vi.stubGlobal('fetch', () => Promise.reject(new Error('the network is unreachable in this test')));

type LambdaModule = {
  handler: (event: unknown, context: unknown) => Promise<APIGatewayProxyResultV2>;
};

/**
 * Run one route's real chain for a caller with this membership.
 *
 * `.ts`, against the repo's usual `.js` specifiers: a dynamic import with a
 * variable in it compiles to a glob over the literal part of the pattern, and
 * `./handlers/*.js` matches nothing on disk.
 */
async function invokeRoute(
  handler: string,
  membership: OrgMembership | typeof NO_MEMBERSHIP,
): Promise<APIGatewayProxyStructuredResultV2> {
  const module = (await import(`./handlers/${handler}.ts`)) as LambdaModule;
  const event = buildEvent({ userInfo: { userId: USER_ID, orgId: ORG_ID, membership } });
  // Every route here answers with a ResponseBuilder, so the union's string arm
  // never occurs; middy's declared return type carries it anyway.
  return (await module.handler(event, buildContext())) as APIGatewayProxyStructuredResultV2;
}

/** The `code` an error response carries, or undefined when it carries none. */
function errorCode(result: APIGatewayProxyStructuredResultV2): string | undefined {
  try {
    return (JSON.parse(result.body ?? '{}') as { code?: string }).code;
  } catch {
    return undefined;
  }
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

/** Every role the capability matrix refuses this permission to. */
const rolesRefused = (permission: Permission) =>
  Object.values(OrgRole).filter((role) => !roleHasPermission(role, permission));

/** Silence the denial log and the EMF metric the absent-row branch writes. */
function quietDenialOutput(): void {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}

/**
 * Enforcement, derived from the manifest rather than described twice: every
 * route declaring a permission owes the same denials, so the suite is generated
 * from the declarations instead of listed. A route added to the manifest is
 * covered the moment it is declared.
 *
 * The refused roles come from the registry rather than a list, so a change to
 * the capability matrix shows up here instead of quietly narrowing the test. A
 * permission every role holds (`buckets.read`) has no refused roles and leaves
 * only the absent-row case, which is the honest thing for it to assert.
 */
describe('enforcement derived from the manifest', () => {
  quietDenialOutput();

  for (const { handler, permission } of permissionGated) {
    describe(`${handler} (${permission})`, () => {
      const refused = rolesRefused(permission);

      if (refused.length > 0) {
        it.each(refused)('refuses %s', async (role) => {
          const result = await invokeRoute(handler, membershipFor(ORG_ID, USER_ID, role));

          expect(result.statusCode).toBe(403);
          expect(errorCode(result)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
        });
      }

      it('refuses a caller with no membership row', async () => {
        const result = await invokeRoute(handler, NO_MEMBERSHIP);

        expect(result.statusCode).toBe(403);
        expect(errorCode(result)).toBe(ApiErrorCode.NOT_A_MEMBER);
      });
    });
  }
});

/**
 * The routes whose permission depends on the request body still have one
 * requirement that does not: being in the org. The handler decides which
 * permission the body needs, but nothing about a body makes a non-member a
 * member, so the chain settles membership before the handler is reached.
 *
 * Left to the handler alone these routes would serve a non-member, and the
 * denial would be invisible to NotAMemberDenialCount — the metric whose whole
 * job is to say whether the conversion missed a cohort.
 */
describe('routes whose permission depends on the body', () => {
  quietDenialOutput();

  const inHandler = byRequirement('in-handler').map((route) => route.handler);

  it.each(inHandler)('%s refuses a caller with no membership row', async (handler) => {
    const result = await invokeRoute(handler, NO_MEMBERSHIP);

    expect(result.statusCode).toBe(403);
    expect(errorCode(result)).toBe(ApiErrorCode.NOT_A_MEMBER);
  });
});

/**
 * The RAG query route takes two kinds of caller. The bearer token carries its
 * own authority; a caller arriving with a cookie session instead is an ordinary
 * console user, gated on the manifest's `cookieRequires` for the route. These
 * cases drive the cookie path — no `Authorization` header — so the requirement
 * the manifest declares is the one the response reflects.
 */
describe('the cookie caller on a bearer route', () => {
  quietDenialOutput();

  for (const route of ROUTE_MANIFEST.filter((entry) => entry.category === 'bearer')) {
    describe(`${route.handler} (${route.cookieRequires})`, () => {
      const refused = route.cookieRequires ? rolesRefused(route.cookieRequires) : [];

      if (refused.length > 0) {
        it.each(refused)('refuses %s', async (role) => {
          const result = await invokeRoute(route.handler, membershipFor(ORG_ID, USER_ID, role));

          expect(result.statusCode).toBe(403);
          expect(errorCode(result)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
        });
      }

      it('refuses a caller with no membership row', async () => {
        const result = await invokeRoute(route.handler, NO_MEMBERSHIP);

        expect(result.statusCode).toBe(403);
        expect(errorCode(result)).toBe(ApiErrorCode.NOT_A_MEMBER);
      });
    });
  }
});

/**
 * `self` waives the role gate and the membership gate together. Changing your
 * own password or correcting your own email is not an org action: gating it on
 * a role would lock a ReadOnly member out of their own account, and gating it
 * on membership would lock out the one user whose membership row is the thing
 * that went wrong.
 *
 * The two reads run all the way through and answer 200: a caller with no
 * membership row still gets their own profile and their own preferences. The
 * rest answer on their own terms — a step-up demand on the MFA routes, a
 * complaint about the body these cases do not trouble to fill in on the
 * writes — and none of that is pinned. The single pin is that the answer is
 * not an org denial, which is the one answer a self route must never give.
 */
describe('self-service routes serve a caller with no membership row', () => {
  quietDenialOutput();

  const orgDenials: (string | undefined)[] = [
    ApiErrorCode.FORBIDDEN_ROLE,
    ApiErrorCode.NOT_A_MEMBER,
  ];
  const selfRoutes = byRequirement('self').map((route) => route.handler);

  it.each(selfRoutes)('%s does not refuse them on the org gate', async (handler) => {
    const result = await invokeRoute(handler, NO_MEMBERSHIP);

    const answer = result.statusCode === 403 ? errorCode(result) : `HTTP ${result.statusCode}`;
    expect(orgDenials).not.toContain(answer);
  });
});
