import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

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

vi.mock('sst', () => ({
  Resource: {
    StripeSecretKey: { value: 'sk_test_fake' },
    Auth0MgmtClientId: { value: 'mgmt-client-id' },
    Auth0MgmtClientSecret: { value: 'mgmt-client-secret' },
    Auth0ClientId: { value: 'auth0-client-id' },
  },
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

function stubAuth0Fetch(
  clientState = {
    callbacks: ['https://old.example.com/callback'],
    allowed_logout_urls: [] as string[],
    web_origins: [] as string[],
    initiate_login_uri: '',
  },
) {
  capturedCfnBody = undefined;
  capturedAuth0PatchBody = undefined;

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
          'customer.subscription.created',
          'customer.subscription.updated',
          'customer.subscription.deleted',
          'customer.subscription.trial_will_end',
          'invoice.payment_succeeded',
          'invoice.payment_failed',
        ],
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
        allowed_logout_urls: ['https://app.example.com/sign-in'],
        web_origins: ['https://app.example.com'],
        initiate_login_uri: 'https://app.example.com/sign-in',
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
        allowed_logout_urls: ['https://app.example.com/sign-in'],
        web_origins: ['https://app.example.com'],
        initiate_login_uri: 'https://app.example.com/sign-in',
      });

      await handler(
        buildCfnEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'filone-setup-dev',
        }),
      );

      expect(capturedAuth0PatchBody).toEqual({
        callbacks: ['https://other.example.com/callback'],
        allowed_logout_urls: [],
        web_origins: [],
        initiate_login_uri: '',
      });
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
