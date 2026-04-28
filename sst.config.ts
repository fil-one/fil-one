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

    const awsProvider: aws.ProviderArgs & { version: string } = {
      version: require('@pulumi/aws/package.json').version,
      region,
    };

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
    // ⚠️  All Lambda functions MUST be created via createFn() to ensure
    //     log forwarding is set up. Never use `new sst.aws.Function()` directly.

    // ── Secrets (set via: pnpx sst secret set <Name> <value>) ─────────
    const auth0ClientId = new sst.Secret('Auth0ClientId');
    const auth0ClientSecret = new sst.Secret('Auth0ClientSecret');
    const auth0MgmtClientId = new sst.Secret('Auth0MgmtClientId');
    const auth0MgmtClientSecret = new sst.Secret('Auth0MgmtClientSecret');
    // Separate runtime M2M credentials (different scopes than setup credentials)
    const auth0MgmtRuntimeClientId = new sst.Secret('Auth0MgmtRuntimeClientId');
    const auth0MgmtRuntimeClientSecret = new sst.Secret('Auth0MgmtRuntimeClientSecret');
    const stripeSecretKey = new sst.Secret('StripeSecretKey');
    const stripePublishableKey = new sst.Secret('StripePublishableKey');
    const stripePriceId = new sst.Secret('StripePriceId');
    const auroraBackofficeToken = new sst.Secret('AuroraBackofficeToken');
    const grafanaLokiAuth = new sst.Secret('GrafanaLokiAuth');
    const sendGridApiKey =
      $app.stage === 'staging' || $app.stage === 'production'
        ? new sst.Secret('SendGridApiKey')
        : undefined;
    const AWS_CACHING_DISABLED_POLICY = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

    // ── Global Function settings ────────────────────────────
    $transform(sst.aws.Function, (args) => {
      args.runtime = args.runtime ?? 'nodejs24.x';
      args.memory = args.memory ?? '512 MB';
      args.architecture = args.architecture ?? 'arm64';

      // In production, suppress console.log/info/debug — only WARN and above are emitted.
      if ($app.stage === 'production') {
        args.transform = args.transform ?? {};
        args.transform.function = (fnArgs) => {
          fnArgs.loggingConfig = $output(fnArgs.loggingConfig).apply((loggingConfig) => ({
            logFormat: 'JSON',
            ...loggingConfig,
            applicationLogLevel: 'WARN',
          }));
        };
      }
    });

    // ── DynamoDB Tables ──────────────────────────────────────────────
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
    const isStaging = stage === 'staging';
    const isEphemeralStage = !isProduction && !isStaging;

    let domainName = 'staging.fil.one';
    let certArn: string | undefined;

    if (isProduction || isStaging) {
      domainName = isProduction ? 'app.fil.one' : 'staging.fil.one';
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
      accessLog: { retention: '1 week' },
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

    const { getAuth0Domain, getS3Endpoint, S3_REGION, Stage } = await import('@filone/shared');
    const auroraS3GatewayUrl = getS3Endpoint(
      S3_REGION,
      isProduction ? Stage.Production : Stage.Staging,
    );

    // ── CloudFront security headers (CSP applied to the HTML document) ──
    const sentryCspEndpoint =
      'https://o4507369657991168.ingest.us.sentry.io/api/4511144562655232/security/' +
      `?sentry_key=a67c49004e3562393b7c63deedcbb951&sentry_environment=${isProduction ? 'production' : 'staging'}`;

    const responseHeadersPolicy = new aws.cloudfront.ResponseHeadersPolicy(
      'WebsiteSecurityHeaders',
      {
        name: $interpolate`filone-${$app.stage}-security-headers`,
        securityHeadersConfig: {
          contentSecurityPolicy: {
            // i1.wp.com: WordPress Photon CDN — Auth0 proxies some avatar images through it
            contentSecurityPolicy: $interpolate`default-src 'none'; script-src 'self' https://plausible.io https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' blob: https://lh3.googleusercontent.com https://s.gravatar.com https://cdn.auth0.com https://i1.wp.com https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self' https://api.stripe.com https://api.hsforms.com https://o4507369657991168.ingest.us.sentry.io https://plausible.io/api ${auroraS3GatewayUrl}; frame-src https://js.stripe.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; report-uri ${sentryCspEndpoint}; report-to csp-endpoint`,
            override: true,
          },
          frameOptions: {
            frameOption: 'DENY',
            override: true,
          },
          contentTypeOptions: {
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: 'strict-origin-when-cross-origin',
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAgeSec: 2592000, // 30 days
            includeSubdomains: true,
            override: true,
          },
        },
        customHeadersConfig: {
          items: [
            {
              header: 'Report-To',
              value: JSON.stringify({
                group: 'csp-endpoint',
                max_age: 10886400,
                endpoints: [{ url: sentryCspEndpoint }],
                include_subdomains: true,
              }),
              override: true,
            },
            {
              header: 'Reporting-Endpoints',
              value: `csp-endpoint="${sentryCspEndpoint}"`,
              override: true,
            },
          ],
        },
      },
    );

    const router = new sst.aws.Router('WebsiteRouter', {
      routes: {
        '/*': { bucket: websiteBucket },
        '/api/*': {
          url: api.url,
          cachePolicy: AWS_CACHING_DISABLED_POLICY,
        },
        '/login': {
          url: api.url,
          cachePolicy: AWS_CACHING_DISABLED_POLICY,
        },
        '/logout': {
          url: api.url,
          cachePolicy: AWS_CACHING_DISABLED_POLICY,
        },
      },
      ...(domainName && certArn ? { domain: { name: domainName, dns: false, cert: certArn } } : {}),
      transform: {
        cdn: (args) => {
          args.defaultRootObject = 'index.html';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pulumi Input wrapper; value is a plain object at transform time
          (args.defaultCacheBehavior as any).responseHeadersPolicyId = responseHeadersPolicy.id;
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

    const auth0Domain = getAuth0Domain($app.stage);
    // Auth0 Management API requires the canonical tenant domain — custom domains don't support /api/v2/
    const auth0MgmtDomain = isProduction ? 'fil-one.us.auth0.com' : auth0Domain;

    // ── Deploy-time setup (Stripe webhook + Auth0 callbacks) ────────
    // This Lambda is intentionally NOT created via createFn(). Its ARN is embedded in the
    // CloudFormation SetupStack template; changing the ARN (e.g. by migrating to createFn) would
    // require replacing the CF stack, which triggers unwanted teardown/recreation of the custom
    // resource.
    const setupFn = new sst.aws.Function('SetupIntegrations', {
      handler: 'packages/backend/src/jobs/stack-setup/setup-integrations.handler',
      link: [
        stripeSecretKey,
        auth0MgmtClientId,
        auth0MgmtClientSecret,
        auth0ClientId,
        ...(sendGridApiKey ? [sendGridApiKey] : []),
      ],
      environment: {
        AUTH0_DOMAIN: auth0Domain,
        AUTH0_MGMT_DOMAIN: auth0MgmtDomain,
      },
      permissions: [
        {
          actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
          resources: [$interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/*`],
        },
      ],
      logging: { retention: '1 week', format: 'json' },
      timeout: '10 seconds',
    });

    new aws.cloudformation.Stack('SetupStack', {
      ...(isEphemeralStage && { onFailure: 'DELETE' }),
      templateBody: $jsonStringify({
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          Setup: {
            Type: 'Custom::FiloneSetup',
            Properties: {
              ServiceToken: setupFn.arn,
              SiteUrl: siteUrl,
              Stage: $app.stage,
              Version: '2.2',
            },
          },
        },
      }),
    });

    // Ensure the Stripe webhook endpoint is removed when an ephemeral
    // stage is torn down. The CloudFormation custom resource above may
    // not fire its Delete event if the Lambda is destroyed first.
    if (isEphemeralStage) {
      const teardownScript = require('path').resolve(
        $cli.paths.root,
        'packages/backend/src/scripts/teardown-stripe-webhook.ts',
      );
      if (!require('fs').existsSync(teardownScript)) {
        throw new Error(`Teardown script not found: ${teardownScript}`);
      }
      new local.Command('TeardownStripeWebhook', {
        create: 'echo "Teardown hook registered"',
        delete: $interpolate`node "${teardownScript}"`,
        environment: {
          STRIPE_SECRET_KEY: stripeSecretKey.value,
          SITE_URL: siteUrl,
          STAGE: $app.stage,
        },
      });
    }

    // ── Shared function config ───────────────────────────────────────
    const allResources = [
      billingTable,
      userInfoTable,
      userFilesBucket,
      tenantSetupQueue,
      auth0ClientId,
      auth0ClientSecret,
      stripeSecretKey,
      stripePublishableKey,
      stripePriceId,
      auroraBackofficeToken,
    ];
    // Management API runtime credentials — linked only to handlers that call the Auth0 Management API
    const mgmtRuntimeResources = [auth0MgmtRuntimeClientId, auth0MgmtRuntimeClientSecret];

    const sharedEnv: Record<string, $util.Input<string>> = {
      FILONE_STAGE: $app.stage,
      AUTH0_DOMAIN: auth0Domain,
      AUTH0_AUDIENCE: isProduction ? 'https://app.fil.one' : 'https://staging.fil.one',
    };

    if (isProduction) {
      // TODO Add the prod Info here!
    }

    const auroraEnv = {
      AURORA_BACKOFFICE_URL: isProduction
        ? 'https://api-backoffice.aur.lu/api'
        : 'https://api.backoffice.dev.aur.lu/api',
      AURORA_PORTAL_URL: isProduction
        ? 'https://api-portal.aur.lu/api'
        : 'https://api.portal.dev.aur.lu/api',
      AURORA_PARTNER_ID: 'ff',
      AURORA_REGION_ID: 'ff',
    };

    const auroraApiKeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-portal/tenant-api-key/*`;
    const auroraS3KeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-s3/*`;
    const auroraS3GatewayPermissions: sst.aws.FunctionPermissionArgs[] = [
      {
        actions: ['ssm:GetParameter'],
        resources: [auroraS3KeySsmArn],
      },
    ];

    const { firehose, cwToFirehoseRole } = setupFirehoseLogPipeline(grafanaLokiAuth);

    // Forward API Gateway access logs to Grafana Loki via the same Firehose
    new aws.cloudwatch.LogSubscriptionFilter('ApiAccessLogFwd', {
      logGroup: api.nodes.logGroup.name,
      filterPattern: '',
      destinationArn: firehose.arn,
      roleArn: cwToFirehoseRole.arn,
    });

    // Forward SetupIntegrations logs to Grafana Loki. This function is not
    // created via createFn() (see comment above), so wire up forwarding manually.
    new aws.cloudwatch.LogSubscriptionFilter('SetupIntegrationsLogFwd', {
      logGroup: setupFn.nodes.logGroup.apply((lg) => lg!.name),
      filterPattern: '',
      destinationArn: firehose.arn,
      roleArn: cwToFirehoseRole.arn,
    });

    const createFn = (fnName: string, args: Omit<sst.aws.FunctionArgs, 'name'>) =>
      createFunction(fnName, args, { firehose, cwToFirehoseRole });

    interface AddRouteProps {
      method: string;
      routePath: string;
      handler: string;
      extraEnv?: Record<string, $util.Input<string>>;
      permissions?: sst.aws.FunctionPermissionArgs[];
      extraLink?: (typeof allResources)[number][];
      provisionedConcurrency?: number;
      memory?: sst.aws.FunctionArgs['memory'];
    }

    function addRoute({
      method,
      routePath,
      handler,
      extraEnv,
      permissions,
      extraLink,
      provisionedConcurrency,
      memory,
    }: AddRouteProps) {
      // e.g. "get-me", "auth-callback" → "GetMe", "AuthCallback"
      const fnName = handler
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');

      const fn = createFn(fnName, {
        handler: `packages/backend/src/handlers/${handler}.handler`,
        link: [...allResources, ...(extraLink ?? [])],
        environment: {
          ...sharedEnv,
          ...extraEnv,
        },
        permissions,
        timeout: '10 seconds',
        ...(memory ? { memory } : {}),
        ...(provisionedConcurrency && provisionedConcurrency > 0
          ? {
              versioning: true,
              concurrency: { provisioned: provisionedConcurrency },
            }
          : {}),
      });

      const isVersioned = provisionedConcurrency != null && provisionedConcurrency > 0;
      const invokeArn = isVersioned ? fn.nodes.function.qualifiedArn : fn.arn;

      api.route(`${method} ${routePath}`, invokeArn);

      // SST's api.route() with an ARN creates lambda.Permission with
      // qualifier: "" (from undefined), which doesn't actually grant
      // API Gateway invoke access. Add an explicit permission.
      new aws.lambda.Permission(`${fnName}ApiPermission`, {
        action: 'lambda:InvokeFunction',
        function: isVersioned ? fn.nodes.function.qualifiedArn : fn.nodes.function.name,
        principal: 'apigateway.amazonaws.com',
        sourceArn: $interpolate`${api.nodes.api.executionArn}/*`,
      });
    }

    // ── Provisioned concurrency for critical-path endpoints ────────
    const criticalPathLambdaProvisionedConcurrency = isProduction ? 1 : 0;

    // ── Data routes ──────────────────────────────────────────────────
    addRoute({
      method: 'GET',
      routePath: '/api/buckets',
      handler: 'list-buckets',
      extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL },
      permissions: [{ actions: ['ssm:GetParameter'], resources: [auroraApiKeySsmArn] }],
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      memory: '1024 MB',
    });
    addRoute({
      method: 'POST',
      routePath: '/api/buckets',
      handler: 'create-bucket',
      extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL },
      permissions: [{ actions: ['ssm:GetParameter'], resources: [auroraApiKeySsmArn] }],
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
    });
    addRoute({
      method: 'GET',
      routePath: '/api/buckets/{name}',
      handler: 'get-bucket',
      extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL },
      permissions: [{ actions: ['ssm:GetParameter'], resources: [auroraApiKeySsmArn] }],
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      memory: '1024 MB',
    });
    addRoute({
      method: 'DELETE',
      routePath: '/api/buckets/{name}',
      handler: 'delete-bucket',
      permissions: auroraS3GatewayPermissions,
    });
    addRoute({
      method: 'GET',
      routePath: '/api/access-keys',
      handler: 'list-access-keys',
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
    });
    addRoute({
      method: 'POST',
      routePath: '/api/access-keys',
      handler: 'create-access-key',
      extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL },
      permissions: [{ actions: ['ssm:GetParameter'], resources: [auroraApiKeySsmArn] }],
    });
    addRoute({
      method: 'DELETE',
      routePath: '/api/access-keys/{keyId}',
      handler: 'delete-access-key',
      extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL },
      permissions: [{ actions: ['ssm:GetParameter'], resources: [auroraApiKeySsmArn] }],
    });
    addRoute({
      method: 'POST',
      routePath: '/api/presign',
      handler: 'presign',
      permissions: auroraS3GatewayPermissions,
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      memory: '512 MB',
    });
    addRoute({
      method: 'GET',
      routePath: '/api/buckets/{name}/analytics',
      handler: 'get-bucket-analytics',
      permissions: [{ actions: ['ssm:GetParameter'], resources: [auroraApiKeySsmArn] }],
      extraEnv: auroraEnv,
    });

    // ── Auth routes ──────────────────────────────────────────────────
    const allowedRedirectOrigins = allowedOrigins.join(',');
    addRoute({
      method: 'GET',
      routePath: '/login',
      handler: 'auth-login',
      extraEnv: { WEBSITE_URL: siteUrl, ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins },
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
    });
    addRoute({
      method: 'GET',
      routePath: '/api/auth/callback',
      handler: 'auth-callback',
      extraEnv: { WEBSITE_URL: siteUrl, ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins },
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
    });
    addRoute({
      method: 'GET',
      routePath: '/logout',
      handler: 'auth-logout',
      extraEnv: { WEBSITE_URL: siteUrl, ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins },
    });

    // ── Me route ───────────────────────────────────────────────────
    addRoute({
      method: 'GET',
      routePath: '/api/me',
      handler: 'get-me',
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
    });
    addRoute({
      method: 'PATCH',
      routePath: '/api/me/profile',
      handler: 'update-profile',
      extraLink: mgmtRuntimeResources,
      extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
    });
    addRoute({ method: 'POST', routePath: '/api/me/change-password', handler: 'change-password' });
    addRoute({
      method: 'POST',
      routePath: '/api/me/resend-verification',
      handler: 'resend-verification',
      extraLink: mgmtRuntimeResources,
      extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
    });

    // ── Org routes ──────────────────────────────────────────────────
    addRoute({ method: 'POST', routePath: '/api/org/confirm', handler: 'confirm-org' });

    // ── Usage + Dashboard routes ─────────────────────────────────────
    addRoute({
      method: 'GET',
      routePath: '/api/usage',
      handler: 'get-usage',
      extraEnv: auroraEnv,
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
    });
    addRoute({
      method: 'GET',
      routePath: '/api/activity',
      handler: 'get-activity',
      extraEnv: auroraEnv,
      permissions: auroraS3GatewayPermissions,
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      memory: '1024 MB',
    });

    // ── Billing routes ───────────────────────────────────────────────
    addRoute({
      method: 'GET',
      routePath: '/api/billing',
      handler: 'get-billing',
      provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
    });
    addRoute({
      method: 'POST',
      routePath: '/api/billing/setup-intent',
      handler: 'create-setup-intent',
    });
    addRoute({
      method: 'POST',
      routePath: '/api/billing/activate',
      handler: 'activate-subscription',
      extraEnv: auroraEnv,
    });
    addRoute({ method: 'GET', routePath: '/api/billing/invoices', handler: 'list-invoices' });
    addRoute({
      method: 'POST',
      routePath: '/api/billing/portal',
      handler: 'create-portal-session',
      extraEnv: { WEBSITE_URL: siteUrl },
    });
    addRoute({
      method: 'POST',
      routePath: '/api/stripe/webhook',
      handler: 'stripe-webhook',
      extraEnv: {
        ...auroraEnv,
        STRIPE_WEBHOOK_SECRET_SSM_PATH: $interpolate`/filone/${$app.stage}/stripe-webhook-secret`,
      },
      permissions: [
        {
          actions: ['ssm:GetParameter'],
          resources: [
            $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/stripe-webhook-secret`,
          ],
        },
      ],
    });

    // ── Tenant setup consumer ──────────────────────────────────────
    const tenantSetupFn = createFn('AuroraTenantSetup', {
      handler: 'packages/backend/src/handlers/aurora-tenant-setup.handler',
      link: [userInfoTable, auroraBackofficeToken],
      environment: {
        ...auroraEnv,
        ...sharedEnv,
      },
      permissions: [
        {
          actions: ['ssm:GetParameter', 'ssm:PutParameter'],
          resources: [auroraApiKeySsmArn, auroraS3KeySsmArn],
        },
        // queue.subscribe(fn.arn) passes an ARN, so SST skips attaching
        // SQS permissions automatically — we must add them here.
        {
          actions: [
            'sqs:ChangeMessageVisibility',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
            'sqs:ReceiveMessage',
          ],
          resources: [tenantSetupQueue.arn],
        },
      ],
      timeout: '60 seconds',
    });

    tenantSetupQueue.subscribe(tenantSetupFn.arn, { batch: { size: 1 } });

    // ── Usage reporting (cron-based) ────────────────────────────────
    const usageWorker = createFn('UsageReportingWorker', {
      handler: 'packages/backend/src/jobs/usage-reporting-worker.handler',
      link: [billingTable, userInfoTable, stripeSecretKey, stripePriceId, auroraBackofficeToken],
      environment: { ...auroraEnv, STRIPE_METER_EVENT_NAME: 'gb_month_meter' },
      timeout: '60 seconds',
      memory: '256 MB',
    });

    const usageOrchestrator = createFn('UsageReportingOrchestrator', {
      handler: 'packages/backend/src/jobs/usage-reporting-orchestrator.handler',
      link: [billingTable, userInfoTable],
      environment: {
        USAGE_WORKER_FUNCTION_NAME: usageWorker.name,
        STRIPE_METER_EVENT_NAME: 'gb_month_meter',
      },
      timeout: '300 seconds',
      memory: '256 MB',
      permissions: [
        {
          actions: ['lambda:InvokeFunction'],
          resources: [usageWorker.arn],
        },
      ],
    });

    new sst.aws.CronV2('UsageReportingCron', {
      // run the Lambda every 12 hours (07:00 and 19:00 UTC).
      schedule: 'cron(0 7/12 * * ? *)',
      function: usageOrchestrator.arn,
    });

    // ── Grace period enforcement ────────────────────────────────────
    const gracePeriodEnforcer = createFn('GracePeriodEnforcer', {
      handler: 'packages/backend/src/jobs/grace-period-enforcer.handler',
      link: [billingTable, userInfoTable, auroraBackofficeToken],
      environment: auroraEnv,
      timeout: '300 seconds',
      memory: '256 MB',
    });

    new sst.aws.CronV2('GracePeriodEnforcerCron', {
      // run the Lambda every 12 hours, one hour after usage reporting (08:00 and 20:00 UTC).
      schedule: 'cron(0 8/12 * * ? *)',
      function: gracePeriodEnforcer.arn,
    });

    return {
      baseUrl: siteUrl,
    };
  },
});

// ── Single Lambda + log subscription ────────────────────────────
function createFunction(
  fnName: string,
  args: Omit<sst.aws.FunctionArgs, 'name'>,
  ctx: {
    firehose: aws.kinesis.FirehoseDeliveryStream;
    cwToFirehoseRole: aws.iam.Role;
  },
): sst.aws.Function {
  if ('name' in args) {
    throw new Error(`createFunction does not allow overriding 'name' (got fnName="${fnName}")`);
  }

  const fn = new sst.aws.Function(fnName, {
    name: $interpolate`filone-${$app.stage}-${fnName}`,
    ...args,
    logging: { retention: '1 week', format: 'json' },
  });

  // Use the LogGroup resource reference (not a plain string) to ensure
  // Pulumi creates the log group before the subscription filter.
  const logGroup = fn.nodes.logGroup.apply((lg) => {
    if (!lg) throw new Error(`LogGroup not created for function ${fnName}`);
    return lg;
  });

  new aws.cloudwatch.LogSubscriptionFilter(`${fnName}LogFwd`, {
    logGroup: logGroup.name,
    filterPattern: '',
    destinationArn: ctx.firehose.arn,
    roleArn: ctx.cwToFirehoseRole.arn,
  });

  return fn;
}

// ── Firehose Log Pipeline (CloudWatch → Loki) ───────────────────
function setupFirehoseLogPipeline(grafanaLokiAuth: sst.Secret) {
  const firehoseBackupBucket = new sst.aws.Bucket('OtelFirehoseBackup', {
    transform: {
      bucket: { forceDestroy: true },
    },
  });

  const firehoseLogGroup = new aws.cloudwatch.LogGroup('OtelFirehoseLogGroup', {
    retentionInDays: 7,
  });
  const firehoseLogStream = new aws.cloudwatch.LogStream('OtelFirehoseLogStream', {
    logGroupName: firehoseLogGroup.name,
  });

  const firehoseRole = new aws.iam.Role('OtelFirehoseRole', {
    assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          actions: ['sts:AssumeRole'],
          principals: [{ type: 'Service', identifiers: ['firehose.amazonaws.com'] }],
          conditions: [
            {
              test: 'StringEquals',
              variable: 'aws:SourceAccount',
              values: [aws.getCallerIdentityOutput({}).accountId],
            },
          ],
        },
      ],
    }).json,
    inlinePolicies: [
      {
        name: 'firehose-s3',
        policy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
              Resource: [firehoseBackupBucket.arn],
            },
            {
              Effect: 'Allow',
              Action: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'],
              Resource: [$interpolate`${firehoseBackupBucket.arn}/*`],
            },
            {
              Effect: 'Allow',
              Action: ['logs:PutLogEvents'],
              Resource: [$interpolate`${firehoseLogGroup.arn}:*`],
            },
          ],
        }),
      },
    ],
  });

  const firehose = new aws.kinesis.FirehoseDeliveryStream('OtelLogDelivery', {
    name: $interpolate`filone-${$app.stage}-OtelLogDelivery`,
    destination: 'http_endpoint',
    httpEndpointConfiguration: {
      url: 'https://aws-logs-prod3.grafana.net/aws-logs/api/v1/push',
      name: 'grafanacloud-filecoinfoundation-logs',
      accessKey: grafanaLokiAuth.value,
      bufferingInterval: 60,
      bufferingSize: 1,
      roleArn: firehoseRole.arn,
      cloudwatchLoggingOptions: {
        enabled: true,
        logGroupName: firehoseLogGroup.name,
        logStreamName: firehoseLogStream.name,
      },
      s3BackupMode: 'FailedDataOnly',
      s3Configuration: {
        bucketArn: firehoseBackupBucket.arn,
        roleArn: firehoseRole.arn,
      },
      requestConfiguration: {
        contentEncoding: 'GZIP',
        commonAttributes: [
          { name: 'lbl_environment', value: $app.stage },
          { name: 'lbl_service', value: $interpolate`filone-${$app.stage}` },
        ],
      },
    },
  });

  const cwToFirehoseRole = new aws.iam.Role('CwToFirehoseRole', {
    assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          actions: ['sts:AssumeRole'],
          principals: [{ type: 'Service', identifiers: ['logs.amazonaws.com'] }],
          conditions: [
            {
              test: 'StringEquals',
              variable: 'aws:SourceAccount',
              values: [aws.getCallerIdentityOutput({}).accountId],
            },
          ],
        },
      ],
    }).json,
    inlinePolicies: [
      {
        name: 'cw-to-firehose',
        policy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
              Resource: [firehose.arn],
            },
          ],
        }),
      },
    ],
  });

  return { firehose, cwToFirehoseRole };
}
