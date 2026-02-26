import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';

export interface ApiFunctionProps {
  handlerFile: string;
  routePath: string;
  methods: apigwv2.HttpMethod[];
  httpApi: apigwv2.HttpApi;
  authSecret: secretsmanager.ISecret;
  auth0Env: Record<string, string>;
  sharedBundling: lambdaNodejs.BundlingOptions;
  environment?: Record<string, string>;
  /** Skip granting auth secret access (for unauthenticated endpoints like webhooks) */
  skipAuth?: boolean;
  lambdaProps?: Partial<lambdaNodejs.NodejsFunctionProps>;
}

/**
 * Creates a Lambda function wired to an API Gateway route.
 *
 * Handles only the common baseline: bundling, auth secret, env vars, and
 * route registration. Grant table, S3, or other permissions on `.function`
 * at the call site.
 */
export class ApiFunction extends Construct {
  public readonly function: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiFunctionProps) {
    super(scope, id);

    const { lambdaProps, ...rest } = props;

    this.function = new lambdaNodejs.NodejsFunction(this, 'Handler', {
      entry: path.resolve(__dirname, '../../../backend/src/handlers', rest.handlerFile),
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      environment: {
        ...rest.auth0Env,
        ...rest.environment,
      },
      bundling: rest.sharedBundling,
      ...lambdaProps,
    });

    if (!rest.skipAuth) {
      rest.authSecret.grantRead(this.function);
    }

    rest.httpApi.addRoutes({
      path: rest.routePath,
      methods: rest.methods,
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        `${id}Integration`,
        this.function,
      ),
    });
  }
}
