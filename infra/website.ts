import { local } from "@pulumi/command";
import type * as pulumiAws from "@pulumi/aws";

export interface WebsiteArgs {
  /** Path to the built website assets (e.g. "packages/website/dist") */
  distPath: string;
  /** API Gateway URL to proxy /api/* requests to */
  apiUrl: pulumiAws.apigatewayv2.Api["url"];
  /** Custom domain name (e.g. "console.filhyperspace.com") */
  domainName?: string;
  /** ACM certificate ARN in us-east-1 (required if domainName is set) */
  certArn?: string;
}

export interface WebsiteOutputs {
  /** The full site URL (https://...) */
  url: ReturnType<typeof $interpolate>;
  /** The CloudFront distribution */
  distribution: pulumiAws.cloudfront.Distribution;
  /** The S3 bucket holding website assets */
  bucket: pulumiAws.s3.BucketV2;
}

export function createWebsite(args: WebsiteArgs): WebsiteOutputs {
  const { distPath, apiUrl, domainName, certArn } = args;

  // ── S3 Bucket for website assets ──────────────────────────────────
  const bucket = new aws.s3.BucketV2("WebsiteBucket", {});

  new aws.s3.BucketPublicAccessBlock("WebsiteBucketPublicAccess", {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  // ── Origin Access Control for CloudFront → S3 ─────────────────────
  const oac = new aws.cloudfront.OriginAccessControl("WebsiteOAC", {
    name: $interpolate`hyperspace-${$app.stage}-website-oac`,
    originAccessControlOriginType: "s3",
    signingBehavior: "always",
    signingProtocol: "sigv4",
  });

  // ── CloudFront Distribution ───────────────────────────────────────
  const apiDomain = apiUrl.apply((url: string) => new URL(url).hostname);

  const distribution = new aws.cloudfront.Distribution("WebsiteCdn", {
    comment: `hyperspace-${$app.stage} website`,
    enabled: true,
    defaultRootObject: "index.html",

    origins: [
      {
        originId: "s3",
        domainName: bucket.bucketRegionalDomainName,
        originAccessControlId: oac.id,
      },
      {
        originId: "apiGateway",
        domainName: apiDomain,
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: "https-only",
          originSslProtocols: ["TLSv1.2"],
        },
      },
    ],

    // Default behavior: serve from S3
    defaultCacheBehavior: {
      targetOriginId: "s3",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
      cachedMethods: ["GET", "HEAD"],
      compress: true,
      // AWS managed policy: CachingOptimized
      cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
    },

    // /api/* → API Gateway
    orderedCacheBehaviors: [
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
        originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        compress: true,
      },
    ],

    // SPA fallback: S3 403/404 → index.html
    customErrorResponses: [
      {
        errorCode: 403,
        responseCode: 200,
        responsePagePath: "/index.html",
        errorCachingMinTtl: 0,
      },
      {
        errorCode: 404,
        responseCode: 200,
        responsePagePath: "/index.html",
        errorCachingMinTtl: 0,
      },
    ],

    restrictions: {
      geoRestriction: { restrictionType: "none" },
    },

    ...(domainName && certArn
      ? {
          aliases: [domainName],
          viewerCertificate: {
            acmCertificateArn: certArn,
            sslSupportMethod: "sni-only",
            minimumProtocolVersion: "TLSv1.2_2021",
          },
        }
      : {
          viewerCertificate: {
            cloudfrontDefaultCertificate: true,
          },
        }),

    waitForDeployment: true,
  });

  // ── Bucket policy: allow CloudFront OAC to read ───────────────────
  new aws.s3.BucketPolicy("WebsiteBucketPolicy", {
    bucket: bucket.id,
    policy: $jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowCloudFrontOAC",
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "s3:GetObject",
          Resource: $interpolate`${bucket.arn}/*`,
          Condition: {
            StringEquals: {
              "AWS:SourceArn": distribution.arn,
            },
          },
        },
      ],
    }),
  });

  // ── Sync website dist to S3 ───────────────────────────────────────
  const absoluteDistPath = require("path").resolve(distPath);
  const sync = new local.Command("WebsiteSync", {
    create: $interpolate`aws s3 sync ${absoluteDistPath} s3://${bucket.id} --delete`,
    triggers: [Date.now().toString()],
  });

  // ── Invalidate CloudFront cache after sync ────────────────────────
  new local.Command(
    "WebsiteInvalidation",
    {
      create: $interpolate`aws cloudfront create-invalidation --distribution-id ${distribution.id} --paths "/*"`,
      triggers: [Date.now().toString()],
    },
    { dependsOn: [sync] },
  );

  // ── Derive site URL ───────────────────────────────────────────────
  const url = domainName
    ? `https://${domainName}`
    : $interpolate`https://${distribution.domainName}`;

  return { url, distribution, bucket };
}
