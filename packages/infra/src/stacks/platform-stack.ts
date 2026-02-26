import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';
import { ApiFunction } from '../constructs/api-function';

interface PlatformStackProps extends cdk.StackProps {
  uploadsTable: dynamodb.ITable;
  billingTable: dynamodb.ITable;
  certificate: acm.ICertificate;
  hostedZone: route53.IHostedZone;
  domainName: string;
}

export class PlatformStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    // ── Auth0 credentials ──────────────────────────────────────────────
    const authSecret = new secretsmanager.Secret(this, 'AuthenticationSecrets', {
      secretName: 'AuthenticationSecrets',
      description: 'Auth0 client credentials (AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET)',
    });

    // ── Billing / Stripe credentials ───────────────────────────────────
    const billingSecret = new secretsmanager.Secret(this, 'BillingSecrets', {
      secretName: 'BillingSecrets',
      description: 'Stripe credentials (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID)',
    });

    const httpApi = new apigwv2.HttpApi(this, 'HyperspaceHttpApi');

    // ── Shared Lambda config ───────────────────────────────────────────
    const auth0Env = {
      AUTH_SECRET_NAME: authSecret.secretName,
      // TODO [Option D]: Replace with custom domain (e.g. auth.filhyperspace.com)
      // once Auth0 paid plan + DNS CNAME is configured.
      AUTH0_DOMAIN: 'dev-oar2nhqh58xf5pwf.us.auth0.com',
      AUTH0_AUDIENCE: 'console.filhyperspace.com',
    };

    const sharedBundling: lambdaNodejs.BundlingOptions = {
      externalModules: [],
      minify: true,
      sourceMap: true,
    };

    // ── S3 bucket for user file storage (temporary — swap for Filecoin later)
    const userFilesBucket = new s3.Bucket(this, 'UserFilesTemp', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ── S3 bucket for the SPA ──────────────────────────────────────────
    const assetsBucket = new s3.Bucket(this, 'HyperspaceAssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── CloudFront distribution ────────────────────────────────────────
    // Extract the API GW domain from its endpoint (https://xxxx.execute-api.region.amazonaws.com)
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));

    const apiOrigin = new cloudfrontOrigins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const distribution = new cloudfront.Distribution(this, 'HyperspaceDistribution', {
      domainNames: [props.domainName],
      certificate: props.certificate,
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
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
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // ── Route53 alias records → CloudFront ───────────────────────────
    new route53.ARecord(this, 'CloudFrontAlias', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    new route53.AaaaRecord(this, 'CloudFrontAliasIPv6', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    // ── Shared references ────────────────────────────────────────────
    const cfDomain = `https://${props.domainName}`;
    const apiDefaults = { httpApi, authSecret, auth0Env, sharedBundling };
    const { uploadsTable, billingTable } = props;

    const uploadsEnv = { UPLOADS_TABLE_NAME: uploadsTable.tableName };
    const uploadsAndFilesEnv = { ...uploadsEnv, USER_FILES_BUCKET_NAME: userFilesBucket.bucketName };
    const billingEnv = {
      BILLING_TABLE_NAME: billingTable.tableName,
      BILLING_SECRET_NAME: billingSecret.secretName,
    };
    // Data handlers need billing table access for subscription guard middleware
    const dataEnv = { ...uploadsEnv, BILLING_TABLE_NAME: billingTable.tableName };
    const dataAndFilesEnv = { ...dataEnv, USER_FILES_BUCKET_NAME: userFilesBucket.bucketName };

    // ── Uploads ──────────────────────────────────────────────────────

    const upload = new ApiFunction(this, 'Upload', {
      ...apiDefaults,
      handlerFile: 'upload.ts',
      routePath: '/api/upload',
      methods: [apigwv2.HttpMethod.POST],
      environment: dataEnv,
    });
    uploadsTable.grantWriteData(upload.function);
    billingTable.grantReadWriteData(upload.function);

    // ── Bucket CRUD ─────────────────────────────────────────────────

    const listBuckets = new ApiFunction(this, 'ListBuckets', {
      ...apiDefaults,
      handlerFile: 'list-buckets.ts',
      routePath: '/api/buckets',
      methods: [apigwv2.HttpMethod.GET],
      environment: dataEnv,
    });
    uploadsTable.grantReadData(listBuckets.function);
    billingTable.grantReadWriteData(listBuckets.function);

    const createBucket = new ApiFunction(this, 'CreateBucket', {
      ...apiDefaults,
      handlerFile: 'create-bucket.ts',
      routePath: '/api/buckets',
      methods: [apigwv2.HttpMethod.POST],
      environment: dataEnv,
    });
    uploadsTable.grantWriteData(createBucket.function);
    billingTable.grantReadWriteData(createBucket.function);

    const deleteBucket = new ApiFunction(this, 'DeleteBucket', {
      ...apiDefaults,
      handlerFile: 'delete-bucket.ts',
      routePath: '/api/buckets/{name}',
      methods: [apigwv2.HttpMethod.DELETE],
      environment: dataEnv,
    });
    uploadsTable.grantReadWriteData(deleteBucket.function);
    billingTable.grantReadWriteData(deleteBucket.function);

    // ── Object CRUD ─────────────────────────────────────────────────

    const listObjects = new ApiFunction(this, 'ListObjects', {
      ...apiDefaults,
      handlerFile: 'list-objects.ts',
      routePath: '/api/buckets/{name}/objects',
      methods: [apigwv2.HttpMethod.GET],
      environment: dataEnv,
    });
    uploadsTable.grantReadData(listObjects.function);
    billingTable.grantReadWriteData(listObjects.function);

    const uploadObject = new ApiFunction(this, 'UploadObject', {
      ...apiDefaults,
      handlerFile: 'upload-object.ts',
      routePath: '/api/buckets/{name}/objects/upload',
      methods: [apigwv2.HttpMethod.POST],
      environment: dataAndFilesEnv,
    });
    uploadsTable.grantReadWriteData(uploadObject.function);
    userFilesBucket.grantWrite(uploadObject.function);
    billingTable.grantReadWriteData(uploadObject.function);

    const downloadObject = new ApiFunction(this, 'DownloadObject', {
      ...apiDefaults,
      handlerFile: 'download-object.ts',
      routePath: '/api/buckets/{name}/objects/download',
      methods: [apigwv2.HttpMethod.GET],
      environment: dataAndFilesEnv,
    });
    uploadsTable.grantReadData(downloadObject.function);
    userFilesBucket.grantRead(downloadObject.function);
    billingTable.grantReadWriteData(downloadObject.function);

    const deleteObject = new ApiFunction(this, 'DeleteObject', {
      ...apiDefaults,
      handlerFile: 'delete-object.ts',
      routePath: '/api/buckets/{name}/objects',
      methods: [apigwv2.HttpMethod.DELETE],
      environment: dataAndFilesEnv,
    });
    uploadsTable.grantReadWriteData(deleteObject.function);
    userFilesBucket.grantReadWrite(deleteObject.function);
    billingTable.grantReadWriteData(deleteObject.function);

    // ── Auth ────────────────────────────────────────────────────────

    new ApiFunction(this, 'AuthCallback', {
      ...apiDefaults,
      handlerFile: 'auth-callback.ts',
      routePath: '/api/auth/callback',
      methods: [apigwv2.HttpMethod.GET],
      environment: { AUTH_CALLBACK_URL: `${cfDomain}/api/auth/callback`, WEBSITE_URL: cfDomain },
    });

    new ApiFunction(this, 'AuthLogout', {
      ...apiDefaults,
      handlerFile: 'auth-logout.ts',
      routePath: '/api/auth/logout',
      methods: [apigwv2.HttpMethod.GET],
      environment: { WEBSITE_URL: cfDomain },
    });

    // ── Billing API ─────────────────────────────────────────────────

    const getBilling = new ApiFunction(this, 'GetBilling', {
      ...apiDefaults,
      handlerFile: 'get-billing.ts',
      routePath: '/api/billing',
      methods: [apigwv2.HttpMethod.GET],
      environment: { ...billingEnv, UPLOADS_TABLE_NAME: uploadsTable.tableName },
    });
    billingTable.grantReadWriteData(getBilling.function);
    uploadsTable.grantReadData(getBilling.function);
    billingSecret.grantRead(getBilling.function);

    const createSetupIntent = new ApiFunction(this, 'CreateSetupIntent', {
      ...apiDefaults,
      handlerFile: 'create-setup-intent.ts',
      routePath: '/api/billing/setup-intent',
      methods: [apigwv2.HttpMethod.POST],
      environment: billingEnv,
    });
    billingTable.grantReadWriteData(createSetupIntent.function);
    billingSecret.grantRead(createSetupIntent.function);

    const activateSubscription = new ApiFunction(this, 'ActivateSubscription', {
      ...apiDefaults,
      handlerFile: 'activate-subscription.ts',
      routePath: '/api/billing/activate',
      methods: [apigwv2.HttpMethod.POST],
      environment: billingEnv,
    });
    billingTable.grantReadWriteData(activateSubscription.function);
    billingSecret.grantRead(activateSubscription.function);

    const createPortalSession = new ApiFunction(this, 'CreatePortalSession', {
      ...apiDefaults,
      handlerFile: 'create-portal-session.ts',
      routePath: '/api/billing/portal',
      methods: [apigwv2.HttpMethod.POST],
      environment: { ...billingEnv, WEBSITE_URL: cfDomain },
    });
    billingTable.grantReadData(createPortalSession.function);
    billingSecret.grantRead(createPortalSession.function);

    const stripeWebhook = new ApiFunction(this, 'StripeWebhook', {
      ...apiDefaults,
      handlerFile: 'stripe-webhook.ts',
      routePath: '/api/stripe/webhook',
      methods: [apigwv2.HttpMethod.POST],
      skipAuth: true,
      environment: billingEnv,
    });
    billingTable.grantReadWriteData(stripeWebhook.function);
    billingSecret.grantRead(stripeWebhook.function);

    // ── Deploy SPA to S3 ───────────────────────────────────────────────
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

    // ── Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'HyperspaceCloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain (serves both SPA and API)',
    });
  }
}
