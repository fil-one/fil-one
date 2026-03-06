/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const stage = input?.stage;
    const isProduction = stage === "production";
    const isStaging = stage === "staging";

    // Region: us-east-2 for staging/production, AWS_REGION / profile default for personal dev
    const region =
      isProduction || isStaging
        ? "us-east-2"
        : process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";

    const awsProvider: Record<string, unknown> = { region };

    if (isStaging) {
      awsProvider.allowedAccountIds = ["654654381893"];
    }
    // TODO: Set production account ID once provisioned
    // if (isProduction) {
    //   awsProvider.allowedAccountIds = ["<PRODUCTION_ACCOUNT_ID>"];
    // }

    return {
      name: "hyperspace",
      removal: isProduction ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: awsProvider,
      },
    };
  },
  async run() {
    // ── Secrets (set via: pnpx sst secret set <Name> <value>) ─────────
    const auth0ClientId = new sst.Secret("Auth0ClientId");
    const auth0ClientSecret = new sst.Secret("Auth0ClientSecret");
    const auth0MgmtClientId = new sst.Secret("Auth0MgmtClientId");
    const auth0MgmtClientSecret = new sst.Secret("Auth0MgmtClientSecret");
    const stripeSecretKey = new sst.Secret("StripeSecretKey");
    const stripePriceId = new sst.Secret("StripePriceId");
    const AWS_CACHING_DISABLED_POLICY = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

    // ── DynamoDB Tables ──────────────────────────────────────────────
    const uploadsTable = new sst.aws.Dynamo("UploadsTable", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
    });

    const billingTable = new sst.aws.Dynamo("BillingTable", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      ttl: "ttl",
    });

    const userInfoTable = new sst.aws.Dynamo("UserInfoTable", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
    });

    // ── S3 Bucket for user file storage ──────────────────────────────
    const userFilesBucket = new sst.aws.Bucket("UserFilesBucket");

    // ── API Gateway ──────────────────────────────────────────────────
    const api = new sst.aws.ApiGatewayV2("Api");

    // ── Stage-aware domain config ────────────────────────────────────
    const stage = $app.stage;

    let domainName: string | undefined;
    let certArn: string | undefined;

    if (stage === "production" || stage === "staging") {
      domainName =
        stage === "production"
          ? "console.filhyperspace.com"
          : "staging.filhyperspace.com";

      // ACM cert must be in us-east-1 for CloudFront
      const usEast1 = new aws.Provider("useast1", { region: "us-east-1" });
      const cert = await aws.acm.getCertificate(
        {
          domain: domainName,
          statuses: ["ISSUED"],
        },
        { provider: usEast1 },
      );

      certArn = cert.arn;
    }

    // ── Website (S3 + CloudFront via sst.aws.Router) ─────────────────
    const { local } = await import("@pulumi/command");

    const websiteBucket = new sst.aws.Bucket("WebsiteBucket", {
      access: "cloudfront",
      transform: {
        bucket: { forceDestroy: true },
      },
    });

    const router = new sst.aws.Router("WebsiteRouter", {
      routes: {
        "/*": { bucket: websiteBucket },
        "/api/*": {
          url: api.url,
          cachePolicy: AWS_CACHING_DISABLED_POLICY,
        },
      },
      ...(domainName && certArn
        ? { domain: { name: domainName, dns: false, cert: certArn } }
        : {}),
      transform: {
        cdn: (args) => {
          args.defaultRootObject = "index.html";
          args.customErrorResponses = [
            { errorCode: 403, responseCode: 200, responsePagePath: "/index.html", errorCachingMinTtl: 0 },
            { errorCode: 404, responseCode: 200, responsePagePath: "/index.html", errorCachingMinTtl: 0 },
          ];
        },
      },
    });

    const distPath = require("path").resolve("packages/website/dist");
    const sync = new local.Command("WebsiteSync", {
      create: $interpolate`aws s3 sync ${distPath} s3://${websiteBucket.nodes.bucket.bucket} --delete`,
      triggers: [Date.now().toString()],
    });

    new local.Command("WebsiteInvalidation", {
      create: $interpolate`aws cloudfront create-invalidation --distribution-id ${router.distributionID} --paths "/*"`,
      triggers: [Date.now().toString()],
    }, { dependsOn: [sync] });

    const siteUrl = router.url;

    // ── Deploy-time setup (Stripe webhook + Auth0 callbacks) ────────
    const setupFn = new sst.aws.Function("SetupIntegrations", {
      handler: "packages/backend/src/handlers/setup-integrations.handler",
      link: [stripeSecretKey, auth0MgmtClientId, auth0MgmtClientSecret, auth0ClientId],
      environment: {
        AUTH0_DOMAIN: "dev-oar2nhqh58xf5pwf.us.auth0.com",
      },
      permissions: [
        {
          actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
          resources: [
            $interpolate`arn:aws:ssm:*:*:parameter/hyperspace/${$app.stage}/*`,
          ],
        },
      ],
      // TODO: Remove `as any` once SST adds nodejs24.x to its type definitions
      // this PR was merged: https://github.com/anomalyco/sst/pull/6243#ref-commit-6fb1396
      // eslint-disable-next-line typescript/no-explicit-any
      runtime: "nodejs24.x" as any,
      timeout: "30 seconds",
    });

    new aws.cloudformation.Stack("SetupStack", {
      templateBody: $jsonStringify({
        AWSTemplateFormatVersion: "2010-09-09",
        Resources: {
          Setup: {
            Type: "Custom::HyperspaceSetup",
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
      auth0ClientId,
      auth0ClientSecret,
      stripeSecretKey,
      stripePriceId,
    ];

    const sharedEnv: Record<string, string> = {
      AUTH0_DOMAIN: "dev-oar2nhqh58xf5pwf.us.auth0.com",
      AUTH0_AUDIENCE: "console.filhyperspace.com",
    };

    function addRoute(
      method: string,
      routePath: string,
      handler: string,
      extraEnv?: Record<string, $util.Input<string>>,
    ) {
      api.route(`${method} ${routePath}`, {
        handler: `packages/backend/src/handlers/${handler}.handler`,
        link: allResources,
        environment: {
          ...sharedEnv,
          ...extraEnv,
        },
        // TODO: Remove `as any` once SST adds nodejs24.x to its type definitions
        // eslint-disable-next-line typescript/no-explicit-any
      runtime: "nodejs24.x" as any,
        timeout: "10 seconds",
      });
    }

    // ── Data routes ──────────────────────────────────────────────────
    addRoute("POST", "/api/upload", "upload");
    addRoute("GET", "/api/buckets", "list-buckets");
    addRoute("POST", "/api/buckets", "create-bucket");
    addRoute("DELETE", "/api/buckets/{name}", "delete-bucket");
    addRoute("GET", "/api/buckets/{name}/objects", "list-objects");
    addRoute("POST", "/api/buckets/{name}/objects/upload", "upload-object");
    addRoute(
      "GET",
      "/api/buckets/{name}/objects/download",
      "download-object",
    );
    addRoute("DELETE", "/api/buckets/{name}/objects", "delete-object");

    // ── Auth routes ──────────────────────────────────────────────────
    addRoute("GET", "/api/auth/callback", "auth-callback", {
      WEBSITE_URL: siteUrl,
      AUTH_CALLBACK_URL: $interpolate`${siteUrl}/api/auth/callback`,
    });
    addRoute("GET", "/api/auth/logout", "auth-logout", {
      WEBSITE_URL: siteUrl,
    });

    // ── Billing routes ───────────────────────────────────────────────
    addRoute("GET", "/api/billing", "get-billing");
    addRoute("POST", "/api/billing/setup-intent", "create-setup-intent");
    addRoute("POST", "/api/billing/activate", "activate-subscription");
    addRoute("POST", "/api/billing/portal", "create-portal-session", {
      WEBSITE_URL: siteUrl,
    });
    addRoute("POST", "/api/stripe/webhook", "stripe-webhook");

    return {
      url: siteUrl,
      api: api.url,
    };
  },
});
