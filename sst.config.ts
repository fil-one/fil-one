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

    const stage = $app.stage;
    const isProduction = stage === 'production';
    const isStaging = stage === 'staging';
    const isEphemeralStage = !isProduction && !isStaging;

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
    // The Stripe meter every storage report writes to: the usage cron, its
    // orchestrator, and the account teardown's final report before it cancels.
    const stripeMeterEventName = 'gb_month_meter';
    const auroraBackofficeToken = new sst.Secret('AuroraBackofficeToken');
    const fthManagementApiToken = new sst.Secret('FthManagementApiToken');
    // Forge tokens are linked on non-production stages only. Each Forge network
    // has its own Hilt, so each one we talk to carries its own token.
    const forgeManagementApiToken =
      isStaging || isEphemeralStage ? new sst.Secret('ForgeManagementApiToken') : undefined;
    const forgeDevManagementApiToken =
      isStaging || isEphemeralStage ? new sst.Secret('ForgeDevManagementApiToken') : undefined;
    const managementApiTokens = [
      auroraBackofficeToken,
      fthManagementApiToken,
      ...(forgeManagementApiToken ? [forgeManagementApiToken] : []),
      ...(forgeDevManagementApiToken ? [forgeDevManagementApiToken] : []),
    ];
    const grafanaLokiAuth = new sst.Secret('GrafanaLokiAuth');
    const hubSpotServiceKey = new sst.Secret('HubSpotServiceKey');
    // Keys the deletion-code HMAC, so a table dump alone cannot enumerate a
    // six-digit space offline.
    const deletionCodeHmacKey = new sst.Secret('DeletionCodeHmacKey');
    const sendGridApiKey = isStaging || isProduction ? new sst.Secret('SendGridApiKey') : undefined;
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

    // Organization membership and invitations: ORG#{orgId}/MEMBER#{userId},
    // its USER#{userId}/MEMBERSHIP#{orgId} inverse item, ORG#{orgId}/INVITE#{id}
    // and the INVITETOKEN#{hash}/LOOKUP row that resolves an accept link. Its
    // own table rather than more sort keys in UserInfoTable: membership is read
    // on every authenticated request and nothing needs it co-located with the
    // identity, entitlement, and RAG-key rows already sharing those partitions.
    const orgTable = new sst.aws.Dynamo('OrgTable', {
      fields: {
        pk: 'string',
        sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
      transform: {
        table: {
          // Membership is the authorization record, and nothing else holds it:
          // losing these rows locks every org out of itself and leaves no
          // source to rebuild who belonged where. Backups on the stages that
          // carry real accounts.
          //
          // Deletion protection only where the app already retains on removal.
          // Every preview stage is torn down with `sst remove`, and a protected
          // table refuses to go, leaving the teardown failing and the stage's
          // resources live.
          pointInTimeRecovery: { enabled: isProduction || isStaging },
          deletionProtectionEnabled: isProduction,
        },
      },
    });

    // Audit events: ORG#{orgId} / {iso8601}#{eventId}, so one Query per org
    // returns its history in the order it happened. Its own table because its
    // lifecycle is its own — the TTL that expires an event after 90 days
    // (packages/shared/src/audit.ts) must never be able to reach a membership,
    // profile, or billing row that happened to share a partition. Written only
    // through lib/audit.ts, which appends an event in the same transaction as
    // the mutation it records.
    // Routes reach it through the narrowed auditLog link below rather than
    // through the table itself, because the Dynamo component's own link grants
    // dynamodb:* and this is the one table where a handler holding DeleteItem
    // contradicts the append-only claim.
    const auditTable = new sst.aws.Dynamo('AuditTable', {
      fields: {
        pk: 'string',
        sk: 'string',
        // The event-type index: ORG#{orgId}#TYPE#{type} / {createdAt}#{eventId}.
        // Org-scoped partition key, so a type-filtered query can never read
        // across orgs, and the base sort key format, so it still gets its date
        // range from a BETWEEN rather than a scan.
        gsi1pk: 'string',
        gsi1sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
      // Projection defaults to ALL. The item is a few hundred bytes and the
      // point of the index is that one query answers the request; KEYS_ONLY
      // would turn every page into a batch of reads against the base table.
      globalIndexes: {
        byType: { hashKey: 'gsi1pk', rangeKey: 'gsi1sk' },
      },
      ttl: 'ttl',
      transform: {
        table: {
          // The two protections the record itself needs: a 90-day log with no
          // backups loses the quarter to one bad deploy, and a table a stack
          // operation can drop is a log an operator can make disappear.
          //
          // Deletion protection only where the app already retains on removal.
          // Every preview stage is torn down with `sst remove`, and a protected
          // table refuses to go, leaving the teardown failing and the stage's
          // resources live.
          pointInTimeRecovery: { enabled: isProduction || isStaging },
          deletionProtectionEnabled: isProduction,
        },
      },
    });

    // How everything reaches AuditTable: the table's name, and the two actions
    // an append-only log needs. Linking the Dynamo component directly would
    // grant dynamodb:* on the table and its index, DeleteItem and UpdateItem
    // included, which is the difference between an application that cannot
    // modify an audit entry and one that merely does not.
    //
    // TransactWriteItems needs the underlying PutItem on each item it writes,
    // so commitAudited works unchanged. No Scan: nothing reads this table
    // without naming an org.
    //
    // Two statements because DynamoDB splits along the same line. A query may
    // name the table or one of its indexes, so Query needs both ARNs; a write
    // may only ever name the table, and granting PutItem on an index ARN would
    // be a permission that can never match. The index is maintained by
    // DynamoDB itself as the write lands, under its own permissions rather than
    // the caller's.
    //
    // The one exception is the account deletion worker, which destroys an org's
    // partition and takes DeleteItem on top of this link.
    const auditLog = new sst.Linkable('AuditLog', {
      properties: { name: auditTable.name },
      include: [
        sst.aws.permission({
          actions: ['dynamodb:Query'],
          resources: [auditTable.arn, $interpolate`${auditTable.arn}/index/*`],
        }),
        sst.aws.permission({
          actions: ['dynamodb:PutItem'],
          resources: [auditTable.arn],
        }),
      ],
    });

    // RAG indexer's own store: per-object chunk manifests
    // (BUCKET#{orgId}#{region}#{bucket} / MANIFEST#{objectKey}) and resumable indexer
    // checkpoints (INDEXER_CHECKPOINT#{orgId}#{region}#{bucket} / CHECKPOINT). Kept out
    // of UserInfoTable so this high-churn, indexer-derived state doesn't mix with
    // user/org data. TTL attribute expires stale checkpoints (see
    // rag-indexer-manifest.ts).
    const ragIndexerTable = new sst.aws.Dynamo('RagIndexerTable', {
      fields: {
        pk: 'string',
        sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
      ttl: 'ttl',
    });

    // User-initiated bulk deletions (BULKDELETE#{orgId} / JOB#{jobId}). Kept
    // separate from UserInfoTable because a running job rewrites its row on
    // every listing page, and finished jobs expire on their own via TTL.
    const bulkDeleteTable = new sst.aws.Dynamo('BulkDeleteTable', {
      fields: {
        pk: 'string',
        sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
      ttl: 'ttl',
    });

    // Short-lived account-deletion codes. Its own table so TTL is not enabled
    // on UserInfoTable (a stray `ttl` there would hard-delete account data),
    // and so only the deletion routes are granted the credential.
    const deletionChallengeTable = new sst.aws.Dynamo('DeletionChallengeTable', {
      fields: { pk: 'string' },
      primaryIndex: { hashKey: 'pk' },
      ttl: 'ttl',
    });

    // ── S3 Bucket for user file storage ──────────────────────────────
    const userFilesBucket = new sst.aws.Bucket('UserFilesBucket');

    // ── S3 Vectors bucket for RAG embeddings (FIL-548) ───────────────
    // One vector bucket hosts one index per RAG-enabled bucket. The
    // @filone/rag-shared S3VectorsStore reads the bucket name at runtime via
    // Resource.RagVectorBucket.name.
    const ragVectorBucketName = `filone-${$app.stage}-rag-vectors`;
    if (ragVectorBucketName.length > 63) {
      throw new Error(
        `RagVectorBucket name too long (${ragVectorBucketName.length} chars): ${ragVectorBucketName}`,
      );
    }
    const ragVectorBucketResource = new aws.s3.VectorsVectorBucket('RagVectorBucket', {
      vectorBucketName: ragVectorBucketName,
      // Indexes are created at runtime by the RAG indexer (one opaque
      // rag-<hash> index per RAG-enabled bucket), so Pulumi has no knowledge of
      // them. Without forceDestroy, `sst remove` of a preview/staging stage
      // fails with a 409 ConflictException ("vector bucket is not empty") on
      // DeleteVectorBucket. forceDestroy makes the provider delete all indexes
      // and vectors first. Gated off production, which is removal:'retain' and
      // never torn down anyway.
      forceDestroy: !isProduction,
    });

    // Wrap the raw Pulumi resource so handlers can read it via SST resource
    // linking (Resource.RagVectorBucket.name).
    const ragVectorBucket = new sst.Linkable('RagVectorBucket', {
      properties: {
        name: ragVectorBucketResource.vectorBucketName,
        arn: ragVectorBucketResource.vectorBucketArn,
      },
    });

    // s3vectors:* scoped to the vector bucket and all of its indexes, plus
    // bedrock:InvokeModel for the Titan embeddings model (FIL-552). Granted only
    // to handlers that opt in via addRoute({ rag: true }) — i.e. those that use
    // @filone/rag-shared.
    const ragPermissions: sst.aws.FunctionPermissionArgs[] = [
      {
        actions: [
          's3vectors:CreateIndex',
          's3vectors:DeleteIndex',
          's3vectors:PutVectors',
          's3vectors:QueryVectors',
          's3vectors:GetVectors',
          's3vectors:DeleteVectors',
        ],
        resources: [
          ragVectorBucketResource.vectorBucketArn,
          $interpolate`${ragVectorBucketResource.vectorBucketArn}/index/*`,
        ],
      },
      {
        actions: ['bedrock:InvokeModel'],
        resources: [$interpolate`arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`],
      },
    ];

    // ── Stage-aware domain config ────────────────────────────────────
    // Ephemeral stages become subdomains of dev.fil.one — enforce DNS label rules.
    if (isEphemeralStage && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(stage)) {
      throw new Error(
        `Invalid stage name "${stage}": must be a valid DNS label ` +
          `(lowercase a-z, 0-9, hyphens; 1-63 chars; no leading/trailing hyphen).`,
      );
    }

    const {
      getAuth0Domain,
      getS3Endpoint,
      PROD_CONSOLE_ALIAS_HOSTS,
      PROD_CONSOLE_HOST,
      S3Region,
      Stage,
      SUPPORTED_COMPLETION_MODELS,
    } = await import('@filone/shared');

    const domainName = isProduction
      ? PROD_CONSOLE_HOST
      : isStaging
        ? 'staging.fil.one'
        : `${stage}.dev.fil.one`;

    // Extra hostnames the production console answers on: unlisted demo aliases on
    // a domain with clean reputation, for when fil.one is blocklisted. They are
    // alternate domain names on this same distribution, not another deployment.
    const aliasHosts = isProduction ? [...PROD_CONSOLE_ALIAS_HOSTS] : [];

    // ACM cert must be in us-east-1 for CloudFront. Ephemeral stages share a
    // wildcard cert for *.dev.fil.one provisioned in the fil-one/infrastructure repo.
    //
    // In production the cert is looked up by its alias name rather than by
    // domainName: CloudFront allows one viewer certificate per distribution, so a
    // single cert has to carry every alias, and the one provisioned for this
    // purpose deliberately uses the first alias host as its primary domain so the
    // lookup cannot also match the older app.fil.one-only cert it supersedes.
    // See environments/prod/filone-ai.tf in fil-one/infrastructure.
    const certDomain = isEphemeralStage
      ? '*.dev.fil.one'
      : isProduction
        ? PROD_CONSOLE_ALIAS_HOSTS[0]
        : domainName;
    const usEast1 = new aws.Provider('useast1', { region: 'us-east-1' });
    const cert = await aws.acm.getCertificate(
      {
        domain: certDomain,
        statuses: ['ISSUED'],
        // The lookup errors if more than one ISSUED cert matches. That happens
        // transiently whenever a cert is replaced rather than mutated in place,
        // since both carry the same primary domain until the old one is retired.
        // Picking the newest is right: the older one is the one going away.
        mostRecent: true,
      },
      { provider: usEast1 },
    );
    const certArn = cert.arn;

    // ── API Gateway ──────────────────────────────────────────────────
    // While we stick to a same origin for both website and API,
    // we want to make sure to lock down to just our origin.
    const allowedOrigins = [`https://${domainName}`, ...aliasHosts.map((h) => `https://${h}`)];
    if (stage !== 'production') {
      allowedOrigins.push('https://localhost:5173');
    }

    const api = new sst.aws.ApiGatewayV2('Api', {
      accessLog: { retention: '1 week' },
      cors: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        // Authorization carries RAG API key bearer tokens (query endpoint);
        // X-Org-Id names the organization each request operates on. Deployed
        // stages serve the console and the API from one origin through the
        // Router, so CORS never applies there — local dev at
        // https://localhost:5173 is cross-origin, and a preflight that omitted
        // X-Org-Id would strip the header before it reached the API. Origins
        // stay locked to our own domain above.
        allowHeaders: [
          'Content-Type',
          'X-CSRF-Token',
          'X-Requested-With',
          'Authorization',
          'X-Org-Id',
        ],
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

    const stageForEndpoints = isProduction ? Stage.Production : Stage.Staging;
    // The browser hits every region's S3 endpoint directly, and CSP is one static
    // header that can't vary per user — so `connect-src` must list them all.
    const s3GatewayUrls = Object.values(S3Region)
      .map((r) => getS3Endpoint(r, stageForEndpoints))
      .join(' ');

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
            contentSecurityPolicy: $interpolate`default-src 'none'; script-src 'self' https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' blob: https://lh3.googleusercontent.com https://s.gravatar.com https://cdn.auth0.com https://i1.wp.com https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self' https://api.stripe.com https://api.hsforms.com https://o4507369657991168.ingest.us.sentry.io https://plausible.io https://status.fil.one ${s3GatewayUrls}; frame-src https://js.stripe.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; report-uri ${sentryCspEndpoint}; report-to csp-endpoint`,
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

    // SPA fallback belongs to the website origin, so it is attached to the
    // default S3 behavior below and nowhere else. Distribution-level error
    // mapping cannot tell the bucket origin from the API origin, which is why
    // API 403s used to reach the browser with an HTML body. The function fails
    // closed for anything that is not a document navigation; the rationale is in
    // docs/architectural-decisions/2026-08-cloudfront-spa-fallback.md.
    //
    // The source is read verbatim at synth time so the deployed bytes are the
    // ones packages/cloudfront-functions tests. It is resolved against the
    // working directory rather than import.meta.url because SST bundles this
    // config into .sst/platform before running it, the same reason distPath
    // below uses path.resolve.
    const spaRewriteCode = require('fs').readFileSync(
      require('path').resolve('packages/cloudfront-functions/src/spa-rewrite.js'),
      'utf8',
    ) as string;
    const spaRewriteFunction = new aws.cloudfront.Function('WebsiteSpaRewrite', {
      comment: 'Rewrite website document navigations to /index.html',
      runtime: 'cloudfront-js-2.0',
      code: spaRewriteCode,
      publish: true,
    });

    const router = new sst.aws.Router('WebsiteRouter', {
      routes: {
        '/*': { bucket: websiteBucket },
        // CachingDisabled means every /api/* request reaches the origin, so
        // X-Org-Id needs no place in a cache key. Any future cache policy on
        // this route must add the header to its key: two orgs' responses to the
        // same path differ by nothing else, and a shared entry would serve one
        // org's data to the other.
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
      domain: {
        name: domainName,
        // Demo aliases keep visitors on the alias hostname (unlike `redirects`,
        // which would bounce them back to the blocklisted canonical host). The
        // cert above must cover every entry or CloudFront rejects the deploy.
        aliases: aliasHosts,
        // Ephemeral stages: SST creates the Route 53 alias in the delegated
        // dev.fil.one zone. Staging/prod: records are managed in Cloudflare
        // by the fil-one/infrastructure Terraform.
        dns: isEphemeralStage ? sst.aws.dns({ override: true }) : false,
        cert: certArn,
      },
      transform: {
        cdn: (args) => {
          // Also covered by the SPA rewrite function, which maps `/` to
          // /index.html as well. Keep both: defaultRootObject is what serves
          // the root if the function association is ever removed.
          args.defaultRootObject = 'index.html';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pulumi Input wrapper; value is a plain object at transform time
          const defaultBehavior = args.defaultCacheBehavior as any;
          defaultBehavior.responseHeadersPolicyId = responseHeadersPolicy.id;
          defaultBehavior.functionAssociations = [
            {
              eventType: 'viewer-request',
              functionArn: spaRewriteFunction.arn,
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
              // Derived from aliasHosts rather than allowedOrigins: the latter
              // also carries https://localhost:5173 outside production, which
              // must never be written into the shared Auth0 tenant.
              SiteAliasUrls: aliasHosts.map((h) => `https://${h}`).join(','),
              Stage: $app.stage,
              // Bumped for the SiteAliasUrls property: this custom resource only
              // re-runs when a property changes, and SiteUrl is unchanged, so
              // without a bump the alias never reaches the Auth0 client.
              Version: '2.12',
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
      bulkDeleteTable,
      orgTable,
      auditLog,
      userFilesBucket,
      ragVectorBucket,
      auth0ClientId,
      auth0ClientSecret,
      stripeSecretKey,
      stripePublishableKey,
      stripePriceId,
      ...managementApiTokens,
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
        : 'https://api-backoffice.dev.aur.lu/api',
      AURORA_PORTAL_URL: isProduction
        ? 'https://api-portal.aur.lu/api'
        : 'https://api-portal.dev.aur.lu/api',
      AURORA_PARTNER_ID: 'ff',
      AURORA_REGION_ID: 'ff',
    };

    const fthEnv = {
      FTH_MANAGEMENT_API_URL: 'https://api.fortilyx.com',
    };

    // Forge (Management-API) — non-prod only. One endpoint per Forge network,
    // serving every region in it; the region is sent per-tenant in the PUT
    // /tenants body.
    const forgeEnv = {
      FORGE_MANAGEMENT_API_URL: isProduction ? '' : 'https://auth.staging.fil-forge.com',
      FORGE_DEV_MANAGEMENT_API_URL: isProduction ? '' : 'https://auth.latest.dev.fil-forge.com',
    };

    // Everything the service-orchestrator layer needs at runtime. FILONE_STAGE
    // drives region/orchestrator selection, and instantiating the orchestrator
    // registry eagerly loads both the Aurora and FTH clients, so each backend's
    // endpoint config must be present. FILONE_STAGE is intentionally also in
    // sharedEnv (the partial-bundle route handlers read it); it's repeated here
    // so cron jobs, which bypass sharedEnv, receive it too.
    const orchestratorEnv = { FILONE_STAGE: $app.stage, ...auroraEnv, ...fthEnv, ...forgeEnv };

    const auroraApiKeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-portal/tenant-api-key/*`;
    const auroraS3KeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/aurora-s3/*`;
    const fthS3KeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/fth-s3/*`;
    const forgeS3KeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/forge-s3/*`;
    const forgeDevS3KeySsmArn = $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/forgeDev-s3/*`;
    const orchestratorS3KeySsmArns = [
      auroraS3KeySsmArn,
      fthS3KeySsmArn,
      forgeS3KeySsmArn,
      forgeDevS3KeySsmArn,
    ];
    // Per-tenant console S3 access keys (getConsoleS3Credentials), needed by
    // handlers that talk to the S3 data plane directly (presign, indexing, …).
    const s3DataPlanePermissions: sst.aws.FunctionPermissionArgs[] = [
      {
        actions: ['ssm:GetParameter'],
        resources: orchestratorS3KeySsmArns,
      },
    ];
    // Per-tenant credentials for the bucket read path (getBucket/listBuckets):
    // Aurora resolves its portal API key from SSM, FTH its console S3 key.
    const bucketReadPermissions: sst.aws.FunctionPermissionArgs[] = [
      {
        actions: ['ssm:GetParameter'],
        resources: [auroraApiKeySsmArn, fthS3KeySsmArn, forgeS3KeySsmArn, forgeDevS3KeySsmArn],
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
      extraLink?: ((typeof allResources)[number] | sst.aws.Function | sst.aws.Queue)[];
      provisionedConcurrency?: number;
      memory?: sst.aws.FunctionArgs['memory'];
      timeout?: sst.aws.FunctionArgs['timeout'];
      /**
       * Grant s3vectors:* (scoped to the RAG vector bucket + indexes) and
       * bedrock:InvokeModel for handlers that use @filone/rag-shared.
       */
      rag?: boolean;
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
      timeout,
      rag,
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
        permissions: rag ? [...(permissions ?? []), ...ragPermissions] : permissions,
        timeout: timeout ?? '10 seconds',
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

    // ── Bulk object deletion (API → FIFO queue → worker, resumed via SQS) ──
    // Empties a bucket, or a prefix within one, by walking the listing and
    // deleting page by page. A bucket can hold far more objects than one
    // invocation can process, so the worker checkpoints its listing cursor and
    // queues itself a continuation message; it needs the full Lambda timeout.
    // DeleteBucket requires an empty bucket, so this is the step that makes
    // deleting a non-trivial bucket possible at all. See
    // docs/architectural-decisions/2026-08-server-side-bulk-object-deletion.md.
    // Messages that fail every delivery land in the DLQ rather than
    // disappearing, so a stalled deletion is visible instead of being inferred
    // from a job row that stopped moving.
    const bulkDeleteDlq = new sst.aws.Queue('BulkDeleteDlq', { fifo: true });

    // FIFO so the message group (the job id) admits one in-flight message per
    // job: a redelivery can never run alongside the invocation it is replacing
    // and corrupt the shared cursor. Content-based deduplication stays off
    // because a job's continuation messages are byte-identical; the worker
    // supplies its own ids. See packages/backend/src/lib/bulk-delete-queue.ts.
    const bulkDeleteQueue = new sst.aws.Queue('BulkDeleteQueue', {
      fifo: true,
      // Must outlast the worker's own timeout, or SQS would redeliver a message
      // to a second worker while the first is still deleting.
      visibilityTimeout: '16 minutes',
      // Matches MAX_BULK_DELETE_DELIVERY_ATTEMPTS in bulk-delete-queue.ts: the
      // worker uses that number to tell a retry from the final attempt.
      dlq: { queue: bulkDeleteDlq.arn, retry: 3 },
    });

    const bulkDeleteWorker = createFn('BulkDeleteWorker', {
      handler: 'packages/backend/src/jobs/bulk-delete-worker.handler',
      // Linking the queue covers both directions: consuming its messages and
      // enqueueing the continuation for a job too large for one invocation.
      link: [bulkDeleteTable, userInfoTable, bulkDeleteQueue, ...managementApiTokens],
      environment: orchestratorEnv,
      timeout: '900 seconds',
      memory: '512 MB',
      permissions: s3DataPlanePermissions,
    });
    // Subscribed by ARN so the worker keeps the logging and defaults createFn
    // applies. One message at a time: a job owns the whole invocation's time
    // budget, and a partial batch failure would replay siblings needlessly.
    bulkDeleteQueue.subscribe(bulkDeleteWorker.arn, { batch: { size: 1 } });

    // A message only reaches the DLQ once the worker's own retries are spent.
    // The worker fails the job itself before its last delivery rethrows, but
    // that path never runs on a hard kill (Lambda timeout, OOM, process
    // termination) — the job row is left non-terminal with nothing left to move
    // it, and the client would poll it forever. This watchdog closes that gap:
    // any job whose message lands here without a terminal status gets failed.
    const bulkDeleteDlqWatchdog = createFn('BulkDeleteDlqWatchdog', {
      handler: 'packages/backend/src/jobs/bulk-delete-dlq-watchdog.handler',
      link: [bulkDeleteTable],
      timeout: '30 seconds',
      // Subscribed by ARN, so SST does not manage the role: the consume actions
      // the SQS event source mapping needs must be granted explicitly.
      permissions: [
        {
          actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
          resources: [bulkDeleteDlq.arn],
        },
      ],
    });
    bulkDeleteDlq.subscribe(bulkDeleteDlqWatchdog.arn);

    // Where a login round trip or a Stripe return may send the browser back to.
    const allowedRedirectOrigins = allowedOrigins.join(',');

    // ── Account deletion ─────────────────────────────────────────────
    // Off on every stage until FIL-919 gives Aurora a tenant DELETE. Gates the
    // self-serve routes only — the customer.deleted trigger stays live. Keep in
    // step with packages/website/src/lib/account-deletion.ts.
    const accountDeletionEnabled = 'false';

    // Catches payloads that exhaust Lambda's async retries. The sweeper
    // re-drives independently off the DELETION record, so this is for triage
    // rather than recovery.
    const accountDeletionDlq = new sst.aws.Queue('AccountDeletionDlq');

    const accountDeletionWorker = createFn('AccountDeletionWorker', {
      handler: 'packages/backend/src/jobs/account-deletion-worker.handler',
      link: [
        billingTable,
        userInfoTable,
        ragIndexerTable,
        ragVectorBucket,
        auditLog,
        stripeSecretKey,
        stripePriceId,
        orgTable,
        ...managementApiTokens,
        ...mgmtRuntimeResources,
      ],
      environment: {
        ...orchestratorEnv,
        AUTH0_MGMT_DOMAIN: auth0MgmtDomain,
        // The teardown reports the outstanding period before it cancels.
        STRIPE_METER_EVENT_NAME: stripeMeterEventName,
      },
      // The scrub pages whole partitions; a pass that runs out of time resumes
      // against a smaller one next time.
      timeout: '900 seconds',
      memory: '1024 MB',
      permissions: [
        ...ragPermissions,
        { actions: ['sqs:SendMessage'], resources: [accountDeletionDlq.arn] },
        // The one credential in the system that may remove an audit entry. The
        // auditLog link above deliberately withholds this from every route, and
        // the teardown is the one place where deleting is the point: an org
        // that asked to be erased must not leave a record of who belonged to it
        // and what they did.
        { actions: ['dynamodb:DeleteItem'], resources: [auditTable.arn] },
      ],
    });

    new aws.lambda.FunctionEventInvokeConfig('AccountDeletionWorkerInvokeConfig', {
      functionName: accountDeletionWorker.name,
      destinationConfig: {
        onFailure: { destination: accountDeletionDlq.arn },
      },
    });

    // The other half of the invoke's at-most-once delivery: a confirm whose
    // invoke never landed, a worker that exhausted its retries, and a pass
    // killed mid-purge all converge on the record and get re-driven here.
    const accountDeletionSweeper = createFn('AccountDeletionSweeper', {
      handler: 'packages/backend/src/jobs/account-deletion-sweeper.handler',
      link: [userInfoTable],
      environment: {
        ACCOUNT_DELETION_WORKER_FUNCTION_NAME: accountDeletionWorker.name,
      },
      timeout: '300 seconds',
      memory: '256 MB',
      permissions: [{ actions: ['lambda:InvokeFunction'], resources: [accountDeletionWorker.arn] }],
    });

    new sst.aws.CronV2('AccountDeletionSweepCron', {
      schedule: 'rate(15 minutes)',
      function: accountDeletionSweeper.arn,
    });

    // ── Routes ───────────────────────────────────────────────────────
    // The manifest is the route list: every entry becomes a Lambda and an API
    // Gateway route below, so a handler cannot reach the internet without a
    // manifest entry declaring what it requires of the caller.
    //
    // Straight from the manifest module rather than the package barrel, whose
    // other exports pull zod into the config bundle behind them.
    const { ROUTE_MANIFEST } = await import('./packages/shared/src/route-manifest.js');

    type RouteInfraConfig = Omit<AddRouteProps, 'method' | 'routePath' | 'handler'>;

    // The manifest's handler names, as a union. A type-only import, so it is
    // erased and the value import above stays the only thing in the bundle.
    type RouteHandler = import('./packages/shared/src/route-manifest.js').RouteHandler;

    // What a route needs beyond the defaults. A handler absent from this record
    // gets them: everything in allResources linked, the shared environment, a
    // 10-second timeout, no extra IAM. That is the whole configuration of a
    // DynamoDB-only route, which most of the account and key routes are.
    //
    // Keys are compile-checked against the manifest, so a key naming no route
    // fails the build rather than silently dropping that route's IAM grants and
    // environment. Partial because the map lists only the routes that need
    // something beyond the defaults.
    //
    // Declared here rather than beside each route because the entries reference
    // the queues, tables and workers above, all of which have to exist first.
    const ROUTE_INFRA_CONFIGS: Partial<Record<RouteHandler, RouteInfraConfig>> = {
      // ── Buckets and objects ────────────────────────────────────────
      'list-buckets': {
        extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL, ...fthEnv, ...forgeEnv },
        permissions: bucketReadPermissions,
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
        memory: '1024 MB',
      },
      'create-bucket': {
        extraEnv: orchestratorEnv,
        permissions: [
          {
            actions: ['ssm:GetParameter', 'ssm:PutParameter'],
            resources: [auroraApiKeySsmArn, ...orchestratorS3KeySsmArns],
          },
        ],
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
        timeout: '30 seconds',
      },
      'get-bucket': {
        extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL, ...fthEnv, ...forgeEnv },
        permissions: bucketReadPermissions,
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
        memory: '1024 MB',
      },
      'delete-bucket': {
        // Same credentials as create-bucket, minus ssm:PutParameter — deleting never
        // mints a key. Aurora deletes through the portal (tenant API key from SSM),
        // FTH/Forge through the S3 data plane (console S3 key).
        extraEnv: orchestratorEnv,
        permissions: [
          {
            actions: ['ssm:GetParameter'],
            resources: [auroraApiKeySsmArn, ...orchestratorS3KeySsmArns],
          },
        ],
      },
      'create-bulk-delete-job': {
        extraEnv: { ...fthEnv, ...forgeEnv },
        // Linking the queue grants the send; the handler only enqueues the job.
        extraLink: [bulkDeleteQueue],
      },
      presign: {
        extraEnv: { ...fthEnv, ...forgeEnv },
        permissions: s3DataPlanePermissions,
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
        memory: '512 MB',
      },
      'get-bucket-analytics': {
        permissions: bucketReadPermissions,
        extraEnv: orchestratorEnv,
      },

      // ── Keys ───────────────────────────────────────────────────────
      // The RAG API key routes take no entry: they are named bearer tokens
      // scoped to the RAG query endpoint (distinct from S3 access keys), and
      // their handlers touch nothing but UserInfoTable, which allResources
      // already links.
      'list-access-keys': {
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      },
      'create-access-key': {
        extraEnv: orchestratorEnv,
        permissions: [
          {
            actions: ['ssm:GetParameter', 'ssm:PutParameter'],
            resources: [auroraApiKeySsmArn, ...orchestratorS3KeySsmArns],
          },
        ],
        timeout: '30 seconds',
      },
      'delete-access-key': {
        extraEnv: { AURORA_PORTAL_URL: auroraEnv.AURORA_PORTAL_URL, ...fthEnv, ...forgeEnv },
        permissions: [
          {
            actions: ['ssm:GetParameter'],
            resources: [auroraApiKeySsmArn],
          },
        ],
      },

      // ── Members ────────────────────────────────────────────────────
      // A narrowing revokes the keys the member could no longer mint, in
      // whichever regions hold them, and emails the member that their client
      // just stopped working. So this route reaches every orchestrator and the
      // mail credential. Removal and ownership transfer revoke as well, and take
      // the same grants in the PR that gives them that.
      //
      // Thirty seconds rather than the ten `addRoute` defaults to: a narrowing
      // reads the org's key rows and revokes each key the new role could not
      // mint in turn, and each revocation is a vendor call plus an audit write.
      // A tenant may hold up to 300 keys, so this is a bound for ordinary orgs
      // rather than for every org; a member holding hundreds needs a worker,
      // which is FIL-1017 follow-up work. A timeout during the pass is safe by
      // design — the role is unwritten and the retry finds fewer keys.
      'update-member-role': {
        extraEnv: orchestratorEnv,
        permissions: [{ actions: ['ssm:GetParameter'], resources: [auroraApiKeySsmArn] }],
        ...(sendGridApiKey ? { extraLink: [sendGridApiKey] } : {}),
        timeout: '30 seconds',
      },

      // ── RAG ────────────────────────────────────────────────────────
      // RAG query playground (FIL-554): embed the question, vector-search the
      // bucket's index, and ground a Bedrock completion on the retrieved chunks.
      // `rag: true` grants s3vectors:QueryVectors + bedrock:InvokeModel on the
      // Titan embeddings model; the extra permission below covers the Claude
      // completion model — both its cross-region inference profile and the
      // underlying foundation model. Higher timeout/memory for the Bedrock calls.
      'query-bucket': {
        rag: true,
        // Reads the bucket's enablement row to reject queries before the first
        // indexing pass completes (BUCKET_NOT_INDEXED).
        extraLink: [ragIndexerTable],
        extraEnv: orchestratorEnv,
        permissions: [
          ...bucketReadPermissions,
          {
            actions: ['bedrock:InvokeModel'],
            // Built from the shared allowlist so the grant and QueryBucketSchema's
            // accepted `model` ids stay in sync — a model added there is invokable here.
            resources: SUPPORTED_COMPLETION_MODELS.flatMap((m) => [
              m.inferenceProfileArn,
              m.foundationModelArn,
            ]),
          },
        ],
        timeout: '30 seconds',
        memory: '512 MB',
      },
      // RAG per-bucket enablement (FIL-555): read/write the BUCKET#{name}/RAG
      // enablement row + sync telemetry for the caller's tenant. Both are gated by
      // auth + subscriptionGuard + ragAccessMiddleware. The enablement row lives in
      // ragIndexerTable (extraLink below); they also read UserInfoTable (already
      // linked via allResources) for tenant/org profile, and resolve tenant
      // ownership via the orchestrator (SSM-backed S3 keys), so they need the SSM
      // read grant but not `rag: true` (no s3vectors/bedrock).
      'get-bucket-rag-enablement': {
        extraEnv: orchestratorEnv,
        extraLink: [ragIndexerTable],
        permissions: bucketReadPermissions,
      },
      'set-bucket-rag-enablement': {
        extraEnv: orchestratorEnv,
        extraLink: [ragIndexerTable],
        permissions: bucketReadPermissions,
      },

      // ── Auth ───────────────────────────────────────────────────────
      'auth-login': {
        extraEnv: { WEBSITE_URL: siteUrl, ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins },
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      },
      'auth-callback': {
        extraEnv: { WEBSITE_URL: siteUrl, ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins },
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      },
      'auth-logout': {
        extraEnv: { WEBSITE_URL: siteUrl, ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins },
      },

      // ── Account and MFA ────────────────────────────────────────────
      'get-me': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      },
      'update-profile': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },
      'get-preferences': {
        extraLink: [hubSpotServiceKey],
      },
      'update-preferences': {
        extraLink: [hubSpotServiceKey],
      },
      'resend-verification': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },
      'enroll-mfa': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },
      'disable-mfa': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },
      'delete-mfa-enrollment': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },
      'regenerate-recovery-code': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },
      'delete-passkey': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },

      // ── Organization ───────────────────────────────────────────────
      // Ownership transfer reads the caller's MFA enrollments to decide whether a
      // fresh sign-in is enough of a step-up, so it needs the Management API
      // credentials the account routes already carry.
      'transfer-ownership': {
        extraLink: mgmtRuntimeResources,
        extraEnv: { AUTH0_MGMT_DOMAIN: auth0MgmtDomain },
      },

      // ── Invitations ────────────────────────────────────────────────
      // The only route that sends mail. `SendGridApiKey` exists on staging and
      // production alone; every other stage sends no email and logs the invitation
      // by id, never the accept URL, because the URL carries the token.
      // `WEBSITE_URL` is the accept link's origin, taken from configuration rather
      // than from the request, since the link goes to somebody else's inbox.
      'create-invitation': {
        extraEnv: { WEBSITE_URL: siteUrl },
        ...(sendGridApiKey ? { extraLink: [sendGridApiKey] } : {}),
      },

      // ── Usage and dashboard ────────────────────────────────────────
      'get-usage': {
        extraEnv: orchestratorEnv,
        permissions: s3DataPlanePermissions,
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      },
      'get-usage-trends': {
        extraEnv: orchestratorEnv,
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      },
      'get-activity': {
        extraEnv: orchestratorEnv,
        permissions: bucketReadPermissions,
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
        memory: '1024 MB',
      },

      // ── Billing ────────────────────────────────────────────────────
      'get-billing': {
        provisionedConcurrency: criticalPathLambdaProvisionedConcurrency,
      },
      'activate-subscription': {
        extraEnv: orchestratorEnv,
      },
      'create-portal-session': {
        // ALLOWED_REDIRECT_ORIGINS so the Stripe return_url can follow the alias
        // the user is on; resolveOrigin falls back to WEBSITE_URL without it.
        extraEnv: { WEBSITE_URL: siteUrl, ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins },
      },

      // ── Account deletion and webhooks ──────────────────────────────
      'request-account-deletion': {
        extraLink: [
          deletionChallengeTable,
          deletionCodeHmacKey,
          ...(sendGridApiKey ? [sendGridApiKey] : []),
        ],
        extraEnv: { ACCOUNT_DELETION_ENABLED: accountDeletionEnabled },
      },
      'confirm-account-deletion': {
        // The org-name read, salt read and step-up enrollment lookup do not fit the
        // 10s default.
        timeout: '30 seconds',
        extraLink: [deletionChallengeTable, deletionCodeHmacKey, ...mgmtRuntimeResources],
        extraEnv: {
          AUTH0_MGMT_DOMAIN: auth0MgmtDomain,
          ACCOUNT_DELETION_ENABLED: accountDeletionEnabled,
          ACCOUNT_DELETION_WORKER_FUNCTION_NAME: accountDeletionWorker.name,
        },
        permissions: [
          { actions: ['lambda:InvokeFunction'], resources: [accountDeletionWorker.arn] },
        ],
      },
      'stripe-webhook': {
        extraEnv: {
          ...orchestratorEnv,
          STRIPE_WEBHOOK_SECRET_SSM_PATH: $interpolate`/filone/${$app.stage}/stripe-webhook-secret`,
          ACCOUNT_DELETION_WORKER_FUNCTION_NAME: accountDeletionWorker.name,
        },
        permissions: [
          {
            actions: ['ssm:GetParameter'],
            resources: [
              $interpolate`arn:aws:ssm:*:*:parameter/filone/${$app.stage}/stripe-webhook-secret`,
            ],
          },
          { actions: ['lambda:InvokeFunction'], resources: [accountDeletionWorker.arn] },
        ],
      },
    };

    for (const route of ROUTE_MANIFEST) {
      addRoute({
        method: route.method,
        routePath: route.path,
        handler: route.handler,
        ...ROUTE_INFRA_CONFIGS[route.handler],
      });
    }

    // ── Usage reporting (cron-based) ────────────────────────────────
    const usageWorker = createFn('UsageReportingWorker', {
      handler: 'packages/backend/src/jobs/usage-reporting-worker.handler',
      link: [billingTable, userInfoTable, stripeSecretKey, stripePriceId, ...managementApiTokens],
      environment: {
        ...orchestratorEnv,
        STRIPE_METER_EVENT_NAME: stripeMeterEventName,
        ACCOUNT_DELETION_WORKER_FUNCTION_NAME: accountDeletionWorker.name,
      },
      timeout: '60 seconds',
      memory: '256 MB',
      // The deleted-customer audit starts a teardown for a customer.deleted event
      // that was never delivered.
      permissions: [{ actions: ['lambda:InvokeFunction'], resources: [accountDeletionWorker.arn] }],
    });

    const usageOrchestrator = createFn('UsageReportingOrchestrator', {
      handler: 'packages/backend/src/jobs/usage-reporting-orchestrator.handler',
      link: [billingTable, userInfoTable],
      environment: {
        USAGE_WORKER_FUNCTION_NAME: usageWorker.name,
        STRIPE_METER_EVENT_NAME: stripeMeterEventName,
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
      link: [billingTable, userInfoTable, ...managementApiTokens],
      environment: orchestratorEnv,
      timeout: '300 seconds',
      memory: '256 MB',
    });

    new sst.aws.CronV2('GracePeriodEnforcerCron', {
      // run the Lambda every 12 hours, one hour after usage reporting (08:00 and 20:00 UTC).
      schedule: 'cron(0 8/12 * * ? *)',
      function: gracePeriodEnforcer.arn,
    });

    // ── RAG indexer (cron → orchestrator → per-org worker) ──────────
    // Keeps each RAG-enabled bucket's vector index in sync with S3 contents via
    // object-level ETag diffing. The worker reads per-tenant S3 keys (SSM +
    // KMS) and uses @filone/rag-shared to extract/chunk/embed/upsert, so it
    // gets the RAG permission set plus a large timeout/memory budget; large
    // buckets are resumed across runs via a persisted continuation checkpoint.
    const ragIndexerWorker = createFn('RagIndexerWorker', {
      handler: 'packages/backend/src/jobs/rag-indexer-worker.handler',
      link: [billingTable, userInfoTable, ragIndexerTable, ragVectorBucket, ...managementApiTokens],
      environment: orchestratorEnv,
      timeout: '900 seconds',
      // 1024 MB: PDF text extraction runs in-process (pdf.js), which is
      // CPU- and heap-hungry on large documents.
      memory: '1024 MB',
      permissions: [...s3DataPlanePermissions, ...ragPermissions],
    });

    const ragIndexerOrchestrator = createFn('RagIndexerOrchestrator', {
      handler: 'packages/backend/src/jobs/rag-indexer-orchestrator.handler',
      // Scans the enablement rows, now in ragIndexerTable (its only table dependency).
      link: [ragIndexerTable],
      environment: {
        RAG_INDEXER_WORKER_FUNCTION_NAME: ragIndexerWorker.name,
      },
      timeout: '60 seconds',
      memory: '256 MB',
      permissions: [
        {
          actions: ['lambda:InvokeFunction'],
          resources: [ragIndexerWorker.arn],
        },
      ],
    });

    new sst.aws.CronV2('RagIndexerCron', {
      // Run every 6 hours (03:00, 09:00, 15:00, 21:00 UTC). Deliberately offset
      // from the usage-reporting (07/19) and grace-period (08/20) crons so the
      // indexer never collides with billing reconciliation.
      schedule: 'cron(0 3/6 * * ? *)',
      function: ragIndexerOrchestrator.arn,
    });

    // ── Subscription drift checker (cron-based, observe-only) ───────
    const subscriptionDriftChecker = createFn('SubscriptionDriftChecker', {
      handler: 'packages/backend/src/jobs/subscription-drift-checker.handler',
      link: [billingTable, userInfoTable, ...managementApiTokens],
      environment: orchestratorEnv,
      timeout: '300 seconds',
      memory: '256 MB',
    });

    new sst.aws.CronV2('SubscriptionDriftCheckerCron', {
      // run the Lambda every 12 hours, staggered 2h after grace-period (10:00 and 22:00 UTC).
      schedule: 'cron(0 10/12 * * ? *)',
      function: subscriptionDriftChecker.arn,
    });

    // ── HubSpot contact sync (cron-based, repairs as it observes) ───
    // Backfills contacts predating the sync, repairs dropped best-effort
    // webhook writes, and counts contacts HubSpot cannot match at all.
    const hubSpotContactSync = createFn('HubSpotContactSync', {
      handler: 'packages/backend/src/jobs/hubspot-contact-sync.handler',
      // The addresses it bootstraps contacts on come off UserInfoTable's PROFILE
      // rows; Stripe is no longer read, so its secrets are no longer linked.
      link: [billingTable, userInfoTable, hubSpotServiceKey],
      timeout: '300 seconds',
      memory: '256 MB',
    });

    new sst.aws.CronV2('HubSpotContactSyncCron', {
      // Hourly at :30 — offset from the other BillingTable scanners (usage
      // 07/19, grace 08/20, drift 10/22, all on the hour) so the full-table
      // Scans do not overlap. `rate(1 hour)` would fire at whatever offset the
      // deploy landed on and collide with them. This 1h period is the worst-case
      // propagation lag for ops on the HubSpot property; each run reconciles at
      // most MAX_CONTACTS_PER_RUN rows, so the frequency is also what sets how
      // fast a backfill backlog drains.
      schedule: 'cron(30 * * * ? *)',
      function: hubSpotContactSync.arn,
    });

    // ── Owner-count drift checker (cron-based, repairs the counter) ──
    // The last-Owner invariant is a counter, and a counter with no
    // reconciliation path eventually lies: this recounts each org's Owners from
    // the membership rows and repairs a META row that disagrees.
    const ownerCountDriftChecker = createFn('OwnerCountDriftChecker', {
      handler: 'packages/backend/src/jobs/owner-count-drift-checker.handler',
      link: [orgTable],
      timeout: '300 seconds',
      memory: '256 MB',
    });

    new sst.aws.CronV2('OwnerCountDriftCheckerCron', {
      // Daily at 04:00 UTC, away from the billing jobs' windows.
      schedule: 'cron(0 4 * * ? *)',
      function: ownerCountDriftChecker.arn,
    });

    // ── S3 Audit Broker billing-read role ───────────────────────────
    // Cross-account role the abuse-detection broker (s3-auditbroker, account
    // 654654381893) assumes for billing context on incidents: the detector
    // Lambda's `billing_lookup_role_arn` and the operator console's
    // `S3AB_BILLING_ROLE_ARN`. Read-only, and exactly the two calls the
    // broker's billing lookup makes: Scan on UserInfoTable + GetItem on
    // BillingTable. Referencing the table resources directly (rather than
    // pinning physical names) keeps the grant on the live tables — this
    // account also holds an orphaned duplicate table pair the role must not
    // match.
    //
    // The respond role below is the Phase 3 counterpart (tenant-key SSM read
    // + quarantine bucket writes) — provisioning it starts the mint slice of
    // that phase (s3-auditbroker docs/vercel-deployment-guide.md §2).
    let s3abBillingReadRoleArn: $util.Output<string> | undefined;
    let s3abRespondRoleArn: $util.Output<string> | undefined;
    if (isStaging || isProduction) {
      const vercelTeamSlug = 'filecoin-foundations-projects';
      const vercelProjectName = 's3-auditbroker-visualizer';
      const vercelOidcClaimPrefix = `oidc.vercel.com/${vercelTeamSlug}`;
      // Mirrors the broker's own read roles: preview deployments may reach
      // staging billing data, never production's.
      const vercelEnvironments = isProduction ? ['production'] : ['production', 'preview'];
      // Both broker instances live in 654654381893; each stage trusts the
      // instance that serves it. The principal is pinned to the role's unique
      // id at policy-write time, so recreating the detector role on the broker
      // side silently breaks this trust until the stage is redeployed.
      const brokerDetectorExecRoleArn = isProduction
        ? 'arn:aws:iam::654654381893:role/s3-auditbroker-prod-detector-exec'
        : 'arn:aws:iam::654654381893:role/s3-auditbroker-detector-exec';

      // The OIDC provider is account-wide (one per URL) and owned OUTSIDE
      // this stack. It must not be created here: a lookup-or-create would
      // flip the provider between a data source and a managed resource across
      // deploys, so the deploy after the creating one would drop it from
      // Pulumi state and delete it on removable stages, breaking both roles'
      // Vercel trust. Provision it once per account — the s3-auditbroker
      // tooling does this (scripts/vercel_setup.sh, `aws-oidc` phase), or:
      //   aws iam create-open-id-connect-provider \
      //     --url https://oidc.vercel.com/<team-slug> \
      //     --client-id-list https://vercel.com/<team-slug>
      let vercelOidcArn: string;
      try {
        const existing = await aws.iam.getOpenIdConnectProvider({
          url: `https://${vercelOidcClaimPrefix}`,
        });
        vercelOidcArn = existing.arn;
      } catch {
        throw new Error(
          `Vercel OIDC provider https://${vercelOidcClaimPrefix} not found in this account. ` +
            'It is owned outside this stack — create it once per account (see the comment ' +
            'above this throw) and re-deploy.',
        );
      }

      const s3abBillingReadRole = new aws.iam.Role('S3abBillingReadRole', {
        name: 'filone-console-visualizer-billing-read',
        assumeRolePolicy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Federated: vercelOidcArn },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  [`${vercelOidcClaimPrefix}:aud`]: `https://vercel.com/${vercelTeamSlug}`,
                  [`${vercelOidcClaimPrefix}:sub`]: vercelEnvironments.map(
                    (env) =>
                      `owner:${vercelTeamSlug}:project:${vercelProjectName}:environment:${env}`,
                  ),
                },
              },
            },
            {
              Effect: 'Allow',
              Principal: { AWS: brokerDetectorExecRoleArn },
              Action: 'sts:AssumeRole',
            },
          ],
        }),
        inlinePolicies: [
          {
            name: 's3ab-billing-read',
            policy: $jsonStringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['dynamodb:Scan'],
                  Resource: [userInfoTable.arn],
                },
                {
                  Effect: 'Allow',
                  Action: ['dynamodb:GetItem'],
                  Resource: [billingTable.arn],
                },
              ],
            }),
          },
        ],
      });
      s3abBillingReadRoleArn = s3abBillingReadRole.arn;

      // ── S3 Audit Broker respond role (Phase 3, armed actions) ──────
      // What the RESPONSE ARMED surfaces assume to mint tenant-key preview
      // URLs and quarantine objects. Its own role, separate from billing-read,
      // so CloudTrail cleanly splits "read the evidence" from "acted on a
      // tenant". Trusted for:
      //  - the console's Vercel OIDC identity — production deployments ONLY,
      //    on every stage: preview deployments run with bypass auth and must
      //    never arm; and
      //  - the human responder's SSO role, so the CLI response scripts
      //    (preview_url.py, quarantine_object.py) can assume it via STS.
      //    Note: AssumeRole requires BOTH this role's trust policy and an identity
      //    policy on the caller that allows sts:AssumeRole (even same-account).
      //    If the SSO permission set doesn't grant sts:AssumeRole, add it there.
      //    SSO role names carry a random suffix and are recreated if the
      //    permission set is reprovisioned — re-pin here if assumption starts
      //    failing.
      // Assumers must set RoleSessionName to the operator's identity so
      // CloudTrail and the incident receipts agree on *who* acted.
      const responderSsoRoleArn = isProduction
        ? 'arn:aws:iam::811430801166:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_ReadOnlyAccess_e180918ff18ef597'
        : 'arn:aws:iam::654654381893:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_983a3f40ae4c07e1';

      // Operator-created (deliberately outside IaC state, like the evidence it
      // holds) and not yet created in either account. Bucket names are global,
      // so the stages cannot share one. The s3:ResourceAccount condition below
      // keeps the grant inert until the bucket exists *in this account* — a
      // third party claiming the global name gains nothing.
      const quarantineBucketName = isProduction
        ? 'filone-ir-quarantine'
        : 'filone-ir-quarantine-staging';

      const s3abRespondRole = new aws.iam.Role('S3abRespondRole', {
        name: 'filone-console-visualizer-respond',
        assumeRolePolicy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Federated: vercelOidcArn },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  [`${vercelOidcClaimPrefix}:aud`]: `https://vercel.com/${vercelTeamSlug}`,
                  [`${vercelOidcClaimPrefix}:sub`]: `owner:${vercelTeamSlug}:project:${vercelProjectName}:environment:production`,
                },
              },
            },
            {
              Effect: 'Allow',
              Principal: { AWS: responderSsoRoleArn },
              Action: 'sts:AssumeRole',
            },
          ],
        }),
        inlinePolicies: [
          {
            name: 's3ab-respond',
            policy: $jsonStringify({
              Version: '2012-10-17',
              Statement: [
                {
                  // Mint: read a tenant's console S3 key to presign a
                  // short-lived preview URL, plus tenant listing
                  // (list_tenant_ids). The shared constant covers every SP
                  // backend's key subtree (aurora-s3, fth-s3, forge-s3) and
                  // stays in sync as backends are added.
                  Sid: 'MintTenantKeyRead',
                  Effect: 'Allow',
                  Action: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
                  Resource: orchestratorS3KeySsmArns,
                },
                {
                  // Quarantine: preserve evidence (Put), verify/restore (Get,
                  // List). No DeleteObject — evidence stays.
                  Sid: 'QuarantineEvidence',
                  Effect: 'Allow',
                  Action: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
                  Resource: [
                    `arn:aws:s3:::${quarantineBucketName}`,
                    `arn:aws:s3:::${quarantineBucketName}/*`,
                  ],
                  Condition: {
                    StringEquals: {
                      's3:ResourceAccount': aws.getCallerIdentityOutput({}).accountId,
                    },
                  },
                },
              ],
            }),
          },
        ],
      });
      s3abRespondRoleArn = s3abRespondRole.arn;
    }

    return {
      baseUrl: siteUrl,
      ...(s3abBillingReadRoleArn ? { s3abBillingReadRoleArn } : {}),
      ...(s3abRespondRoleArn ? { s3abRespondRoleArn } : {}),
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
