/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const stage = input?.stage;
    const isProduction = stage === "production";
    const isStaging = stage === "staging";

    // Region: us-east-2 for staging/production, us-west-2 for personal dev
    const region = isProduction || isStaging ? "us-east-2" : "us-west-2";

    const awsProvider: Record<string, any> = { region };

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
    // ── Secrets (set via: npx sst secret set <Name> <value>) ─────────
    const auth0ClientId = new sst.Secret("Auth0ClientId");
    const auth0ClientSecret = new sst.Secret("Auth0ClientSecret");
    const stripeSecretKey = new sst.Secret("StripeSecretKey");
    const stripeWebhookSecret = new sst.Secret("StripeWebhookSecret");
    const stripePriceId = new sst.Secret("StripePriceId");

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

    // ── S3 Bucket for user file storage ──────────────────────────────
    const userFilesBucket = new sst.aws.Bucket("UserFilesBucket");

    // ── API Gateway ──────────────────────────────────────────────────
    const api = new sst.aws.ApiGatewayV2("Api");

    // ── Stage-aware domain config ────────────────────────────────────
    const stage = $app.stage;

    type SiteDomain = Exclude<sst.aws.StaticSiteArgs["domain"], undefined>;
    let domain: SiteDomain | undefined;

    if (stage === "production" || stage === "staging") {
      const domainName =
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

      domain = {
        name: domainName,
        dns: false, // DNS CNAME is managed by a separate pipeline
        cert: cert.arn,
      };
    }

    // ── Static Site + CloudFront ─────────────────────────────────────
    const site = new sst.aws.StaticSite("Website", {
      path: "packages/website/dist",
      ...(domain && { domain }),
      indexPage: "index.html",
      errorPage: "redirect_to_index_page",
      transform: {
        cdn: (args: Record<string, any>) => {
          // Add API Gateway as an additional CloudFront origin
          const apiDomain = api.url.apply(
            (url: string) => new URL(url).hostname,
          );

          args.origins = $output(args.origins).apply((origins: any[]) => [
            ...origins,
            {
              domainName: apiDomain,
              originId: "apiGateway",
              customOriginConfig: {
                httpPort: 80,
                httpsPort: 443,
                originProtocolPolicy: "https-only",
                originSslProtocols: ["TLSv1.2"],
              },
            },
          ]);

          // Add /api/* cache behavior routing to API Gateway
          args.orderedCacheBehaviors = [
            ...(args.orderedCacheBehaviors ?? []),
            {
              pathPattern: "/api/*",
              targetOriginId: "apiGateway",
              viewerProtocolPolicy: "redirect-to-https",
              allowedMethods: [
                "GET",
                "HEAD",
                "OPTIONS",
                "PUT",
                "POST",
                "PATCH",
                "DELETE",
              ],
              cachedMethods: ["GET", "HEAD"],
              // AWS managed policy: CachingDisabled
              cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
              // AWS managed policy: AllViewerExceptHostHeader
              originRequestPolicyId:
                "b689b0a8-53d0-40ab-baf2-68738e2966ac",
              compress: true,
            },
          ];
        },
      },
    });

    // ── Shared function config ───────────────────────────────────────
    const allResources = [
      uploadsTable,
      billingTable,
      userFilesBucket,
      auth0ClientId,
      auth0ClientSecret,
      stripeSecretKey,
      stripeWebhookSecret,
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
      extraEnv?: Record<string, any>,
    ) {
      api.route(`${method} ${routePath}`, {
        handler: `packages/backend/src/handlers/${handler}.handler`,
        link: allResources,
        environment: {
          ...sharedEnv,
          ...extraEnv,
        },
        runtime: "nodejs20.x",
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
      WEBSITE_URL: site.url,
      AUTH_CALLBACK_URL: $interpolate`${site.url}/api/auth/callback`,
    });
    addRoute("GET", "/api/auth/logout", "auth-logout", {
      WEBSITE_URL: site.url,
    });

    // ── Billing routes ───────────────────────────────────────────────
    addRoute("GET", "/api/billing", "get-billing");
    addRoute("POST", "/api/billing/setup-intent", "create-setup-intent");
    addRoute("POST", "/api/billing/activate", "activate-subscription");
    addRoute("POST", "/api/billing/portal", "create-portal-session", {
      WEBSITE_URL: site.url,
    });
    addRoute("POST", "/api/stripe/webhook", "stripe-webhook");

    return {
      url: site.url,
      api: api.url,
    };
  },
});
