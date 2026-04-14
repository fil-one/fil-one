import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import type Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStripeWebhookEndpoints = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
};

vi.mock('stripe', () => ({
  default: class MockStripe {
    webhookEndpoints = mockStripeWebhookEndpoints;
  },
}));

const mockResource = vi.hoisted(() => ({
  StripeSecretKey: { value: 'sk_test_fake' },
  Auth0MgmtClientId: { value: 'mgmt-client-id' },
  Auth0MgmtClientSecret: { value: 'mgmt-client-secret' },
  Auth0ClientId: { value: 'auth0-client-id' },
  SendGridApiKey: { value: 'SG.test-api-key' },
}));

vi.mock('sst', () => ({
  Resource: mockResource,
}));

const ssmMock = mockClient(SSMClient);

const mockFetch =
  vi.fn<(url: string, init?: Omit<RequestInit, 'body'> & { body?: string }) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import { handler } from './setup-integrations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SetupProperties {
  SiteUrl: string;
  Stage: string;
}

const BASE_CFN_FIELDS = {
  StackId: 'arn:aws:cloudformation:us-east-1:123:stack/test/guid',
  RequestId: 'req-123',
  LogicalResourceId: 'SetupIntegrations',
};

function buildCfnEvent(
  overrides: Partial<CloudFormationCustomResourceEvent> & {
    RequestType: string;
    ResourceProperties?: Partial<SetupProperties> & { ServiceToken?: string };
    OldResourceProperties?: Partial<SetupProperties>;
  },
): CloudFormationCustomResourceEvent<SetupProperties> {
  return {
    ...BASE_CFN_FIELDS,
    ResponseURL: 'https://cfn-response.example.com',
    ResourceType: 'Custom::SetupIntegrations',
    ResourceProperties: {
      ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
      SiteUrl: 'https://app.example.com',
      Stage: 'dev',
      ...overrides.ResourceProperties,
    },
    ...overrides,
  } as unknown as CloudFormationCustomResourceEvent<SetupProperties>;
}

let capturedCfnBody: Record<string, unknown> | undefined;
let capturedAuth0PatchBody: Record<string, unknown> | undefined;
let capturedEmailProviderBody: Record<string, unknown> | undefined;

function stubAuth0Fetch(
  clientState = {
    callbacks: ['https://old.example.com/callback'],
    allowed_logout_urls: [] as string[],
    web_origins: [] as string[],
    initiate_login_uri: '',
  },
  emailProvider: { patchStatus?: number; postStatus?: number } = {},
) {
  const { patchStatus = 200, postStatus = 200 } = emailProvider;
  capturedCfnBody = undefined;
  capturedAuth0PatchBody = undefined;
  capturedEmailProviderBody = undefined;

  mockFetch.mockImplementation(async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'mgmt-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (urlStr.includes('/api/v2/clients/') && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify(clientState), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (urlStr.includes('/api/v2/clients/') && init?.method === 'PATCH') {
      capturedAuth0PatchBody = JSON.parse(init.body!);
      return new Response('{}', { status: 200 });
    }
    if (urlStr.includes('/api/v2/emails/provider') && init?.method === 'PATCH') {
      capturedEmailProviderBody = JSON.parse(init.body!);
      if (patchStatus !== 200) {
        return new Response('Provider config error', { status: patchStatus });
      }
      return new Response('{}', { status: 200 });
    }
    if (urlStr.includes('/api/v2/emails/provider') && init?.method === 'POST') {
      capturedEmailProviderBody = JSON.parse(init.body!);
      if (postStatus !== 200) {
        return new Response('Provider create error', { status: postStatus });
      }
      return new Response('{}', { status: 200 });
    }
    if (init?.method === 'PUT') {
      capturedCfnBody = JSON.parse(init.body!);
      return new Response('', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setup-integrations', () => {
  beforeEach(() => {
    ssmMock.reset();
    vi.clearAllMocks();
    stubAuth0Fetch();
    mockResource.StripeSecretKey.value = 'sk_test_fake';
    process.env.AUTH0_DOMAIN = 'test.us.auth0.com';
  });

  // ── Create ──────────────────────────────────────────────────────────

  describe('Create', () => {
    it('creates a new Stripe webhook and stores the secret in SSM', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_new',
        secret: 'whsec_new',
      });

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      expect(mockStripeWebhookEndpoints.create).toHaveBeenCalledWith({
        url: 'https://app.example.com/api/stripe/webhook',
        enabled_events: [
          'customer.updated',
          'customer.subscription.created',
          'customer.subscription.updated',
          'customer.subscription.deleted',
          'customer.subscription.trial_will_end',
          'invoice.payment_succeeded',
          'invoice.payment_failed',
        ],
        metadata: { app: 'filone', stage: 'dev' },
      });

      expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toEqual({
        Name: '/filone/dev/stripe-webhook-secret',
        Value: 'whsec_new',
        Type: 'SecureString',
        Overwrite: true,
      });

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
        Data: { webhookSecret: 'whsec_new', webhookEndpointId: 'we_new' },
      });
    });

    it('reuses existing webhook if endpoint and SSM secret both exist', async () => {
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: 'whsec_existing' },
      });
      mockStripeWebhookEndpoints.list.mockResolvedValue({
        data: [{ id: 'we_existing', url: 'https://app.example.com/api/stripe/webhook' }],
      });
      mockStripeWebhookEndpoints.update.mockResolvedValue({});

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      expect(mockStripeWebhookEndpoints.update).toHaveBeenCalledWith('we_existing', {
        enabled_events: expect.any(Array),
        metadata: { app: 'filone', stage: 'dev' },
      });
      expect(mockStripeWebhookEndpoints.create).not.toHaveBeenCalled();

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
        Data: { webhookSecret: 'whsec_existing', webhookEndpointId: 'we_existing' },
      });
    });

    it('deletes stale endpoint and recreates when SSM secret is missing', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({
        data: [{ id: 'we_stale', url: 'https://app.example.com/api/stripe/webhook' }],
      });
      mockStripeWebhookEndpoints.del.mockResolvedValue({});
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_fresh',
        secret: 'whsec_fresh',
      });

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      expect(mockStripeWebhookEndpoints.del).toHaveBeenCalledWith('we_stale');
      expect(mockStripeWebhookEndpoints.create).toHaveBeenCalled();

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
        Data: { webhookSecret: 'whsec_fresh', webhookEndpointId: 'we_fresh' },
      });
    });
  });

  // ── Disabled endpoint cleanup ───────────────────────────────────────

  describe('disabled endpoint cleanup', () => {
    const deletedCases: Record<string, Stripe.WebhookEndpoint> = {
      'disabled ephemeral endpoint with our metadata': {
        id: 'we_orphan',
        url: 'https://old-preview.example.com/api/stripe/webhook',
        status: 'disabled',
        metadata: { app: 'filone', stage: 'pr-42' },
      } as unknown as Stripe.WebhookEndpoint,
    };

    for (const [desc, endpoint] of Object.entries(deletedCases)) {
      it(`deletes ${desc}`, async () => {
        ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
        ssmMock.on(PutParameterCommand).resolves({});
        mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [endpoint] });
        mockStripeWebhookEndpoints.del.mockResolvedValue({});
        mockStripeWebhookEndpoints.create.mockResolvedValue({
          id: 'we_new',
          secret: 'whsec_new',
        });

        await handler(buildCfnEvent({ RequestType: 'Create' }));

        expect(mockStripeWebhookEndpoints.del).toHaveBeenCalledWith(endpoint.id);
      });
    }

    it('skips orphaned endpoint cleanup when running in production', async () => {
      const orphan = {
        id: 'we_orphan',
        url: 'https://old-preview.example.com/api/stripe/webhook',
        status: 'disabled',
        metadata: { app: 'filone', stage: 'pr-42' },
      } as unknown as Stripe.WebhookEndpoint;

      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [orphan] });
      mockStripeWebhookEndpoints.del.mockResolvedValue({});
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_new',
        secret: 'whsec_new',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            Stage: 'production',
            SiteUrl: 'https://prod.example.com',
          },
        }),
      );

      expect(mockStripeWebhookEndpoints.del).not.toHaveBeenCalledWith(orphan.id);
    });

    const keptCases: Record<string, Stripe.WebhookEndpoint> = {
      'disabled production endpoint': {
        id: 'we_prod',
        url: 'https://prod.example.com/api/stripe/webhook',
        status: 'disabled',
        metadata: { app: 'filone', stage: 'production' },
      } as unknown as Stripe.WebhookEndpoint,
      'disabled staging endpoint': {
        id: 'we_staging',
        url: 'https://staging.example.com/api/stripe/webhook',
        status: 'disabled',
        metadata: { app: 'filone', stage: 'staging' },
      } as unknown as Stripe.WebhookEndpoint,
      'enabled ephemeral endpoint': {
        id: 'we_enabled',
        url: 'https://preview.example.com/api/stripe/webhook',
        status: 'enabled',
        metadata: { app: 'filone', stage: 'pr-99' },
      } as unknown as Stripe.WebhookEndpoint,
      'disabled endpoint without our metadata': {
        id: 'we_unknown',
        url: 'https://other.example.com/api/stripe/webhook',
        status: 'disabled',
        metadata: {},
      } as unknown as Stripe.WebhookEndpoint,
      'disabled filone endpoint with missing stage': {
        id: 'we_no_stage',
        url: 'https://mystery.example.com/api/stripe/webhook',
        status: 'disabled',
        metadata: { app: 'filone' },
      } as unknown as Stripe.WebhookEndpoint,
      'disabled endpoint from another app': {
        id: 'we_other_app',
        url: 'https://otherapp.example.com/api/stripe/webhook',
        status: 'disabled',
        metadata: { app: 'other-app', stage: 'dev' },
      } as unknown as Stripe.WebhookEndpoint,
    };

    for (const [desc, endpoint] of Object.entries(keptCases)) {
      it(`does NOT delete ${desc}`, async () => {
        ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
        ssmMock.on(PutParameterCommand).resolves({});
        mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [endpoint] });
        mockStripeWebhookEndpoints.del.mockResolvedValue({});
        mockStripeWebhookEndpoints.create.mockResolvedValue({
          id: 'we_new',
          secret: 'whsec_new',
        });

        await handler(buildCfnEvent({ RequestType: 'Create' }));

        expect(mockStripeWebhookEndpoints.del).not.toHaveBeenCalledWith(endpoint.id);
      });
    }
  });

  // ── Update ──────────────────────────────────────────────────────────

  describe('Update', () => {
    it('tears down old URL resources when SiteUrl changes', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      ssmMock.on(DeleteParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_new',
        secret: 'whsec_new',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Update',
          PhysicalResourceId: 'filone-setup-dev',
          OldResourceProperties: {
            SiteUrl: 'https://old.example.com',
            Stage: 'dev',
          },
        } as never),
      );

      // teardown list + setup list
      expect(mockStripeWebhookEndpoints.list).toHaveBeenCalledTimes(2);

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
        Data: { webhookSecret: 'whsec_new', webhookEndpointId: 'we_new' },
      });
    });

    it('skips old-URL teardown when URL has not changed', async () => {
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: 'whsec_existing' },
      });
      mockStripeWebhookEndpoints.list.mockResolvedValue({
        data: [{ id: 'we_1', url: 'https://app.example.com/api/stripe/webhook' }],
      });
      mockStripeWebhookEndpoints.update.mockResolvedValue({});

      await handler(
        buildCfnEvent({
          RequestType: 'Update',
          PhysicalResourceId: 'filone-setup-dev',
          OldResourceProperties: {
            SiteUrl: 'https://app.example.com',
            Stage: 'dev',
          },
        } as never),
      );

      // list called only once (setup, no teardown)
      expect(mockStripeWebhookEndpoints.list).toHaveBeenCalledTimes(1);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────

  describe('Delete', () => {
    it('deletes the webhook endpoint and SSM secret', async () => {
      ssmMock.on(DeleteParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({
        data: [{ id: 'we_del', url: 'https://app.example.com/api/stripe/webhook' }],
      });
      mockStripeWebhookEndpoints.del.mockResolvedValue({});

      await handler(
        buildCfnEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'filone-setup-dev',
        }),
      );

      expect(mockStripeWebhookEndpoints.del).toHaveBeenCalledWith('we_del');
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(1);

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
      });
    });

    it('succeeds even when no webhook endpoint exists', async () => {
      ssmMock.on(DeleteParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });

      await handler(
        buildCfnEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'filone-setup-dev',
        }),
      );

      expect(mockStripeWebhookEndpoints.del).not.toHaveBeenCalled();

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
      });
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('sends FAILED CFN response when Stripe throws', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      mockStripeWebhookEndpoints.list.mockRejectedValue(new Error('Stripe is down'));

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      expect(capturedCfnBody).toEqual({
        Status: 'FAILED',
        Reason: 'Stripe is down',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
      });
    });

    it('sends FAILED CFN response when Auth0 token request fails', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_new',
        secret: 'whsec_new',
      });

      mockFetch.mockImplementation(async (url, init) => {
        if (String(url).includes('/oauth/token')) {
          return new Response('Unauthorized', { status: 401 });
        }
        if (init?.method === 'PUT') {
          capturedCfnBody = JSON.parse(init.body!);
          return new Response('', { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      expect(capturedCfnBody).toEqual({
        Status: 'FAILED',
        Reason: 'Auth0 token request failed (401): Unauthorized',
        PhysicalResourceId: 'filone-setup-dev',
        ...BASE_CFN_FIELDS,
      });
    });
  });

  // ── Auth0 callbacks ─────────────────────────────────────────────────

  describe('Auth0 callback management', () => {
    it('adds site URLs to Auth0 client on Create', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      expect(capturedAuth0PatchBody).toEqual({
        callbacks: [
          'https://old.example.com/callback',
          'https://app.example.com/api/auth/callback',
        ],
        allowed_logout_urls: ['https://fil.one'],
        web_origins: ['https://app.example.com'],
      });
    });

    it('sets initiate_login_uri for staging stage', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://staging.fil.one',
            Stage: 'staging',
          },
        }),
      );

      expect(capturedAuth0PatchBody).toMatchObject({
        initiate_login_uri: 'https://staging.fil.one/login',
      });
    });

    it('removes site URLs from Auth0 client on Delete', async () => {
      ssmMock.on(DeleteParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });

      stubAuth0Fetch({
        callbacks: [
          'https://other.example.com/callback',
          'https://app.example.com/api/auth/callback',
        ],
        allowed_logout_urls: ['https://fil.one'],
        web_origins: ['https://app.example.com'],
        initiate_login_uri: 'https://app.example.com/login',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'filone-setup-dev',
        }),
      );

      expect(capturedAuth0PatchBody).toEqual({
        callbacks: ['https://other.example.com/callback'],
        web_origins: [],
      });
    });
  });

  // ── Auth0 email provider ────────────────────────────────────────────

  describe('Auth0 email provider', () => {
    it('configures SendGrid email provider on Create for staging', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://staging.filone.ai',
            Stage: 'staging',
          },
        }),
      );

      expect(capturedEmailProviderBody).toEqual({
        name: 'sendgrid',
        enabled: true,
        credentials: { api_key: 'SG.test-api-key' },
        default_from_address: 'no-reply+staging@filone.ai',
      });
    });

    it('uses production from-address when stage is production', async () => {
      mockResource.StripeSecretKey.value = 'sk_live_real';
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://app.filone.ai',
            Stage: 'production',
          },
        }),
      );

      expect(capturedEmailProviderBody).toEqual({
        name: 'sendgrid',
        enabled: true,
        credentials: { api_key: 'SG.test-api-key' },
        default_from_address: 'no-reply@filone.ai',
      });
    });

    it('skips email provider for non-staging/production stages', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://alice.filone.dev',
            Stage: 'alice',
          },
        }),
      );

      expect(capturedEmailProviderBody).toBeUndefined();
    });

    it('does not configure email provider on Delete', async () => {
      ssmMock.on(DeleteParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });

      await handler(
        buildCfnEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'filone-setup-dev',
        }),
      );

      expect(capturedEmailProviderBody).toBeUndefined();
    });

    it('sends FAILED CFN response when email provider PATCH fails with non-404 error', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      stubAuth0Fetch(undefined, { patchStatus: 422 });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://staging.filone.ai',
            Stage: 'staging',
          },
        }),
      );

      expect(capturedCfnBody).toEqual({
        Status: 'FAILED',
        Reason: 'Auth0 email provider update failed (422): Provider config error',
        PhysicalResourceId: 'filone-setup-staging',
        ...BASE_CFN_FIELDS,
      });
    });

    it('falls back to POST when PATCH returns 404 (provider not yet configured)', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      stubAuth0Fetch(undefined, { patchStatus: 404 });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://staging.filone.ai',
            Stage: 'staging',
          },
        }),
      );

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-staging',
        ...BASE_CFN_FIELDS,
        Data: { webhookSecret: 'whsec_1', webhookEndpointId: 'we_1' },
      });

      expect(capturedEmailProviderBody).toEqual({
        name: 'sendgrid',
        enabled: true,
        credentials: { api_key: 'SG.test-api-key' },
        default_from_address: 'no-reply+staging@filone.ai',
      });

      // Verify both PATCH and POST were called on the email provider endpoint
      const emailProviderCalls = mockFetch.mock.calls.filter(([url]) =>
        String(url).includes('/api/v2/emails/provider'),
      );
      expect(emailProviderCalls).toHaveLength(2);
      expect(emailProviderCalls[0][1]?.method).toBe('PATCH');
      expect(emailProviderCalls[1][1]?.method).toBe('POST');
    });

    it('sends FAILED CFN response when POST fallback also fails', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      stubAuth0Fetch(undefined, { patchStatus: 404, postStatus: 500 });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://staging.filone.ai',
            Stage: 'staging',
          },
        }),
      );

      expect(capturedCfnBody).toEqual({
        Status: 'FAILED',
        Reason: 'Auth0 email provider create failed (500): Provider create error',
        PhysicalResourceId: 'filone-setup-staging',
        ...BASE_CFN_FIELDS,
      });
    });

    it('configures email provider on Update for staging', async () => {
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: 'whsec_existing' },
      });
      mockStripeWebhookEndpoints.list.mockResolvedValue({
        data: [{ id: 'we_1', url: 'https://staging.filone.ai/api/stripe/webhook' }],
      });
      mockStripeWebhookEndpoints.update.mockResolvedValue({});

      await handler(
        buildCfnEvent({
          RequestType: 'Update',
          PhysicalResourceId: 'filone-setup-staging',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://staging.filone.ai',
            Stage: 'staging',
          },
          OldResourceProperties: {
            SiteUrl: 'https://staging.filone.ai',
            Stage: 'staging',
          },
        } as never),
      );

      expect(capturedEmailProviderBody).toEqual({
        name: 'sendgrid',
        enabled: true,
        credentials: { api_key: 'SG.test-api-key' },
        default_from_address: 'no-reply+staging@filone.ai',
      });
    });
  });

  // ── Production Stripe key guard ─────────────────────────────────────

  describe('production Stripe key guard', () => {
    it('rejects test Stripe key in production', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://app.filone.ai',
            Stage: 'production',
          },
        }),
      );

      expect(capturedCfnBody).toEqual({
        Status: 'FAILED',
        Reason: 'Using test Stripe key in production is not allowed',
        PhysicalResourceId: 'filone-setup-production',
        ...BASE_CFN_FIELDS,
      });
    });

    it('allows live Stripe key in production', async () => {
      mockResource.StripeSecretKey.value = 'sk_live_real';
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://app.filone.ai',
            Stage: 'production',
          },
        }),
      );

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'filone-setup-production',
        ...BASE_CFN_FIELDS,
        Data: { webhookSecret: 'whsec_1', webhookEndpointId: 'we_1' },
      });
    });

    it('allows test Stripe key in non-production stages', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://staging.filone.ai',
            Stage: 'staging',
          },
        }),
      );

      expect(capturedCfnBody).toMatchObject({ Status: 'SUCCESS' });
    });
  });

  // ── AUTH0_MGMT_DOMAIN ───────────────────────────────────────────────

  describe('AUTH0_MGMT_DOMAIN resolution', () => {
    afterEach(() => {
      delete process.env.AUTH0_MGMT_DOMAIN;
    });

    it('sends Auth0 management API calls to AUTH0_MGMT_DOMAIN instead of AUTH0_DOMAIN', async () => {
      process.env.AUTH0_MGMT_DOMAIN = 'canonical.us.auth0.com';

      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      const auth0Calls = mockFetch.mock.calls.filter(
        ([url]) => String(url).includes('/oauth/token') || String(url).includes('/api/v2/'),
      );
      for (const [url] of auth0Calls) {
        expect(String(url)).toContain('canonical.us.auth0.com');
        expect(String(url)).not.toContain('test.us.auth0.com');
      }
    });

    it('falls back to AUTH0_DOMAIN when AUTH0_MGMT_DOMAIN is not set', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(buildCfnEvent({ RequestType: 'Create' }));

      const tokenCall = mockFetch.mock.calls.find(([url]) => String(url).includes('/oauth/token'));
      expect(String(tokenCall![0])).toContain('test.us.auth0.com');
    });
  });

  // ── PhysicalResourceId ─────────────────────────────────────────────

  describe('PhysicalResourceId', () => {
    it('preserves existing PhysicalResourceId', async () => {
      ssmMock.on(DeleteParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });

      await handler(
        buildCfnEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'custom-physical-id',
        }),
      );

      expect(capturedCfnBody).toEqual({
        Status: 'SUCCESS',
        PhysicalResourceId: 'custom-physical-id',
        ...BASE_CFN_FIELDS,
      });
    });

    it('generates PhysicalResourceId from stage when not present', async () => {
      ssmMock.on(GetParameterCommand).rejects({ name: 'ParameterNotFound' });
      ssmMock.on(PutParameterCommand).resolves({});
      mockStripeWebhookEndpoints.list.mockResolvedValue({ data: [] });
      mockStripeWebhookEndpoints.create.mockResolvedValue({
        id: 'we_1',
        secret: 'whsec_1',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Create',
          ResourceProperties: {
            ServiceToken: 'arn:aws:lambda:us-east-1:123:function:setup',
            SiteUrl: 'https://app.example.com',
            Stage: 'staging',
          },
        }),
      );

      expect(capturedCfnBody).toMatchObject({
        PhysicalResourceId: 'filone-setup-staging',
      });
    });
  });
});
