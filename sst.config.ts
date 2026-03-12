/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const stage = input?.stage;
    const isProduction = stage === 'production';
    const isStaging = stage === 'staging';

    // Region: us-east-2 for staging/production, AWS_REGION / profile default for personal dev
    const region =
      isProduction || isStaging
        ? 'us-east-2'
        : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2');

    const awsProvider: Record<string, unknown> = { region };

    if (isStaging) {
      awsProvider.allowedAccountIds = ['654654381893'];
    }

    if (isProduction) {
      awsProvider.allowedAccountIds = ['811430801166'];
    }

    return {
      name: 'filone',
      removal: isProduction ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: awsProvider,
      },
    };
  },
  async run() {
    // ── Secrets (set via: pnpx sst secret set <Name> <value>) ─────────
    const auth0ClientId = new sst.Secret('Auth0ClientId');
    const auth0ClientSecret = new sst.Secret('Auth0ClientSecret');
    const auth0MgmtClientId = new sst.Secret('Auth0MgmtClientId');
    const auth0MgmtClientSecret = new sst.Secret('Auth0MgmtClientSecret');
    const stripeSecretKey = new sst.Secret('StripeSecretKey');
    const stripePriceId = new sst.Secret('StripePriceId');
    const auroraBackofficeToken = new sst.Secret('AuroraBackofficeToken');
    const AWS_CACHING_DISABLED_POLICY = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

    // ── DynamoDB Tables ──────────────────────────────────────────────
    const uploadsTable = new sst.aws.Dynamo('UploadsTable', {
      fields: {
        pk: 'string',
        sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
    });

    const billingTable = new sst.aws.Dynamo('BillingTable', {
      fields: {
        pk: 'string',
        sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
      ttl: 'ttl',
    });

    const userInfoTable = new sst.aws.Dynamo('UserInfoTable', {
      fields: {
        pk: 'string',
        sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
    });

    // ── SQS Queues ─────────────────────────────────────────────────
    const tenantSetupDlq = new sst.aws.Queue('AuroraTenantSetupDlq', {
      fifo: true,
    });

    const tenantSetupQueue = new sst.aws.Queue('AuroraTenantSetupQueue', {
      fifo: true,
      dlq: tenantSetupDlq.arn,
      // Make visibility timeout longer than the Lambda timeout to avoid multiple retries
      visibilityTimeout: '90 seconds',
    });

    // ── S3 Bucket for user file storage ──────────────────────────────
    const userFilesBucket = new sst.aws.Bucket('UserFilesBucket');

    // ── Stage-aware domain config ────────────────────────────────────
    const stage = $app.stage;
    const isProduction = stage === 'production';

    let domainName = 'staging.fil.one';
    let certArn: string | undefined;

    //TODO Bring this back after we have a successful prod deployment.
    // https://linear.app/filecoin-foundation/issue/FIL-12/console-prod-deployed-at-appfilone
    // if (stage === 'production' || stage === 'staging') {
    // domainName = stage === 'production' ? 'console.fil.one' : 'staging.fil.one';
    if (stage == 'staging') {
      // ACM cert must be in us-east-1 for CloudFront
      const usEast1 = new aws.Provider('useast1', { region: 'us-east-1' });
      const cert = await aws.acm.getCertificate(
        {
          domain: domainName,
          statuses: ['ISSUED'],
        },
        { provider: usEast1 },
      );

      certArn = cert.arn;
    }

    // ── API Gateway ──────────────────────────────────────────────────
    // While we stick to a same origin for both website and API,
    // we want to make sure to lock down to just our origin.
    const allowedOrigins = domainName ? [`https://${domainName}`] : [];
    if (stage !== 'production') {
      allowedOrigins.push('https://localhost:5173');
    }

    const api = new sst.aws.ApiGatewayV2('Api', {
      cors: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Requested-With'],
        allowCredentials: true,
        maxAge: '1 day',
      },
    });

    // ── Website (S3 + CloudFront via sst.aws.Router) ─────────────────
    const { local } = await import('@pulumi/command');

    const websiteBucket = new sst.aws.Bucket('WebsiteBucket', {
      access: 'cloudfront',
      transform: {
        bucket: { forceDestroy: true },
      },
    });

    const router = new sst.aws.Router('WebsiteRouter', {
      routes: {
        '/*': { bucket: websiteBucket },
        '/api/*': {
          url: api.url,
          cachePolicy: AWS_CACHING_DISABLED_POLICY,
        },
      },
      ...(domainName && certArn ? { domain: { name: domainName, dns: false, cert: certArn } } : {}),
      transform: {
        cdn: (args) => {
          args.defaultRootObject = 'index.html';
          args.customErrorResponses = [
            {
              errorCode: 403,
              responseCode: 200,
              responsePagePath: '/index.html',
              errorCachingMinTtl: 0,
            },
            {
              errorCode: 404,
              responseCode: 200,
              responsePagePath: '/index.html',
              errorCachingMinTtl: 0,
            },
          ];
        },
      },
    });

    const distPath = require('path').resolve('packages/website/dist');
    const sync = new local.Command('WebsiteSync', {
      create: $interpolate`aws s3 sync ${distPath} s3://${websiteBucket.nodes.bucket.bucket} --delete`,
      triggers: [Date.now().toString()],
    });

    new local.Command(
      'WebsiteInvalidation',
      {
        create: $interpolate`aws cloudfront create-invalidation --distribution-id ${router.distributionID} --paths "/*"`,
        triggers: [Date.now().toString()],
      },
      { dependsOn: [sync] },
    );

    const siteUrl = router.url;

    // ── Deploy-time setup (Stripe webhook + Auth0 callbacks) ────────
    const setupFn = new sst.aws.Function('SetupIntegrations', {
      handler: 'packages/backend/src/handlers/setup-integrations.handler',
      link: [stripeSecretKey, auth0MgmtClientId, auth0MgmtClientSecret, auth0ClientId],
      environment: {
        AUTH0_DOMAIN: 'dev-oar2nhqh58xf5pwf.us.auth0.com',
      },
      permissions: [
        {
          actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
          resources: [$interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/*`],
        },
      ],
      runtime: 'nodejs24.x',
      timeout: '30 seconds',
    });

    new aws.cloudformation.Stack('SetupStack', {
      templateBody: $jsonStringify({
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          Setup: {
            Type: 'Custom::FiloneSetup',
            Properties: {
              ServiceToken: setupFn.arn,
              SiteUrl: siteUrl,
              Stage: $app.stage,
            },
          },
        },
      }),
    });

    // ── Shared function config ───────────────────────────────────────
    const allResources = [
      uploadsTable,
      billingTable,
      userInfoTable,
      userFilesBucket,
      tenantSetupQueue,
      auth0ClientId,
      auth0ClientSecret,
      stripeSecretKey,
      stripePriceId,
    ];

    const sharedEnv: Record<string, $util.Input<string>> = {
      FILONE_STAGE: $app.stage,
      AUTH0_DOMAIN: 'dev-oar2nhqh58xf5pwf.us.auth0.com',
      AUTH0_AUDIENCE: 'https://staging.fil.one',
    };

    if (isProduction) {
      throw new Error(
        'Aurora production configuration not yet available. ' +
          'Set AURORA_BACKOFFICE_URL, AURORA_PORTAL_URL, AURORA_PARTNER_ID, and AURORA_REGION_ID before deploying to production.',
      );
    }

    const auroraEnv = {
      AURORA_BACKOFFICE_URL: 'https://api.backoffice.dev.aur.lu/api',
      AURORA_PORTAL_URL: 'https://api.portal.dev.aur.lu/api/v1',
      AURORA_PARTNER_ID: 'ff',
      AURORA_REGION_ID: 'ff',
    };

    function addRoute(
      method: string,
      routePath: string,
      handler: string,
      extraEnv?: Record<string, $util.Input<string>>,
      permissions?: sst.aws.FunctionPermissionArgs[],
    ) {
      // e.g. "get-me", "auth-callback" → "GetMe", "AuthCallback"
      const fnName = handler
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');

      api.route(`${method} ${routePath}`, {
        handler: `packages/backend/src/handlers/${handler}.handler`,
        name: $interpolate`filone-${$app.stage}-${fnName}`,
        link: allResources,
        environment: {
          ...sharedEnv,
          ...extraEnv,
        },
        permissions,
        runtime: 'nodejs24.x',
        timeout: '10 seconds',
      });
    }

    // ── Data routes ──────────────────────────────────────────────────
    addRoute('POST', '/api/upload', 'upload');
    addRoute('GET', '/api/buckets', 'list-buckets');
    addRoute(
      'POST',
      '/api/buckets',
      'create-bucket',
      {
        AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL,
      },
      [
        {
          actions: ['ssm:GetParameter'],
          resources: [
            $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-portal/tenant-api-key/*`,
          ],
        },
      ],
    );
    addRoute('DELETE', '/api/buckets/{name}', 'delete-bucket');
    addRoute('GET', '/api/buckets/{name}/objects', 'list-objects');
    addRoute('POST', '/api/buckets/{name}/objects/upload', 'upload-object');
    addRoute('GET', '/api/buckets/{name}/objects/download', 'download-object');
    addRoute('DELETE', '/api/buckets/{name}/objects', 'delete-object');

    // ── Auth routes ──────────────────────────────────────────────────
    const allowedRedirectOrigins = allowedOrigins.join(',');
    addRoute('GET', '/api/auth/callback', 'auth-callback', {
      WEBSITE_URL: siteUrl,
      ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins,
    });
    addRoute('GET', '/api/auth/logout', 'auth-logout', {
      WEBSITE_URL: siteUrl,
      ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins,
    });

    // ── Me route ───────────────────────────────────────────────────
    addRoute('GET', '/api/me', 'get-me');

    // ── Org routes ──────────────────────────────────────────────────
    addRoute('POST', '/api/org/confirm', 'confirm-org');

    // ── Billing routes ───────────────────────────────────────────────
    addRoute('GET', '/api/billing', 'get-billing');
    addRoute('POST', '/api/billing/setup-intent', 'create-setup-intent');
    addRoute('POST', '/api/billing/activate', 'activate-subscription');
    addRoute('POST', '/api/billing/portal', 'create-portal-session', {
      WEBSITE_URL: siteUrl,
    });
    addRoute(
      'POST',
      '/api/stripe/webhook',
      'stripe-webhook',
      {
        STRIPE_WEBHOOK_SECRET_SSM_PATH: $interpolate`/filone/${$app.stage}/stripe-webhook-secret`,
      },
      [
        {
          actions: ['ssm:GetParameter'],
          resources: [
            $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/stripe-webhook-secret`,
          ],
        },
      ],
    );

    // ── Tenant setup consumer ──────────────────────────────────────
    tenantSetupQueue.subscribe(
      {
        handler: 'packages/backend/src/handlers/aurora-tenant-setup.handler',
        link: [userInfoTable, auroraBackofficeToken],
        environment: {
          ...auroraEnv,
          ...sharedEnv,
        },
        permissions: [
          {
            actions: ['ssm:PutParameter'],
            resources: [
              $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-portal/tenant-api-key/*`,
            ],
          },
        ],
        runtime: 'nodejs24.x',
        timeout: '60 seconds',
      },
      { batch: { size: 1 } },
    );

    // ── CloudWatch alarm on DLQ ──────────────────────────────────
    // TODO: Rework this alarm to trigger alert in Grafana IRM
    new aws.cloudwatch.MetricAlarm('AuroraTenantSetupDlqAlarm', {
      alarmDescription: 'Messages in tenant-setup DLQ — failed tenant setup needs investigation',
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensions: { QueueName: tenantSetupDlq.nodes.queue.name },
      statistic: 'Maximum',
      period: 60,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      treatMissingData: 'notBreaching',
    });

    // ── Usage reporting (cron-based) ────────────────────────────────
    const usageWorker = new sst.aws.Function('UsageReportingWorker', {
      handler: 'packages/backend/src/jobs/usage-reporting-worker.handler',
      link: [billingTable, stripeSecretKey, auroraBackofficeToken],
      environment: { ...auroraEnv, STRIPE_METER_EVENT_NAME: 'tibmonthmeter' },
      runtime: 'nodejs24.x',
      timeout: '60 seconds',
      memory: '256 MB',
    });

    const usageOrchestrator = new sst.aws.Function('UsageReportingOrchestrator', {
      handler: 'packages/backend/src/jobs/usage-reporting-orchestrator.handler',
      link: [billingTable],
      environment: {
        USAGE_WORKER_FUNCTION_NAME: usageWorker.name,
        STRIPE_METER_EVENT_NAME: 'tibmonthmeter',
      },
      runtime: 'nodejs24.x',
      timeout: '300 seconds',
      memory: '256 MB',
      permissions: [
        {
          actions: ['lambda:InvokeFunction'],
          resources: [usageWorker.arn],
        },
      ],
    });

    new sst.aws.Cron('UsageReportingCron', {
      // run the Lambda every day at 6:00 AM UTC.
      schedule: 'cron(0 6 * * ? *)',
      function: usageOrchestrator.arn,
    });

    return {
      baseUrl: siteUrl,
    };
  },
});
