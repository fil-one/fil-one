import * as cdk from 'aws-cdk-lib';
import { ApiStack } from './stacks/api-stack';
import { DatabaseStack } from './stacks/database-stack';
import { DomainStack } from './stacks/domain-stack';
import { WebsiteStack } from './stacks/website-stack';

const app = new cdk.App();

//Sandbox account from "SSO start url" portal: https://d-9067ff87d6.awsapps.com/start/#/?tab=accounts
//Bootstrap needed admin access but in theory not needed for regular dev.
const env: cdk.Environment = {
  account: "654654381893",
  region: "us-east-2",
};

const domainStack = new DomainStack(app, 'HyperspaceDomainStack', { env });

const databaseStack = new DatabaseStack(app, 'HyperspaceDatabaseStack', { env });

// WebsiteStack created first so its CloudFront domain can be passed to ApiStack for CORS.
const websiteStack = new WebsiteStack(app, 'HyperspaceWebsiteStack', {
  env,
  // hostedZone: domainStack.hostedZone,
  // certificate: domainStack.certificate, // re-enable once DNS delegation is in place
});
// websiteStack.addDependency(domainStack);

const apiStack = new ApiStack(app, 'HyperspaceApiStack', {
  env,
  uploadsTable: databaseStack.uploadsTable,
  allowedOrigins: [
    `https://${websiteStack.distributionDomainName}`, // CloudFront (production)
    'http://localhost:5173',                           // Vite dev server
    'http://localhost:4173',                           // Vite preview
  ],
});
apiStack.addDependency(databaseStack);
apiStack.addDependency(websiteStack);

app.synth();
