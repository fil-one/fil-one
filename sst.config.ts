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
    // ⚠️  All Lambda functions MUST be created via createFn() to ensure
    //     log forwarding is set up. Never use `new sst.aws.Function()` directly.

    // ── Secrets (set via: pnpx sst secret set <Name> <value>) ─────────
    const auth0ClientId = new sst.Secret('Auth0ClientId');
    const auth0ClientSecret = new sst.Secret('Auth0ClientSecret');
    const auth0MgmtClientId = new sst.Secret('Auth0MgmtClientId');
    const auth0MgmtClientSecret = new sst.Secret('Auth0MgmtClientSecret');
    const stripeSecretKey = new sst.Secret('StripeSecretKey');
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
    const isEphemeralStage = stage !== 'production' && stage !== 'staging';

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
        AUTH0_DOMAIN: 'dev-oar2nhqh58xf5pwf.us.auth0.com',
      },
      permissions: [
        {
          actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
          resources: [$interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/*`],
        },
      ],
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
      stripePriceId,
      auroraBackofficeToken,
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
      AURORA_PORTAL_URL: 'https://api.portal.dev.aur.lu/api',
      AURORA_PARTNER_ID: 'ff',
      AURORA_REGION_ID: 'ff',
    };

    const auroraS3GatewayUrl = 'https://s3.dev.aur.lu';

    const auroraApiKeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-portal/tenant-api-key/*`;
    const auroraS3KeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-s3/*`;

    const auroraS3GatewayEnv = {
      AURORA_S3_GATEWAY_URL: auroraS3GatewayUrl,
    };
    const auroraS3GatewayPermissions: sst.aws.FunctionPermissionArgs[] = [
      {
        actions: ['ssm:GetParameter'],
        resources: [auroraS3KeySsmArn],
      },
    ];

    const { firehose, cwToFirehoseRole } = setupFirehoseLogPipeline(grafanaLokiAuth);
    const createFn = (fnName: string, args: Omit<sst.aws.FunctionArgs, 'name'>) =>
      createFunction(fnName, args, { firehose, cwToFirehoseRole });

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

      const fn = createFn(fnName, {
        handler: `packages/backend/src/handlers/${handler}.handler`,
        link: allResources,
        environment: {
          ...sharedEnv,
          ...extraEnv,
        },
        permissions,
        timeout: '10 seconds',
      });

      api.route(`${method} ${routePath}`, fn.arn);

      // SST's api.route() with an ARN creates lambda.Permission with
      // qualifier: "" (from undefined), which doesn't actually grant
      // API Gateway invoke access. Add an explicit permission.
      new aws.lambda.Permission(`${fnName}ApiPermission`, {
        action: 'lambda:InvokeFunction',
        function: fn.nodes.function.name,
        principal: 'apigateway.amazonaws.com',
        sourceArn: $interpolate`${api.nodes.api.executionArn}/*`,
      });
    }

    // ── Data routes ──────────────────────────────────────────────────
    addRoute(
      'GET',
      '/api/buckets',
      'list-buckets',
      {
        AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL,
      },
      [
        {
          actions: ['ssm:GetParameter'],
          resources: [auroraApiKeySsmArn],
        },
      ],
    );
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
          resources: [auroraApiKeySsmArn],
        },
      ],
    );
    addRoute(
      'GET',
      '/api/buckets/{name}',
      'get-bucket',
      {
        AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL,
      },
      [
        {
          actions: ['ssm:GetParameter'],
          resources: [auroraApiKeySsmArn],
        },
      ],
    );
    addRoute(
      'DELETE',
      '/api/buckets/{name}',
      'delete-bucket',
      auroraS3GatewayEnv,
      auroraS3GatewayPermissions,
    );
    addRoute('GET', '/api/access-keys', 'list-access-keys');
    addRoute(
      'POST',
      '/api/access-keys',
      'create-access-key',
      {
        AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL,
      },
      [
        {
          actions: ['ssm:GetParameter'],
          resources: [auroraApiKeySsmArn],
        },
      ],
    );
    addRoute(
      'DELETE',
      '/api/access-keys/{keyId}',
      'delete-access-key',
      auroraS3GatewayEnv,
      auroraS3GatewayPermissions,
    );
    addRoute(
      'GET',
      '/api/buckets/{name}/objects',
      'list-objects',
      auroraS3GatewayEnv,
      auroraS3GatewayPermissions,
    );
    addRoute(
      'POST',
      '/api/buckets/{name}/objects/presign',
      'presign-upload',
      auroraS3GatewayEnv,
      auroraS3GatewayPermissions,
    );
    addRoute(
      'GET',
      '/api/buckets/{name}/objects/download',
      'download-object',
      auroraS3GatewayEnv,
      auroraS3GatewayPermissions,
    );
    addRoute(
      'DELETE',
      '/api/buckets/{name}/objects',
      'delete-object',
      auroraS3GatewayEnv,
      auroraS3GatewayPermissions,
    );

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

    // ── Usage + Dashboard routes ─────────────────────────────────────
    addRoute('GET', '/api/usage', 'get-usage', auroraEnv);
    addRoute(
      'GET',
      '/api/activity',
      'get-activity',
      { ...auroraEnv, ...auroraS3GatewayEnv },
      auroraS3GatewayPermissions,
    );

    // ── Billing routes ───────────────────────────────────────────────
    addRoute('GET', '/api/billing', 'get-billing');
    addRoute('POST', '/api/billing/setup-intent', 'create-setup-intent');
    addRoute('POST', '/api/billing/activate', 'activate-subscription', auroraEnv);
    addRoute('GET', '/api/billing/invoices', 'list-invoices');
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
    const usageWorker = createFn('UsageReportingWorker', {
      handler: 'packages/backend/src/jobs/usage-reporting-worker.handler',
      link: [billingTable, stripeSecretKey, stripePriceId, auroraBackofficeToken],
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
