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

const PROTECTED_STAGES = new Set(['production', 'staging']);

const ssm = new SSMClient({});

function ssmParamName(stage: string): string {
  return `/filone/${stage}/stripe-webhook-secret`;
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
      metadata: { app: 'filone', stage },
    });
    return { webhookSecret: storedSecret, webhookEndpointId: existing.id };
  }

  if (existing) {
    await stripe.webhookEndpoints.del(existing.id);
  }

  // Clean up disabled endpoints to stay under Stripe's 16-endpoint test limit.
  // Endpoints are disabled by Stripe after repeated delivery failures (e.g. when
  // a preview environment has been torn down but the endpoint wasn't deleted).
  // Only clean up from non-production stages — production should never delete
  // other endpoints.
  if (stage !== 'production') {
    const disabled = endpoints.data.filter(
      (ep) => isOrphanedEphemeralEndpoint(ep) && ep.id !== existing?.id,
    );
    await Promise.all(disabled.map((ep) => stripe.webhookEndpoints.del(ep.id)));
  }

  const newEndpoint = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: WEBHOOK_EVENTS,
    metadata: { app: 'filone', stage },
  });

  const secret = newEndpoint.secret!;
  await storeWebhookSecret(stage, secret);

  return { webhookSecret: secret, webhookEndpointId: newEndpoint.id };
}

function isOrphanedEphemeralEndpoint(ep: Stripe.WebhookEndpoint): boolean {
  const stage = ep.metadata?.stage;
  return (
    ep.status === 'disabled' &&
    ep.metadata?.app === 'filone' &&
    !!stage &&
    !PROTECTED_STAGES.has(stage)
  );
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

async function setupAuth0Callbacks(
  domain: string,
  siteUrl: string,
  isStagingOrProd: boolean,
): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const clientId = Resource.Auth0ClientId.value;
  const client = await getAuth0Client(domain, token, clientId);

  const callbackUrl = `${siteUrl}/api/auth/callback`;
  const loginUrl = `${siteUrl}/sign-in`;

  const patch: Partial<Auth0Client> = {
    callbacks: addUnique(client.callbacks ?? [], callbackUrl),
    allowed_logout_urls: addUnique(client.allowed_logout_urls ?? [], loginUrl),
    web_origins: addUnique(client.web_origins ?? [], siteUrl),
  };

  if (isStagingOrProd) {
    patch.initiate_login_uri = loginUrl;
  }

  await patchAuth0Client(domain, token, clientId, patch);
}

async function teardownAuth0Callbacks(
  domain: string,
  siteUrl: string,
  isStagingOrProd: boolean,
): Promise<void> {
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

  if (isStagingOrProd) {
    patch.initiate_login_uri = '';
  }

  await patchAuth0Client(domain, token, clientId, patch);
}

// ── Auth0 email provider helper ───────────────────────────────────────

async function setupAuth0EmailProvider(domain: string, isProduction: boolean): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const fromAddress = isProduction ? 'no-reply@filone.ai' : 'no-reply+staging@filone.ai';

  const resp = await fetch(`https://${domain}/api/v2/emails/provider`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'sendgrid',
      enabled: true,
      credentials: { api_key: Resource.SendGridApiKey.value },
      default_from_address: fromAddress,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 email provider setup failed (${resp.status}): ${body}`);
  }
}

// ── Auth0 MFA Action helper ──────────────────────────────────────────

const MFA_ACTION_NAME = 'MFA Enrollment Trigger';

const MFA_ACTION_CODE = `
exports.onExecutePostLogin = async (event, api) => {
  const mfaFactors = (event.user.enrolledFactors || []).filter(
    (f) => f.type === 'otp' || f.type === 'webauthn-roaming' || f.type === 'recovery-code'
  );
  const hasMfa = mfaFactors.length > 0;
  const mfaEnrolling = event.user.app_metadata?.mfa_enrolling === true;

  if (mfaEnrolling && !hasMfa) {
    // User clicked "Enable" — let them choose OTP or WebAuthn.
    // Email is not supported for enrollment via Actions.
    api.authentication.enrollWithAny([{ type: 'otp' }, { type: 'webauthn-roaming' }]);
  } else if (mfaEnrolling && hasMfa) {
    // Already enrolled (e.g. re-login after enrolling). Clear the flag and challenge.
    api.user.setAppMetadata('mfa_enrolling', false);
    api.authentication.challengeWithAny([{ type: 'otp' }, { type: 'webauthn-roaming' }, { type: 'email' }]);
  } else if (hasMfa) {
    // Normal login for enrolled user — challenge with any enrolled factor.
    api.authentication.challengeWithAny([{ type: 'otp' }, { type: 'webauthn-roaming' }, { type: 'email' }]);
  }
  // No MFA enrolled and not enrolling — skip MFA.
};
`.trim();

interface Auth0Action {
  id: string;
  name: string;
  code: string;
}

interface Auth0Trigger {
  bindings: { ref: { type: string; value: string }; display_name: string }[];
}

async function setupAuth0MfaAction(domain: string): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Check if the action already exists
  const listResp = await fetch(
    `https://${domain}/api/v2/actions/actions?actionName=${encodeURIComponent(MFA_ACTION_NAME)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!listResp.ok) {
    const body = await listResp.text();
    throw new Error(`Auth0 list actions failed (${listResp.status}): ${body}`);
  }

  const { actions } = (await listResp.json()) as { actions: Auth0Action[] };
  const existing = actions.find((a) => a.name === MFA_ACTION_NAME);

  let actionId: string;

  if (existing) {
    // Update if code has changed
    if (existing.code.trim() !== MFA_ACTION_CODE) {
      const updateResp = await fetch(`https://${domain}/api/v2/actions/actions/${existing.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ code: MFA_ACTION_CODE }),
      });
      if (!updateResp.ok) {
        const body = await updateResp.text();
        throw new Error(`Auth0 update action failed (${updateResp.status}): ${body}`);
      }
    }
    actionId = existing.id;
  } else {
    // Create the action
    const createResp = await fetch(`https://${domain}/api/v2/actions/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: MFA_ACTION_NAME,
        supported_triggers: [{ id: 'post-login', version: 'v3' }],
        code: MFA_ACTION_CODE,
      }),
    });
    if (!createResp.ok) {
      const body = await createResp.text();
      throw new Error(`Auth0 create action failed (${createResp.status}): ${body}`);
    }
    const created = (await createResp.json()) as Auth0Action;
    actionId = created.id;
  }

  // Wait for the action to be built before deploying.
  // Auth0 compiles actions asynchronously after create/update.
  for (let attempt = 0; attempt < 10; attempt++) {
    const statusResp = await fetch(`https://${domain}/api/v2/actions/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!statusResp.ok) {
      const body = await statusResp.text();
      throw new Error(`Auth0 get action status failed (${statusResp.status}): ${body}`);
    }
    const action = (await statusResp.json()) as Auth0Action & { status: string };
    if (action.status === 'built') break;
    if (attempt === 9) {
      throw new Error(
        `Auth0 action did not reach 'built' state after 10 attempts (status: ${action.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Deploy the action
  const deployResp = await fetch(`https://${domain}/api/v2/actions/actions/${actionId}/deploy`, {
    method: 'POST',
    headers,
  });
  if (!deployResp.ok) {
    const body = await deployResp.text();
    throw new Error(`Auth0 deploy action failed (${deployResp.status}): ${body}`);
  }

  // Ensure the action is bound to the post-login trigger
  const triggerResp = await fetch(`https://${domain}/api/v2/actions/triggers/post-login/bindings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!triggerResp.ok) {
    const body = await triggerResp.text();
    throw new Error(`Auth0 get trigger bindings failed (${triggerResp.status}): ${body}`);
  }

  const trigger = (await triggerResp.json()) as Auth0Trigger;
  const bindings = trigger.bindings ?? [];
  const alreadyBound = bindings.some(
    (b) => b.ref?.type === 'action_id' && b.ref?.value === actionId,
  );

  if (!alreadyBound) {
    // Preserve existing bindings, filtering out any with missing refs
    const existingBindings = bindings
      .filter((b) => b.ref && b.display_name)
      .map((b) => ({ ref: b.ref, display_name: b.display_name }));
    const newBindings = [
      ...existingBindings,
      { ref: { type: 'action_id' as const, value: actionId }, display_name: MFA_ACTION_NAME },
    ];

    const bindResp = await fetch(`https://${domain}/api/v2/actions/triggers/post-login/bindings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ bindings: newBindings }),
    });
    if (!bindResp.ok) {
      const body = await bindResp.text();
      throw new Error(`Auth0 update trigger bindings failed (${bindResp.status}): ${body}`);
    }
  }
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
    `filone-setup-${Stage}`;

  try {
    const isStagingOrProd = Stage === 'staging' || Stage === 'production';

    if (event.RequestType === 'Delete') {
      const stripe = new Stripe(Resource.StripeSecretKey.value);

      await Promise.all([
        teardownStripeWebhook(stripe, siteUrl, Stage),
        teardownAuth0Callbacks(process.env.AUTH0_DOMAIN!, siteUrl, isStagingOrProd),
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
          teardownAuth0Callbacks(process.env.AUTH0_DOMAIN!, oldUrl, isStagingOrProd),
        ]);
      }
    }

    const [stripeResult] = await Promise.all([
      setupStripeWebhook(stripe, siteUrl, Stage),
      setupAuth0Callbacks(process.env.AUTH0_DOMAIN!, siteUrl, isStagingOrProd),
      ...(isStagingOrProd
        ? [
            setupAuth0MfaAction(process.env.AUTH0_DOMAIN!),
            setupAuth0EmailProvider(process.env.AUTH0_DOMAIN!, Stage === 'production').catch(
              (err) => console.error('[setup] Email provider setup failed (non-fatal):', err),
            ),
          ]
        : []),
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
