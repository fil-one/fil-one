import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DatabaseStack extends cdk.Stack {
  public readonly uploadsTable: dynamodb.ITable;
  public readonly billingTable: dynamodb.ITable;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.uploadsTable = new dynamodb.Table(this, 'HyperspaceUploadsTable', {
      tableName: 'hyperspace-uploads',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // RETAIN ensures the table survives a `cdk destroy` — data is preserved.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.billingTable = new dynamodb.Table(this, 'HyperspaceBillingTable', {
      tableName: 'hyperspace-billing',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });
  }
}
