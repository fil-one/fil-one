import * as cdk from 'aws-cdk-lib';
import { ApiStack } from './stacks/api-stack';
import { DatabaseStack } from './stacks/database-stack';
import { DomainStack } from './stacks/domain-stack';
import { WebsiteStack } from './stacks/website-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env['CDK_DEFAULT_ACCOUNT'],
  region: process.env['CDK_DEFAULT_REGION'],
};

const domainStack = new DomainStack(app, 'HyperspaceDomainStack', { env });

const databaseStack = new DatabaseStack(app, 'HyperspaceDatabaseStack', { env });

const apiStack = new ApiStack(app, 'HyperspaceApiStack', {
  env,
  uploadsTable: databaseStack.uploadsTable,
});
apiStack.addDependency(databaseStack);

const websiteStack = new WebsiteStack(app, 'HyperspaceWebsiteStack', {
  env,
  hostedZone: domainStack.hostedZone,
  certificate: domainStack.certificate,
});
websiteStack.addDependency(domainStack);

app.synth();
