import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
  table?: dynamodb.ITable;
  tableAccess?: 'read' | 'write' | 'readWrite';
  s3Bucket?: s3.IBucket;
  s3Access?: 'read' | 'write' | 'readWrite';
}

export class ApiFunction extends Construct {
  public readonly function: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiFunctionProps) {
    super(scope, id);

    this.function = new lambdaNodejs.NodejsFunction(this, 'Handler', {
      entry: path.resolve(__dirname, '../../../backend/src/handlers', props.handlerFile),
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      environment: {
        ...props.auth0Env,
        ...props.environment,
      },
      bundling: props.sharedBundling,
    });

    props.authSecret.grantRead(this.function);

    if (props.table) {
      switch (props.tableAccess) {
        case 'read':
          props.table.grantReadData(this.function);
          break;
        case 'write':
          props.table.grantWriteData(this.function);
          break;
        case 'readWrite':
          props.table.grantReadWriteData(this.function);
          break;
      }
    }

    if (props.s3Bucket) {
      switch (props.s3Access) {
        case 'read':
          props.s3Bucket.grantRead(this.function);
          break;
        case 'write':
          props.s3Bucket.grantWrite(this.function);
          break;
        case 'readWrite':
          props.s3Bucket.grantReadWrite(this.function);
          break;
      }
    }

    props.httpApi.addRoutes({
      path: props.routePath,
      methods: props.methods,
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        `${id}Integration`,
        this.function,
      ),
    });
  }
}
