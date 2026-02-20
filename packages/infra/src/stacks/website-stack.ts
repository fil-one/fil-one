import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { Construct } from 'constructs';

interface WebsiteStackProps extends cdk.StackProps {
  // hostedZone: route53.IHostedZone;
  // certificate: acm.ICertificate; // re-enable once DNS delegation is in place
}

export class WebsiteStack extends cdk.Stack {
  /** e.g. "xxxx.cloudfront.net" — pass to ApiStack for CORS allowed origins. */
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: WebsiteStackProps) {
    super(scope, id, props);

    const assetsBucket = new s3.Bucket(this, 'HyperspaceAssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'HyperspaceDistribution', {
      defaultBehavior: {
        // S3BucketOrigin.withOriginAccessControl() creates an OAC and
        // bucket policy automatically — no manual bucket policy needed.
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // TODO (future): add an /api/* behavior pointing to the API Gateway URL
      // so all traffic can go through a single CloudFront domain.
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          // SPA fallback: let TanStack Router handle client-side routing.
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      // certificate: props.certificate,     // re-enable with cert
      // domainNames: [props.hostedZone.zoneName], // re-enable with cert
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // Route53 alias — points hyperspace.filhyperspace.com → CloudFront distribution.
    // new route53.ARecord(this, 'HyperspaceAliasRecord', {
    //   zone: props.hostedZone,
    //   target: route53.RecordTarget.fromAlias(
    //     new route53Targets.CloudFrontTarget(distribution),
    //   ),
    // });

    new s3deploy.BucketDeployment(this, 'HyperspaceDeployment', {
      sources: [
        s3deploy.Source.asset(
          path.resolve(__dirname, '../../../website/dist'),
        ),
      ],
      destinationBucket: assetsBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // new cdk.CfnOutput(this, 'HyperspaceSiteUrl', {
    //   value: `https://${props.hostedZone.zoneName}`,
    //   description: 'Website URL (resolves once DNS delegation is complete)',
    // });

    new cdk.CfnOutput(this, 'HyperspaceCloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain — reachable immediately without DNS delegation',
    });
  }
}
