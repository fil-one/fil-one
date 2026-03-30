/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const stage = input?.stage;

    const awsProvider: Record<string, unknown> = { region: 'us-east-2' };

    switch (stage) {
      case 'staging':
        awsProvider.allowedAccountIds = ['654654381893'];
        break;
      case 'production':
        awsProvider.allowedAccountIds = ['811430801166'];
        break;
      default:
        throw new Error(
          `The infra project only supports "staging" and "production" stages, got "${stage}".`,
        );
    }

    return {
      name: 'filone-infra',
      removal: stage === 'production' ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: awsProvider,
      },
    };
  },
  async run() {
    // ── Secrets (set via: pnpx sst secret set <Name> <value> --stage <stage>) ──
    const grafanaPrometheusAuth = new sst.Secret('GrafanaPrometheusAuth');

    // ── Metric Stream Pipeline (CloudWatch Metrics → Prometheus) ─────
    setupMetricStreamPipeline(grafanaPrometheusAuth);

    // ── OIDC Identity Provider for GitHub Actions ────────────────────
    // The provider is account-wide (one per URL). Look up an existing one
    // first; only create it when deploying to a fresh account.
    let githubOidcArn: string;
    try {
      const existing = await aws.iam.getOpenIdConnectProvider({
        url: 'https://token.actions.githubusercontent.com',
      });
      githubOidcArn = existing.arn;
    } catch {
      const provider = new aws.iam.OpenIdConnectProvider('GithubOidcProvider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIdLists: ['sts.amazonaws.com'],
      });
      githubOidcArn = provider.arn;
    }

    // IAM Role for GitHub Actions
    const roleName = `filone-infra-${$app.stage}-github`;
    const role = new aws.iam.Role('GitHubActionsRole', {
      name: roleName,
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Federated: githubOidcArn },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringLike: {
                'token.actions.githubusercontent.com:sub': 'repo:filecoin-project/fil-one:*',
              },
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              },
            },
          },
        ],
      },
    });

    // AdministratorAccess (SST needs broad permissions)
    new aws.iam.RolePolicyAttachment('GitHubActionsRolePolicy', {
      policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess',
      role: role.name,
    });

    return {
      roleArn: role.arn,
    };
  },
});

// ── Metric Stream Pipeline (CloudWatch Metrics → Prometheus) ─────
function setupMetricStreamPipeline(grafanaPrometheusAuth: sst.Secret) {
  const backupBucket = new sst.aws.Bucket('MetricFirehoseBackup', {
    transform: {
      bucket: { forceDestroy: true },
    },
  });

  const logGroup = new aws.cloudwatch.LogGroup('MetricFirehoseLogGroup', {
    retentionInDays: 7,
  });
  const logStream = new aws.cloudwatch.LogStream('MetricFirehoseLogStream', {
    logGroupName: logGroup.name,
  });

  const firehoseRole = new aws.iam.Role('MetricFirehoseRole', {
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
        name: 'firehose-s3-and-logs',
        policy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
              Resource: [backupBucket.arn],
            },
            {
              Effect: 'Allow',
              Action: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'],
              Resource: [$interpolate`${backupBucket.arn}/*`],
            },
            {
              Effect: 'Allow',
              Action: ['logs:PutLogEvents'],
              Resource: [$interpolate`${logGroup.arn}:*`],
            },
          ],
        }),
      },
    ],
  });

  const firehose = new aws.kinesis.FirehoseDeliveryStream('MetricDelivery', {
    name: $interpolate`filone-infra-${$app.stage}-MetricDelivery`,
    destination: 'http_endpoint',
    httpEndpointConfiguration: {
      url: 'https://aws-metric-streams-prod-10.grafana.net/aws-metrics/api/v1/push',
      name: 'grafanacloud-filecoinfoundation-metrics',
      accessKey: grafanaPrometheusAuth.value,
      bufferingInterval: 60,
      bufferingSize: 1,
      roleArn: firehoseRole.arn,
      cloudwatchLoggingOptions: {
        enabled: true,
        logGroupName: logGroup.name,
        logStreamName: logStream.name,
      },
      s3BackupMode: 'FailedDataOnly',
      s3Configuration: {
        bucketArn: backupBucket.arn,
        roleArn: firehoseRole.arn,
      },
      requestConfiguration: {
        contentEncoding: 'GZIP',
      },
    },
  });

  const metricStreamRole = new aws.iam.Role('MetricStreamRole', {
    assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          actions: ['sts:AssumeRole'],
          principals: [
            { type: 'Service', identifiers: ['streams.metrics.cloudwatch.amazonaws.com'] },
          ],
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
        name: 'metric-stream-to-firehose',
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

  new aws.cloudwatch.MetricStream('MetricStream', {
    name: $interpolate`filone-infra-${$app.stage}-MetricStream`,
    roleArn: metricStreamRole.arn,
    firehoseArn: firehose.arn,
    outputFormat: 'opentelemetry1.0',
    includeFilters: [
      { namespace: 'AWS/Lambda', metricNames: [] },
      { namespace: 'AWS/ApiGateway', metricNames: [] },
      { namespace: 'AWS/SQS', metricNames: [] },
      { namespace: 'AWS/DynamoDB', metricNames: [] },
    ],
  });
}
