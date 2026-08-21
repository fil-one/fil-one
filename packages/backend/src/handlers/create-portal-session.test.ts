import { vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
  },
}));

vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({ billingPortal: { sessions: { create: vi.fn() } } }),
  getBillingSecrets: () => ({ STRIPE_SECRET_KEY: 'sk_test_fake' }),
}));

// Pass-through auth so the chain under test starts at `authorize`.
vi.mock('../middleware/auth.js', () => ({
  // Every gate downstream of the auth middleware returns its denials through
  // this helper, so the partial mock has to carry it.
  withRefreshedCookies: (_request: unknown, response: unknown) => response,
  authMiddleware: () => ({ before: () => undefined }),
}));

mockClient(DynamoDBClient);

import { handler } from './create-portal-session.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
import { describeRoleEnforcement } from '../test/role-enforcement.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

// The Stripe portal is where a subscription is changed or cancelled, so the
// route is Owner-only. The rest of the handler's behavior is covered by the
// billing suite; what this file owns is that nobody else can open the portal.
describeRoleEnforcement({
  permission: 'billing.manage',
  invoke: (membership) =>
    handler(buildEvent({ userInfo: { ...USER_INFO, membership } }), buildContext()),
});
