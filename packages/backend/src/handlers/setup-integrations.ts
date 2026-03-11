import { Resource } from 'sst';
import Stripe from 'stripe';
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';

// ── Custom resource property types ────────────────────────────────────

interface SetupProperties {
  SiteUrl: string;
  Stage: string;
}

type SetupEvent = CloudFormationCustomResourceEvent<SetupProperties>;
type SetupResponse = CloudFormationCustomResourceResponse<{
  webhookSecret: string;
  webhookEndpointId: string;
}>;

interface Auth0Client {
  callbacks?: string[];
  allowed_logout_urls?: string[];
  web_origins?: string[];
  initiate_login_uri?: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
];

const ssm = new SSMClient({});

function ssmParamName(stage: string): string {
  return `/hyperspace/${stage}/stripe-webhook-secret`;
}

// ── SSM helpers ───────────────────────────────────────────────────────

async function getStoredWebhookSecret(stage: string): Promise<string | undefined> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: ssmParamName(stage),
        WithDecryption: true,
      }),
    );
    return result.Parameter?.Value;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

async function storeWebhookSecret(stage: string, secret: string): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: ssmParamName(stage),
      Value: secret,
      Type: 'SecureString',
      Overwrite: true,
    }),
  );
}

async function deleteWebhookSecret(stage: string): Promise<void> {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: ssmParamName(stage) }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ParameterNotFound') return;
    throw err;
  }
}

// ── Stripe helpers ────────────────────────────────────────────────────

async function setupStripeWebhook(
  stripe: Stripe,
  siteUrl: string,
  stage: string,
): Promise<{ webhookSecret: string; webhookEndpointId: string }> {
  const webhookUrl = `${siteUrl}/api/stripe/webhook`;
  const storedSecret = await getStoredWebhookSecret(stage);

  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = endpoints.data.find((ep) => ep.url === webhookUrl);

  if (existing && storedSecret) {
    await stripe.webhookEndpoints.update(existing.id, {
      enabled_events: WEBHOOK_EVENTS,
    });
    return { webhookSecret: storedSecret, webhookEndpointId: existing.id };
  }

  if (existing) {
    await stripe.webhookEndpoints.del(existing.id);
  }

  const newEndpoint = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: WEBHOOK_EVENTS,
  });

  const secret = newEndpoint.secret!;
  await storeWebhookSecret(stage, secret);

  return { webhookSecret: secret, webhookEndpointId: newEndpoint.id };
}

async function teardownStripeWebhook(
  stripe: Stripe,
  siteUrl: string,
  stage: string,
): Promise<void> {
  const webhookUrl = `${siteUrl}/api/stripe/webhook`;

  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = endpoints.data.find((ep) => ep.url === webhookUrl);

  if (existing) {
    await stripe.webhookEndpoints.del(existing.id);
  }

  await deleteWebhookSecret(stage);
}

// ── Auth0 helpers ─────────────────────────────────────────────────────

async function getAuth0ManagementToken(domain: string): Promise<string> {
  const resp = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: Resource.Auth0MgmtClientId.value,
      client_secret: Resource.Auth0MgmtClientSecret.value,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 token request failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

async function getAuth0Client(
  domain: string,
  token: string,
  clientId: string,
): Promise<Auth0Client> {
  const resp = await fetch(`https://${domain}/api/v2/clients/${clientId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 get client failed (${resp.status}): ${body}`);
  }

  return (await resp.json()) as Auth0Client;
}

async function patchAuth0Client(
  domain: string,
  token: string,
  clientId: string,
  patch: Partial<Auth0Client>,
): Promise<void> {
  const resp = await fetch(`https://${domain}/api/v2/clients/${clientId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 update client failed (${resp.status}): ${body}`);
  }
}

function addUnique(existing: string[], value: string): string[] {
  return existing.includes(value) ? existing : [...existing, value];
}

function removeValue(existing: string[], value: string): string[] {
  return existing.filter((v) => v !== value);
}

async function setupAuth0Callbacks(domain: string, siteUrl: string): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const clientId = Resource.Auth0ClientId.value;
  const client = await getAuth0Client(domain, token, clientId);

  const callbackUrl = `${siteUrl}/api/auth/callback`;
  const loginUrl = `${siteUrl}/sign-in`;

  await patchAuth0Client(domain, token, clientId, {
    callbacks: addUnique(client.callbacks ?? [], callbackUrl),
    allowed_logout_urls: addUnique(client.allowed_logout_urls ?? [], loginUrl),
    web_origins: addUnique(client.web_origins ?? [], siteUrl),
    initiate_login_uri: addUnique(
      (client.initiate_login_uri ?? '').split(',').filter(Boolean),
      loginUrl,
    ).join(','),
  });
}

async function teardownAuth0Callbacks(domain: string, siteUrl: string): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const clientId = Resource.Auth0ClientId.value;
  const client = await getAuth0Client(domain, token, clientId);

  const callbackUrl = `${siteUrl}/api/auth/callback`;
  const logoutUrl = `${siteUrl}/sign-in`;

  const patch: Partial<Auth0Client> = {
    callbacks: removeValue(client.callbacks ?? [], callbackUrl),
    allowed_logout_urls: removeValue(client.allowed_logout_urls ?? [], logoutUrl),
    web_origins: removeValue(client.web_origins ?? [], siteUrl),
  };

  const loginUris = (client.initiate_login_uri ?? '').split(',').filter(Boolean);
  const cleanedLoginUris = removeValue(loginUris, `${siteUrl}/sign-in`);
  patch.initiate_login_uri = cleanedLoginUris.join(',');

  await patchAuth0Client(domain, token, clientId, patch);
}

// ── CloudFormation Custom Resource response ───────────────────────────

async function sendCfnResponse(event: SetupEvent, response: SetupResponse): Promise<void> {
  const body = JSON.stringify(response);
  await fetch(event.ResponseURL, {
    method: 'PUT',
    headers: { 'Content-Type': '', 'Content-Length': String(body.length) },
    body,
  });
}

// ── Handler ───────────────────────────────────────────────────────────

export async function handler(event: SetupEvent): Promise<void> {
  const { SiteUrl, Stage } = event.ResourceProperties;
  const siteUrl = SiteUrl.replace(/\/$/, '');
  const physicalResourceId =
    ('PhysicalResourceId' in event ? event.PhysicalResourceId : undefined) ??
    `hyperspace-setup-${Stage}`;

  try {
    if (event.RequestType === 'Delete') {
      const stripe = new Stripe(Resource.StripeSecretKey.value);

      await Promise.all([
        teardownStripeWebhook(stripe, siteUrl, Stage),
        teardownAuth0Callbacks(process.env.AUTH0_DOMAIN!, siteUrl),
      ]);

      console.log('Teardown complete:', { siteUrl, stage: Stage });

      await sendCfnResponse(event, {
        Status: 'SUCCESS',
        PhysicalResourceId: physicalResourceId,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
      });
      return;
    }

    // Create or Update
    const stripe = new Stripe(Resource.StripeSecretKey.value);

    // If Update changed the SiteUrl, clean up old URLs first
    if (event.RequestType === 'Update') {
      const oldUrl = event.OldResourceProperties.SiteUrl?.replace(/\/$/, '');
      if (oldUrl && oldUrl !== siteUrl) {
        await Promise.all([
          teardownStripeWebhook(stripe, oldUrl, Stage),
          teardownAuth0Callbacks(process.env.AUTH0_DOMAIN!, oldUrl),
        ]);
      }
    }

    const [stripeResult] = await Promise.all([
      setupStripeWebhook(stripe, siteUrl, Stage),
      setupAuth0Callbacks(process.env.AUTH0_DOMAIN!, siteUrl),
    ]);

    console.log('Setup complete:', {
      webhookEndpointId: stripeResult.webhookEndpointId,
      siteUrl,
      stage: Stage,
    });

    await sendCfnResponse(event, {
      Status: 'SUCCESS',
      PhysicalResourceId: physicalResourceId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: {
        webhookSecret: stripeResult.webhookSecret,
        webhookEndpointId: stripeResult.webhookEndpointId,
      },
    });
  } catch (err: unknown) {
    console.error('Setup/teardown failed:', err);

    await sendCfnResponse(event, {
      Status: 'FAILED',
      Reason: err instanceof Error ? err.message : String(err),
      PhysicalResourceId: physicalResourceId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
    });
  }
}
