import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  ACCESS_KEY_PERMISSION_REQUIREMENT,
  ApiErrorCode,
  CSRF_COOKIE_NAME,
  GRANULAR_PERMISSION_MAP,
  INVITE_TOKEN_MIN_LENGTH,
  GRANULAR_PERMISSION_REQUIREMENT,
  OrgRole,
  PresignOpSchema,
  ROUTE_MANIFEST,
  roleHasPermission,
  SubscriptionStatus,
} from '@filone/shared';
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
/** Not a foundation address, so the RAG gate's answer hinges on the allowlist. */
const OUTSIDER_EMAIL = 'outsider@example.com';
/** The refusal `ragAccessMiddleware` writes, verbatim. */
const RAG_REFUSAL = 'You do not have access to this feature.';
/** The refusal `csrfMiddleware` writes, verbatim. */
const CSRF_REFUSAL = 'CSRF validation failed';
/** Matched between cookie and header on every request that carries one. */
const CSRF_TOKEN = 'csrf-token-value';

/**
 * The `amr` the stubbed auth middleware reports, which is what the step-up gate
 * reads. Empty by default, so the gate fails closed exactly as it does on a
 * session that never satisfied a challenge; the suite that needs to reach past
 * it fills it.
 */
const verifiedAmr: string[] = [];

/**
 * The `auth_time` the stubbed claims report. Null by default, which is a session
 * that never says when it authenticated, so the step-up gate fails closed the
 * same way; the suite that needs to reach past it names a moment ago.
 */
let verifiedAuthTime: number | null = null;
/**
 * A foundation address, which the RAG feature flag admits without a lookup, and
 * the caller every case that is not about that flag arrives as.
 */
const CALLER_EMAIL = 'caller@fil.org';

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
vi.mock('./middleware/auth.js', () => ({
  ...authPartialMock(),
  getVerifiedIdTokenClaims: () => ({
    email: null,
    emailVerified: false,
    name: null,
    picture: null,
    amr: verifiedAmr,
    authTime: verifiedAuthTime,
  }),
}));

type DynamoRead = { TableName?: string; Key?: { pk?: { S: string }; sk?: { S: string } } };

const rowKey = (table: string, pk: string, sk: string) => `${table}/${pk}/${sk}`;

const readKey = (input: DynamoRead | undefined) =>
  rowKey(input?.TableName ?? '', input?.Key?.pk?.S ?? '', input?.Key?.sk?.S ?? '');

/**
 * The rows the mocked table answers with, keyed by {@link rowKey} and filled by
 * the suite that needs them. Empty everywhere else, which is what leaves the
 * BillingTable unreachable below.
 */
const stubbedRows = new Map<string, Record<string, unknown>>();

/**
 * Give the enclosing suite a billing record the subscription guard admits.
 *
 * The in-handler routes need it: their permission check is the handler's own
 * work and runs after the guard, so reaching it means getting past billing
 * first. The RAG gate sits after the guard on every chain carrying it and needs
 * the same.
 */
function withActiveSubscription(): void {
  beforeEach(() => {
    // Both rows the store reads, because it reads them together: the org row is
    // the one it serves, and an unstubbed legacy read would reject alongside it.
    // Spelled out rather than read from the store's key helpers, which reach
    // the sst resources this file mocks and cannot be imported at the top.
    for (const pk of [`ORG#${ORG_ID}`, `CUSTOMER#${USER_ID}`]) {
      stubbedRows.set(
        rowKey('BillingTable', pk, 'SUBSCRIPTION'),
        marshall({ pk, orgId: ORG_ID, subscriptionStatus: SubscriptionStatus.Active }),
      );
    }
  });

  afterEach(() => {
    stubbedRows.clear();
  });
}

// Neither the network nor the BillingTable is available, and that is the point.
// Most gates below refuse their caller before the subscription guard reads
// billing, so the 403s are also the proof of the ordering: a chain that
// installed its gate after the guard would answer 500 from the rejected read
// instead of the 403 each case asserts. The RAG gate is the exception — it sits
// after the guard on every chain carrying it — and its suite stubs the billing
// row so the request reaches the gate it is about.
//
// Every other table answers an empty item, which is what the self-service
// routes need: they are meant to run, and a route that runs has to reach the
// end of its own work to say what it answers a caller with no membership row.
vi.mock('./lib/ddb-client.js', () => ({
  getDynamoClient: () => ({
    send: (command: { input?: DynamoRead }) => {
      const stubbed = stubbedRows.get(readKey(command.input));
      if (stubbed) return Promise.resolve({ Item: stubbed });
      return command.input?.TableName === 'BillingTable'
        ? Promise.reject(new Error('BillingTable is unreachable in this test'))
        : Promise.resolve({});
    },
  }),
}));
vi.stubGlobal('fetch', () => Promise.reject(new Error('the network is unreachable in this test')));

type LambdaModule = {
  handler: (event: unknown, context: unknown) => Promise<APIGatewayProxyResultV2>;
};

/** The parts of a request an in-handler route reads to decide its permission. */
type RouteRequest = {
  body?: string;
  queryStringParameters?: Record<string, string>;
  pathParameters?: Record<string, string>;
};

/**
 * Run one route's real chain, driven with the method the manifest declares so a
 * POST route is exercised as a POST. The request carries a matching CSRF token
 * unless a case is about the request that carries none.
 *
 * `.ts`, against the repo's usual `.js` specifiers: a dynamic import with a
 * variable in it compiles to a glob over the literal part of the pattern, and
 * `./handlers/*.js` matches nothing on disk.
 */
async function invokeRoute(
  route: RouteManifestEntry,
  {
    membership,
    email = CALLER_EMAIL,
    csrf = true,
    request = {},
  }: {
    membership: OrgMembership | typeof NO_MEMBERSHIP;
    email?: string;
    csrf?: boolean;
    request?: RouteRequest;
  },
): Promise<APIGatewayProxyStructuredResultV2> {
  const module = (await import(`./handlers/${route.handler}.ts`)) as LambdaModule;
  const { pathParameters, ...eventProps } = request;
  const event = buildEvent({
    ...eventProps,
    method: route.method,
    userInfo: { userId: USER_ID, orgId: ORG_ID, membership, email },
    ...(csrf ? { cookies: [`${CSRF_COOKIE_NAME}=${CSRF_TOKEN}`] } : {}),
  });
  // Assigned rather than passed: the shared builder takes no path parameters,
  // and the handler tests set them on the built event the same way.
  if (pathParameters) event.pathParameters = pathParameters;
  if (csrf) event.headers['x-csrf-token'] = CSRF_TOKEN;
  // Every route here answers with a ResponseBuilder, so the union's string arm
  // never occurs; middy's declared return type carries it anyway.
  return (await module.handler(event, buildContext())) as APIGatewayProxyStructuredResultV2;
}

/** The caller every case that is not about roles arrives as. */
const owner = () => membershipFor(ORG_ID, USER_ID, OrgRole.Owner);

/** The manifest entry one handler serves, since the probes below name the route. */
function routeFor(handler: string): RouteManifestEntry {
  const route = ROUTE_MANIFEST.find((entry) => entry.handler === handler);
  if (!route) throw new Error(`no manifest entry for handler ${handler}`);
  return route;
}

/** A manifest entry paired with its handler name, for `it.each` titles. */
const named = (routes: readonly RouteManifestEntry[]) =>
  routes.map((route) => [route.handler, route] as const);

/** The error body a response carries, or an empty one when it carries none. */
function errorBody(result: APIGatewayProxyStructuredResultV2): {
  code?: string;
  message?: string;
} {
  try {
    return JSON.parse(result.body ?? '{}') as { code?: string; message?: string };
  } catch {
    return {};
  }
}

/** The `code` an error response carries, or undefined when it carries none. */
const errorCode = (result: APIGatewayProxyStructuredResultV2) => errorBody(result).code;

/** The RAG gate's own refusal, told apart from every other 403 by its message. */
const ragRefused = (result: APIGatewayProxyStructuredResultV2) =>
  result.statusCode === 403 && errorBody(result).message === RAG_REFUSAL;

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
const permissionGated: { route: RouteManifestEntry; permission: Permission }[] =
  ROUTE_MANIFEST.filter((route) => route.category === 'authenticated').flatMap((route) =>
    route.requires === undefined ||
    route.requires === 'self' ||
    route.requires === 'in-handler' ||
    route.requires === 'invite-token'
      ? []
      : [{ route, permission: route.requires }],
  );

/** Every role the capability matrix refuses this permission to. */
const rolesRefused = (permission: Permission) =>
  Object.values(OrgRole).filter((role) => !roleHasPermission(role, permission));

/**
 * Silence the denial log, the EMF metric the absent-row branch writes, and the
 * telemetry a route that runs to completion prints on its way out.
 */
function quietDenialOutput(): void {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
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

  for (const { route, permission } of permissionGated) {
    describe(`${route.handler} (${permission})`, () => {
      const refused = rolesRefused(permission);

      if (refused.length > 0) {
        it.each(refused)('refuses %s', async (role) => {
          const result = await invokeRoute(route, {
            membership: membershipFor(ORG_ID, USER_ID, role),
          });

          expect(result.statusCode).toBe(403);
          expect(errorCode(result)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
        });
      }

      it('refuses a caller with no membership row', async () => {
        const result = await invokeRoute(route, { membership: NO_MEMBERSHIP });

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
/** The routes the manifest marks in-handler, by handler name. */
const inHandler = byRequirement('in-handler').map((route) => route.handler);

describe('routes whose permission depends on the body', () => {
  quietDenialOutput();

  it.each(named(byRequirement('in-handler')))(
    '%s refuses a caller with no membership row',
    async (_handler, route) => {
      const result = await invokeRoute(route, { membership: NO_MEMBERSHIP });

      expect(result.statusCode).toBe(403);
      expect(errorCode(result)).toBe(ApiErrorCode.NOT_A_MEMBER);
    },
  );
});

const BUCKET = 'test-bucket';
const OBJECT_KEY = 'folder/object.txt';

/**
 * The permission each presign operation needs, mirroring the mapping the route
 * manifest documents and the handler applies. One route serves all seven, so
 * the permission is a property of the operation rather than of the route, and
 * the only way to read it off the outside is to ask for each operation in turn.
 *
 * Each entry carries a body its schema accepts, because a request refused at
 * the parse step would answer 400 and prove nothing about the gate.
 */
const PRESIGN_OPERATIONS: { op: Record<string, unknown>; permission: Permission }[] = [
  { op: { op: 'getObject', bucket: BUCKET, key: OBJECT_KEY }, permission: 'objects.read' },
  { op: { op: 'headObject', bucket: BUCKET, key: OBJECT_KEY }, permission: 'objects.read' },
  { op: { op: 'listObjects', bucket: BUCKET }, permission: 'objects.read' },
  { op: { op: 'listObjectVersions', bucket: BUCKET }, permission: 'objects.read' },
  {
    op: { op: 'getObjectRetention', bucket: BUCKET, key: OBJECT_KEY },
    permission: 'objects.read',
  },
  {
    op: {
      op: 'putObject',
      bucket: BUCKET,
      key: OBJECT_KEY,
      contentType: 'text/plain',
      fileName: 'object.txt',
    },
    permission: 'objects.write',
  },
  { op: { op: 'deleteObject', bucket: BUCKET, key: OBJECT_KEY }, permission: 'objects.delete' },
];

/** A presign request asking for one operation, in the region the route requires. */
const presignRequest = (op: Record<string, unknown>): RouteRequest => ({
  body: JSON.stringify([op]),
  queryStringParameters: { region: 'eu-west-1' },
});

/**
 * Every in-handler route, with a request and the permission that request asks
 * for. A route whose requirement depends on the body cannot declare a fixed
 * permission in the manifest, so what it enforces is only visible by sending a
 * body and reading the answer.
 */
const IN_HANDLER_PROBES: {
  handler: string;
  asks: string;
  permission: Permission;
  request: RouteRequest;
}[] = [
  ...PRESIGN_OPERATIONS.map(({ op, permission }) => ({
    handler: 'presign',
    asks: String(op.op),
    permission,
    request: presignRequest(op),
  })),
  {
    handler: 'set-bucket-rag-enablement',
    asks: 'indexing on',
    permission: 'buckets.create',
    request: { body: JSON.stringify({ enabled: true }), pathParameters: { name: BUCKET } },
  },
  {
    handler: 'set-bucket-rag-enablement',
    asks: 'indexing off',
    permission: 'buckets.delete',
    request: { body: JSON.stringify({ enabled: false }), pathParameters: { name: BUCKET } },
  },
  {
    handler: 'create-access-key',
    asks: 'a new key',
    permission: 'keys.create',
    request: {
      body: JSON.stringify({
        keyName: 'a key',
        permissions: ['read'],
        region: 'eu-west-1',
      }),
    },
  },
];

/**
 * What each in-handler route enforces, read off its answers.
 *
 * The manifest marks these routes in-handler and stops there, so the mapping
 * from request to permission lives in the handler and nowhere a test can read
 * it. These cases send the request and check the denial, which is the mapping
 * observed rather than described.
 *
 * A permission every role holds refuses nobody and contributes no cases —
 * true of the five presign read operations. The contrast cases below carry the
 * claim those cannot: the same caller, the same route, a different body, a
 * different answer.
 */
describe('what the in-handler routes enforce', () => {
  quietDenialOutput();
  withActiveSubscription();

  it('probes every route the manifest marks in-handler', () => {
    // A route added to the manifest as in-handler with no probe here would
    // otherwise be checked for membership alone, which is the gap this suite
    // exists to close.
    const probed = new Set(IN_HANDLER_PROBES.map((probe) => probe.handler));
    expect(inHandler.filter((handler) => !probed.has(handler))).toStrictEqual([]);
  });

  it('probes every operation the presign schema accepts', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    const covered = PRESIGN_OPERATIONS.map(({ op }) => String(op.op)).sort(byName);
    const accepted = PresignOpSchema.options.map((option) => option.shape.op.value).sort(byName);
    expect(covered).toStrictEqual(accepted);
  });

  for (const { handler, asks, permission, request } of IN_HANDLER_PROBES) {
    const refused = rolesRefused(permission);
    if (refused.length === 0) continue;

    describe(`${handler} asking for ${asks} (${permission})`, () => {
      it.each(refused)('refuses %s', async (role) => {
        const result = await invokeRoute(routeFor(handler), {
          membership: membershipFor(ORG_ID, USER_ID, role),
          request,
        });

        expect(result.statusCode).toBe(403);
        expect(errorCode(result)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
      });
    });
  }

  /**
   * The two contrasts that prove the branch rather than the gate. A route
   * reading its body and then checking one fixed permission would pass every
   * case above; it fails these.
   */
  it('lets a ReadOnly caller presign a read but not a write', async () => {
    const readOnly = membershipFor(ORG_ID, USER_ID, OrgRole.ReadOnly);
    const read = await invokeRoute(routeFor('presign'), {
      membership: readOnly,
      request: presignRequest({ op: 'getObject', bucket: BUCKET, key: OBJECT_KEY }),
    });
    const write = await invokeRoute(routeFor('presign'), {
      membership: readOnly,
      request: presignRequest({
        op: 'putObject',
        bucket: BUCKET,
        key: OBJECT_KEY,
        contentType: 'text/plain',
        fileName: 'object.txt',
      }),
    });

    // The read is not served here — it runs on past the gate into the billing
    // read this file makes unreachable — but it is not refused on the role.
    expect(errorCode(read)).not.toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(write.statusCode).toBe(403);
    expect(errorCode(write)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
  });

  it('lets a Member turn bucket indexing on but not off', async () => {
    const member = membershipFor(ORG_ID, USER_ID, OrgRole.Member);
    const on = await invokeRoute(routeFor('set-bucket-rag-enablement'), {
      membership: member,
      request: { body: JSON.stringify({ enabled: true }), pathParameters: { name: BUCKET } },
    });
    const off = await invokeRoute(routeFor('set-bucket-rag-enablement'), {
      membership: member,
      request: { body: JSON.stringify({ enabled: false }), pathParameters: { name: BUCKET } },
    });

    expect(errorCode(on)).not.toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(off.statusCode).toBe(403);
    expect(errorCode(off)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
  });
});

/**
 * The RAG query route takes two kinds of caller. The bearer token carries its
 * own authority; a caller arriving with a cookie session instead is an ordinary
 * console user, gated on the manifest's `cookieRequires` for the route. These
 * cases drive the cookie path — no `Authorization` header — so the requirement
 * the manifest declares is the one the response reflects.
 */
/**
 * The cap a route applies on top of its declared permission.
 *
 * `capsInHandler` marks a route that clears its manifest permission in the
 * chain and then narrows what the request may ask for. On create-access-key the
 * narrowing is the one that matters most: a SigV4 key leaves the console and
 * acts over S3, where no role check runs, so a key carrying more than its
 * creator would make the whole matrix cosmetic.
 *
 * The cases are derived from the same requirement tables the handler reads, so
 * a permission added to a table arrives here with its mapping rather than
 * without a case. Each asks for exactly one key permission and expects a
 * refusal precisely when the creator's role does not hold what that permission
 * requires.
 */
describe('the caps routes apply on top of their declared permission', () => {
  quietDenialOutput();
  withActiveSubscription();

  const capped = ROUTE_MANIFEST.filter((route) => route.capsInHandler).map(
    (route) => route.handler,
  );

  it('names every route that declares a cap', () => {
    // A roster rather than a count, so a route that starts declaring a cap
    // arrives here and has to be given cases rather than passing on a number.
    expect(capped).toStrictEqual([
      'create-access-key',
      'update-member-role',
      'remove-member',
      'get-role-change-preview',
      'create-invitation',
      'revoke-invitation',
    ]);
  });

  /**
   * A mint request asking for one permission, built the way the schema insists.
   *
   * A granular only parses alongside the object permission it hangs off, so the
   * parent comes from the same map the schema checks against. The parent is
   * always one the role holds where the granular is not, which keeps each case
   * about the permission it names. `us-east-1` because bucket management does
   * not parse in `eu-west-1` at all, and a body refused at the schema would
   * answer 400 and say nothing about the cap.
   */
  const parentOf = (granular: string) =>
    Object.entries(GRANULAR_PERMISSION_MAP).find(([, granulars]) =>
      (granulars as string[]).includes(granular),
    )?.[0];

  const mintRequest = (keyPermission: string, granular: boolean): RouteRequest => ({
    body: JSON.stringify({
      keyName: 'a key',
      permissions: granular ? [parentOf(keyPermission)] : [keyPermission],
      ...(granular && { granularPermissions: [keyPermission] }),
      region: 'us-east-1',
    }),
  });

  const cases = Object.entries(OrgRole)
    .filter(([, role]) => roleHasPermission(role, 'keys.create'))
    .flatMap(([, role]) => [
      ...Object.entries(ACCESS_KEY_PERMISSION_REQUIREMENT).map(([keyPermission, requires]) => ({
        role,
        keyPermission,
        requires,
        granular: false,
      })),
      ...Object.entries(GRANULAR_PERMISSION_REQUIREMENT).map(([keyPermission, requires]) => ({
        role,
        keyPermission,
        requires,
        granular: true,
      })),
    ]);

  it('has a role that is refused something and a role that is refused nothing', () => {
    // Both halves of the claim have to be exercised, or a handler that refused
    // everything and a handler that refused nothing would both pass below.
    const refused = cases.filter(({ role, requires }) => !roleHasPermission(role, requires));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThan(cases.length);
  });

  it.each(cases)(
    '$role asking for $keyPermission, which needs $requires',
    async ({ role, keyPermission, requires, granular }) => {
      const result = await invokeRoute(routeFor('create-access-key'), {
        membership: membershipFor(ORG_ID, USER_ID, role),
        request: mintRequest(keyPermission, granular),
      });

      if (roleHasPermission(role, requires)) {
        // Past the cap, into work this file's mocks do not stand up. Only that
        // the cap let it through is pinned.
        expect(errorCode(result)).not.toBe(ApiErrorCode.FORBIDDEN_ROLE);
        return;
      }

      expect(result.statusCode).toBe(403);
      expect(errorCode(result)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
      // Named, because "your role does not permit this key" against a form of
      // checkboxes does not say which one to clear.
      expect(result.body).toContain(keyPermission);
    },
  );

  /**
   * The other cap in this stack is a ceiling on who the caller may reach.
   * `members.manage` opens the member and invitation routes; reaching an Owner
   * takes `owners.manage` on top, which an Admin does not hold. Inviting is the
   * one of those routes that names the target's role in the body, so it is the
   * one whose ceiling can be read off a response without a stored target.
   *
   * The member routes read their target's current role from its row, and their
   * ceiling belongs to their own handler tests.
   */
  describe('inviting reaches no further than the caller does', () => {
    const invite = (role: string): RouteRequest => ({
      body: JSON.stringify({ email: 'invitee@example.com', role }),
    });

    it.each(Object.values(OrgRole).filter((role) => roleHasPermission(role, 'members.manage')))(
      '%s may invite an Admin',
      async (role) => {
        const result = await invokeRoute(routeFor('create-invitation'), {
          membership: membershipFor(ORG_ID, USER_ID, role),
          request: invite(OrgRole.Admin),
        });

        expect(errorCode(result)).not.toBe(ApiErrorCode.FORBIDDEN_ROLE);
      },
    );

    it.each(Object.values(OrgRole).filter((role) => roleHasPermission(role, 'members.manage')))(
      '%s invites an Owner only with owners.manage',
      async (role) => {
        const result = await invokeRoute(routeFor('create-invitation'), {
          membership: membershipFor(ORG_ID, USER_ID, role),
          request: invite(OrgRole.Owner),
        });

        if (roleHasPermission(role, 'owners.manage')) {
          expect(errorCode(result)).not.toBe(ApiErrorCode.FORBIDDEN_ROLE);
          return;
        }

        expect(result.statusCode).toBe(403);
        expect(errorCode(result)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
      },
    );
  });
});

/**
 * The invitation route, which asks for a token where the others ask for a role.
 *
 * Accepting an invitation cannot require membership in the org it is about to
 * create one in, so `invite-token` carries no org gate at all. What stands in
 * its place is the token: an unknown one is refused, which is what says the
 * route is not simply open. The rest of the check — that the session's verified
 * address is the one the invitation went to — needs a real invitation row and
 * belongs to accept-invitation's own tests, which cover the mismatch, the
 * casing, and the unverified session.
 */
describe('the invitation route asks for a token instead of a role', () => {
  quietDenialOutput();

  const inviteRoutes = byRequirement('invite-token');
  // A token the schema accepts and no invitation matches.
  const unknownToken = JSON.stringify({ token: 'x'.repeat(INVITE_TOKEN_MIN_LENGTH) });

  it('is declared on at least one route', () => {
    expect(inviteRoutes.length).toBeGreaterThan(0);
  });

  it.each(named(inviteRoutes))(
    '%s refuses no caller for want of a membership row',
    async (_handler, route) => {
      const result = await invokeRoute(route, {
        membership: NO_MEMBERSHIP,
        request: { body: unknownToken },
      });

      expect([ApiErrorCode.FORBIDDEN_ROLE, ApiErrorCode.NOT_A_MEMBER]).not.toContain(
        errorCode(result),
      );
    },
  );

  it.each(named(inviteRoutes))(
    '%s refuses a token no invitation matches',
    async (_handler, route) => {
      const result = await invokeRoute(route, {
        membership: NO_MEMBERSHIP,
        request: { body: unknownToken },
      });

      expect(result.statusCode).toBe(404);
      expect(errorCode(result)).toBe(ApiErrorCode.INVITE_NOT_FOUND);
    },
  );
});

describe('the cookie caller on a bearer route', () => {
  quietDenialOutput();

  for (const route of ROUTE_MANIFEST.filter((entry) => entry.category === 'bearer')) {
    describe(`${route.handler} (${route.cookieRequires})`, () => {
      const refused = route.cookieRequires ? rolesRefused(route.cookieRequires) : [];

      if (refused.length > 0) {
        it.each(refused)('refuses %s', async (role) => {
          const result = await invokeRoute(route, {
            membership: membershipFor(ORG_ID, USER_ID, role),
          });

          expect(result.statusCode).toBe(403);
          expect(errorCode(result)).toBe(ApiErrorCode.FORBIDDEN_ROLE);
        });
      }

      it('refuses a caller with no membership row', async () => {
        const result = await invokeRoute(route, { membership: NO_MEMBERSHIP });

        expect(result.statusCode).toBe(403);
        expect(errorCode(result)).toBe(ApiErrorCode.NOT_A_MEMBER);
      });
    });
  }
});

/**
 * A cookie is sent by the browser whether or not the page asking for it is
 * ours, so every route that changes something behind a cookie session takes a
 * CSRF token as well, and refuses the request that arrives without one. The
 * rest of this file supplies the token; this is the one rule that leaves it
 * out.
 *
 * The scope is the cookie session. The Stripe webhook authenticates by the
 * provider's request signature and the RAG query route by its bearer token;
 * neither is a credential a browser attaches on its own, and neither route
 * carries the middleware.
 */
describe('every mutating session route refuses a request with no CSRF token', () => {
  quietDenialOutput();

  // The step-up gate sits ahead of the CSRF one on the MFA routes, so the
  // caller arrives holding a strong-auth session, authenticated moments ago.
  // What the request is missing is the token and nothing else.
  beforeEach(() => {
    verifiedAmr.push('mfa');
    verifiedAuthTime = Date.now() / 1000;
  });

  afterEach(() => {
    verifiedAmr.length = 0;
    verifiedAuthTime = null;
  });

  const mutating = ROUTE_MANIFEST.filter(
    (route) => route.category === 'authenticated' && route.method !== 'GET',
  );

  it.each(named(mutating))('%s', async (_handler, route) => {
    const result = await invokeRoute(route, { membership: owner(), csrf: false });

    expect(result.statusCode).toBe(403);
    expect(errorBody(result).message).toBe(CSRF_REFUSAL);
  });
});

/**
 * RAG ships behind a per-email allowlist while it is in early access, and the
 * manifest says which routes that gate sits on. It is not the role gate: a
 * caller holding every permission the route asks for is still refused without a
 * row, so these routes owe a denial no permission check produces. The gate is
 * the real `ragAccessMiddleware`, running against a stubbed allowlist read —
 * the one thing about it a test can supply.
 *
 * The unmarked routes are checked too, from the other side: a manifest entry
 * that quietly gained the middleware without gaining the flag would show up as
 * a route refusing a caller the manifest says nothing about.
 */
describe('the RAG allowlist gates the routes the manifest marks', () => {
  quietDenialOutput();

  const gated = ROUTE_MANIFEST.filter((route) => route.ragAllowlisted);
  const ungated = ROUTE_MANIFEST.filter(
    (route) =>
      !route.ragAllowlisted && (route.category === 'authenticated' || route.category === 'bearer'),
  );

  // The gate runs after the subscription guard on every chain that carries it,
  // so the request only reaches it once the guard has a record to pass on.
  withActiveSubscription();

  /** The allowlist row an operator writes to onboard one customer. */
  function allowlist(email: string): void {
    stubbedRows.set(
      rowKey('UserInfoTable', `ALLOWLIST#${email}`, 'RAG'),
      marshall({ pk: `ALLOWLIST#${email}`, sk: 'RAG' }),
    );
  }

  it.each(named(gated))(
    '%s refuses a caller who is neither foundation nor allowlisted',
    async (_handler, route) => {
      const result = await invokeRoute(route, { membership: owner(), email: OUTSIDER_EMAIL });

      expect(result.statusCode).toBe(403);
      expect(errorBody(result).message).toBe(RAG_REFUSAL);
    },
  );

  // What the allowlisted caller then gets is the route's own business, and the
  // route's own tests say what it is. The claim here is only that the gate is
  // no longer what stops them.
  it.each(named(gated))('%s lets an allowlisted caller past the gate', async (_handler, route) => {
    allowlist(OUTSIDER_EMAIL);

    const result = await invokeRoute(route, { membership: owner(), email: OUTSIDER_EMAIL });

    expect(ragRefused(result)).toBe(false);
  });

  it.each(named(ungated))('%s is not behind the gate', async (_handler, route) => {
    const result = await invokeRoute(route, { membership: owner(), email: OUTSIDER_EMAIL });

    expect(ragRefused(result)).toBe(false);
  });
});

/**
 * `self` waives the role gate and the membership gate together. Changing your
 * own password or correcting your own email is not an org action: gating it on
 * a role would lock a ReadOnly member out of their own account, and gating it
 * on membership would lock out the one user whose membership row is the thing
 * that went wrong.
 *
 * Each route answers on its own terms: the reads run all the way through, the
 * MFA routes demand a step-up, and the writes complain about a body these
 * cases do not trouble to fill in. None of that is pinned, and the case does
 * not claim any of it. The single pin is that the answer is not an org denial,
 * which is the one answer a self route must never give.
 */
describe('self-service routes serve a caller with no membership row', () => {
  quietDenialOutput();

  const orgDenials: (string | undefined)[] = [
    ApiErrorCode.FORBIDDEN_ROLE,
    ApiErrorCode.NOT_A_MEMBER,
  ];
  it.each(named(byRequirement('self')))(
    '%s does not refuse them on the org gate',
    async (_handler, route) => {
      const result = await invokeRoute(route, { membership: NO_MEMBERSHIP });

      const answer = result.statusCode === 403 ? errorCode(result) : `HTTP ${result.statusCode}`;
      expect(orgDenials).not.toContain(answer);
    },
  );
});
