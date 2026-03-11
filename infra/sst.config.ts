/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const stage = input?.stage;
    if (stage !== 'staging' && stage !== 'production') {
      throw new Error(
        `The infra project only supports "staging" and "production" stages, got "${stage}".`,
      );
    }

    const awsProvider: Record<string, unknown> = { region: 'us-east-2' };

    if (stage === 'staging') {
      awsProvider.allowedAccountIds = ['654654381893'];
    } else if (stage === 'production') {
      throw new Error(
        'Production AWS account ID is not yet configured. ' +
          'Set allowedAccountIds for the production stage before deploying.',
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
    // OIDC Identity Provider for GitHub Actions
    const github = new aws.iam.OpenIdConnectProvider('GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdLists: ['sts.amazonaws.com'],
    });

    // IAM Role for GitHub Actions
    const roleName = `filone-infra-${$app.stage}-github`;
    const role = new aws.iam.Role('GitHubActionsRole', {
      name: roleName,
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Federated: github.arn },
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
