/**
 * LOCAL PREVIEW ONLY — NOT FOR COMMIT.
 *
 * Runs the console against a stubbed IAM backend so `/members` renders inside
 * the real app shell without a membership row on the proxied environment.
 *
 *   pnpm --filter @filone/website exec vite --config vite.mock-iam.config.ts
 *
 * Everything else still proxies to `DEV_PROXY_TARGET`; only the handful of
 * endpoints the members console reads are answered from here. Nothing in `src/`
 * is touched, so this file can simply be deleted when it has served its purpose.
 */
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import {
  MAX_PENDING_INVITATIONS_PER_ORG,
  OrgRole,
  permissionsForRole,
} from './../shared/src/index.js';

import baseConfigFactory from './vite.config';

/** How many pending invitations the stub starts with; 25 is the cap. */
const MOCK_INVITE_COUNT = 2;

/** The org the stub answers for, and the caller's seat in it. */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_NAME = 'Acme';

/** The org POST /api/invitations/accept joins the caller into, for previewing that flow. */
const PREVIEW_INVITE_ORG_ID = '33333333-3333-3333-3333-333333333333';
const PREVIEW_INVITE_ORG_NAME = 'Widgets Inc';
const SELF_USER_ID = 'user-1';
const SELF_ROLE = OrgRole.Owner;

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const members = [
  {
    userId: SELF_USER_ID,
    role: SELF_ROLE,
    joinedAt: '2026-01-04T10:00:00.000Z',
    source: 'conversion',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  },
  {
    userId: 'user-2',
    role: OrgRole.Admin,
    joinedAt: '2026-01-31T10:00:00.000Z',
    source: 'invitation',
    email: 'grace@example.com',
  },
  {
    userId: 'user-3',
    role: OrgRole.Member,
    joinedAt: '2026-02-28T10:00:00.000Z',
    source: 'invitation',
  },
  {
    userId: 'user-4',
    role: OrgRole.ReadOnly,
    joinedAt: '2026-03-13T10:00:00.000Z',
    source: 'invitation',
    name: 'Katherine Johnson',
  },
  {
    userId: 'user-5',
    role: OrgRole.Member,
    joinedAt: '2026-04-02T10:00:00.000Z',
    source: 'invitation',
    name: 'Grete Hermann',
    email: 'grete@example.com',
  },
  {
    userId: 'user-6',
    role: OrgRole.Member,
    joinedAt: '2026-04-19T10:00:00.000Z',
    source: 'invitation',
  },
];

const invitations = [
  {
    inviteId: 'inv-1',
    email: 'waiting@example.com',
    role: OrgRole.Member,
    invitedBy: SELF_USER_ID,
    createdAt: '2026-07-31T10:00:00.000Z',
    expiresAt: daysFromNow(14),
    status: 'pending',
    expired: false,
  },
  {
    inviteId: 'inv-2',
    email: 'unsent@example.com',
    role: OrgRole.Admin,
    invitedBy: SELF_USER_ID,
    createdAt: '2026-07-31T10:00:00.000Z',
    expiresAt: daysFromNow(14),
    status: 'pending',
    expired: false,
    lastSendFailed: true,
  },
  // Filler up to the cap, so the at-limit state is reachable in the preview.
  // Set MOCK_INVITE_COUNT to 25 to see it; below that is the ordinary state.
  ...Array.from({ length: Math.max(0, MOCK_INVITE_COUNT - 2) }, (_, i) => ({
    inviteId: `inv-fill-${String(i + 1)}`,
    email: `teammate${String(i + 1)}@example.com`,
    role: OrgRole.Member,
    invitedBy: SELF_USER_ID,
    createdAt: '2026-07-31T10:00:00.000Z',
    expiresAt: daysFromNow(14),
    status: 'pending',
    expired: false,
  })),
];

/**
 * Start unnamed so `/welcome` gates the console, the way a brand-new account
 * does. `PATCH /api/org` below flips it, so the flow runs end to end: land on
 * the naming step, submit, arrive at the dashboard under the new name. Set this
 * to true to preview the console as an established account instead.
 */
const START_NAMED = true;

/** Set to false to preview the whole-console "no active plan" gate instead. */
const MOCK_BILLING_ACTIVE = true;

const me = {
  orgId: ORG_ID,
  orgName: ORG_NAME,
  slug: 'acme',
  nameConfirmed: START_NAMED,
  emailVerified: true,
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  mfaEnrollments: [],
  ragAccess: true,
  // `useMembersSurface` needs one of these two: more than one membership, or
  // the organizations beta. Both are set so the page and its invite form are
  // both reachable in the preview.
  orgsBeta: true,
  billingActive: MOCK_BILLING_ACTIVE,
  userId: SELF_USER_ID,
  role: SELF_ROLE,
  permissions: permissionsForRole(SELF_ROLE),
  activeOrgId: ORG_ID,
  memberships: [
    {
      orgId: ORG_ID,
      orgName: ORG_NAME,
      slug: 'acme',
      role: SELF_ROLE,
      joinedAt: '2026-01-04T10:00:00.000Z',
    },
    {
      orgId: '22222222-2222-2222-2222-222222222222',
      orgName: 'Globex',
      slug: 'globex',
      role: OrgRole.Member,
      joinedAt: '2026-03-13T10:00:00.000Z',
    },
  ],
};

/**
 * `/api/me`, aware of the active-org header (`X-Org-Id`) the real backend
 * reads: once the invite-accept preview has joined PREVIEW_INVITE_ORG_ID, a
 * request naming it back gets that org as the active one instead of the
 * fixed `me` above, so switching into it after "Continue" actually resolves
 * a slug and lands the console there rather than silently staying on Acme.
 */
function meForActiveOrg(activeOrgId: string | undefined) {
  if (!activeOrgId || activeOrgId === me.orgId) return me;
  const active = me.memberships.find((m) => m.orgId === activeOrgId);
  if (!active) return me;
  return {
    ...me,
    orgId: active.orgId,
    orgName: active.orgName,
    slug: active.slug,
    role: active.role,
    permissions: permissionsForRole(active.role),
  };
}

/**
 * Which billing customer to preview.
 *
 * `self-serve` is the org on the public price: `get-billing` reports a per-TB
 * rate, so the tab shows the rate and an estimate. `contracted` is a quote sales
 * put together: a named plan, no single per-TB rate, and no card on file, so the
 * tab names the plan, says custom pricing, and reads as invoiced. Switch this to
 * see the other one.
 */
const MOCK_BILLING_CUSTOMER: 'self-serve' | 'contracted' = 'self-serve';

/** What `GET /api/billing` answers, in the shape the read model returns. */
const billing =
  MOCK_BILLING_CUSTOMER === 'self-serve'
    ? {
        // A real trial has no Stripe subscription behind it yet — no plan
        // chosen, no price, no card on file — so none of those fields are
        // set here, matching what get-billing.ts actually reports for one.
        subscription: {
          planId: 'free_trial',
          status: 'trialing',
          currentPeriodStart: daysFromNow(-11),
          currentPeriodEnd: daysFromNow(19),
          trialEndsAt: daysFromNow(28),
        },
      }
    : {
        subscription: {
          planId: 'pay_as_you_go',
          status: 'active',
          planName: 'Business',
          monthlyMinimumCents: 250_000,
          currentPeriodStart: daysFromNow(-11),
          currentPeriodEnd: daysFromNow(19),
        },
      };

/** Storage well past the monthly minimum, so the estimate is usage-driven. */
/**
 * Start empty so the first-run surfaces render the way a new organization sees
 * them. `MOCK_USAGE_EMPTY = false` fills the counters to preview the populated
 * dashboard instead.
 */
const MOCK_USAGE_EMPTY = true;

const usage = {
  storage: { usedBytes: MOCK_USAGE_EMPTY ? 0 : 4.2e12 },
  egress: { usedBytes: MOCK_USAGE_EMPTY ? 0 : 3.1e11 },
  buckets: { count: MOCK_USAGE_EMPTY ? 0 : 3 },
  objects: { count: MOCK_USAGE_EMPTY ? 0 : 1284 },
  accessKeys: { count: MOCK_USAGE_EMPTY ? 0 : 2 },
  tenantStatus: 'active',
};

/** A ramp from zero to `peak` over `days` points, or a flat zero line under
    `MOCK_USAGE_EMPTY` — what GET /api/usage/trends answers with, since the
    real backend (this middleware only stubs a handful of endpoints, see
    the module doc) has actual history on whatever account this proxies to,
    which would otherwise show a populated chart no matter what `usage`
    above says. */
function usageTrendSeries(days: number, peak: number): { date: string; value: number }[] {
  return Array.from({ length: days }, (_, i) => ({
    date: daysFromNow(-(days - 1 - i)),
    value: MOCK_USAGE_EMPTY ? 0 : Math.round((peak * (i + 1)) / days),
  }));
}

function usageTrends(days: number) {
  return {
    storage: usageTrendSeries(days, 4.2e12),
    objects: usageTrendSeries(days, 1284),
  };
}

/** What GET /api/activity answers when MOCK_USAGE_EMPTY is false. */
const recentActivities = [
  {
    id: 'act-1',
    resourceName: 'new-key',
    resourceType: 'key',
    action: 'key.created',
    timestamp: daysFromNow(-22),
  },
  {
    id: 'act-2',
    resourceName: 'my-bucket',
    resourceType: 'bucket',
    action: 'bucket.created',
    timestamp: daysFromNow(-23),
  },
  {
    id: 'act-3',
    resourceName: 'rag-bucket',
    resourceType: 'bucket',
    action: 'bucket.created',
    timestamp: daysFromNow(-34),
  },
];

const invoices =
  MOCK_BILLING_CUSTOMER === 'self-serve'
    ? [
        {
          id: 'in_2',
          amountDueInCents: 2096,
          status: 'paid',
          createdAt: '2026-08-01T00:00:00.000Z',
          invoicePdfUrl: 'https://example.com/in_2.pdf',
        },
        {
          id: 'in_1',
          amountDueInCents: 1874,
          status: 'paid',
          createdAt: '2026-07-01T00:00:00.000Z',
          invoicePdfUrl: 'https://example.com/in_1.pdf',
        },
      ]
    : [
        {
          id: 'in_b2',
          amountDueInCents: 250_000,
          status: 'open',
          createdAt: '2026-08-01T00:00:00.000Z',
          invoicePdfUrl: 'https://example.com/in_b2.pdf',
        },
        {
          id: 'in_b1',
          amountDueInCents: 250_000,
          status: 'paid',
          createdAt: '2026-07-01T00:00:00.000Z',
          invoicePdfUrl: 'https://example.com/in_b1.pdf',
        },
      ];

/**
 * Answer the members console's reads, and accept its writes against the
 * in-memory lists above so the optimistic paths behave like the real thing.
 */
function mockIam(): Plugin {
  return {
    name: 'mock-iam',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [url, queryString] = (req.url ?? '').split('?');
        const method = req.method ?? 'GET';

        const json = (body: unknown, status = 200): void => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };

        const readBody = async (): Promise<Record<string, string>> => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          if (chunks.length === 0) return {};
          try {
            return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>;
          } catch {
            return {};
          }
        };

        if (url === '/api/me') {
          const activeOrgId = req.headers['x-org-id'];
          return json(meForActiveOrg(Array.isArray(activeOrgId) ? activeOrgId[0] : activeOrgId));
        }

        if (url === '/api/org' && method === 'PATCH') {
          // Same shape as the invitations POST below: the middleware is not
          // async, so the body is read in a then.
          void readBody().then((body) => {
            const name = (body.name ?? '').trim();
            if (name.length < 2) return json({ message: 'Name is too short.' }, 400);
            me.orgName = name;
            me.nameConfirmed = true;
            me.memberships[0].orgName = name;
            return json({ name });
          });
          return;
        }
        if (url === '/api/billing' && method === 'GET') return json(billing);
        if (url === '/api/usage' && method === 'GET') return json(usage);
        if (url === '/api/usage/trends' && method === 'GET') {
          const days = new URLSearchParams(queryString).get('period') === '30d' ? 30 : 7;
          return json(usageTrends(days));
        }
        // Same reasoning as usage/trends above: unstubbed, this proxies to
        // whatever real history the backend account has, no matter what
        // MOCK_USAGE_EMPTY says.
        if (url === '/api/activity' && method === 'GET') {
          return json({ activities: MOCK_USAGE_EMPTY ? [] : recentActivities });
        }
        if (url === '/api/billing/invoices' && method === 'GET') return json({ invoices });
        if (url === '/api/org/members' && method === 'GET') return json({ members });
        if (url === '/api/org/invitations' && method === 'GET') return json({ invitations });

        if (url === '/api/org/invitations' && method === 'POST') {
          void readBody().then((body) => {
            const address = (body.email ?? '').trim().toLowerCase();
            const existingAt = invitations.findIndex((i) => i.email.toLowerCase() === address);
            // Re-inviting an address replaces its row rather than adding a
            // second, so it takes no slot and the cap does not apply — which is
            // what makes Resend work on an undelivered row at the limit.
            if (existingAt >= 0) invitations.splice(existingAt, 1);
            else if (invitations.length >= MAX_PENDING_INVITATIONS_PER_ORG) {
              return json(
                { code: 'INVITE_LIMIT_REACHED', message: 'Too many pending invitations.' },
                409,
              );
            }
            const invitation = {
              inviteId: `inv-${String(invitations.length + 1)}`,
              email: body.email ?? 'someone@example.com',
              role: (body.role as OrgRole) ?? OrgRole.Member,
              invitedBy: SELF_USER_ID,
              createdAt: new Date().toISOString(),
              expiresAt: daysFromNow(14),
              status: 'pending',
              expired: false,
            };
            invitations.unshift(invitation);
            // Addresses containing "unsent" come back undelivered, so the amber
            // alert and its Send again button are reachable from the real UI.
            json({ invitation, emailSent: !invitation.email.includes('unsent') });
          });
          return;
        }

        if (url.startsWith('/api/org/invitations/') && method === 'DELETE') {
          const id = url.split('/').pop();
          const at = invitations.findIndex((i) => i.inviteId === id);
          if (at >= 0) invitations.splice(at, 1);
          return json({});
        }

        // Previews the "already logged in, accepting an invite to a second
        // org" case: any token succeeds, joining PREVIEW_INVITE_ORG_ID once
        // (idempotent on a second hit, like the real endpoint). The active
        // org itself won't actually switch on reload - /api/me above always
        // answers with the same fixed org - so this is for seeing the accept
        // screen and the joined-org entry landing in `me.memberships`, not a
        // full switch-and-reload.
        if (url === '/api/invitations/accept' && method === 'POST') {
          // Drained like every other POST here (readBody), even though the
          // body's content is never used: an unconsumed request stream can
          // leave the connection hanging, which fetch() on the client then
          // sees as a network failure - the accept call's catch-all refusal
          // branch, not this stub's own success response.
          void readBody().then(() => {
            const alreadyMember = me.memberships.some((m) => m.orgId === PREVIEW_INVITE_ORG_ID);
            if (!alreadyMember) {
              me.memberships.push({
                orgId: PREVIEW_INVITE_ORG_ID,
                orgName: PREVIEW_INVITE_ORG_NAME,
                slug: 'widgets-inc',
                role: OrgRole.Member,
                joinedAt: new Date().toISOString(),
              });
            }
            json({
              orgId: PREVIEW_INVITE_ORG_ID,
              orgName: PREVIEW_INVITE_ORG_NAME,
              role: OrgRole.Member,
              alreadyMember,
            });
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig(async (env) => {
  const base = await baseConfigFactory(env);
  // Plain http for the preview. The base config always enables basic-ssl, whose
  // self-signed certificate some browsers refuse outright, and nothing here
  // proxies to an origin that needs TLS locally.
  const plugins = (base.plugins ?? []).filter(
    (plugin) =>
      !(
        plugin &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'vite:basic-ssl'
      ),
  );
  return mergeConfig({ ...base, plugins }, { plugins: [mockIam()], server: { https: undefined } });
});
