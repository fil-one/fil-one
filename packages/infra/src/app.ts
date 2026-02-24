import * as cdk from 'aws-cdk-lib';
import { CertificateStack } from './stacks/certificate-stack';
import { DatabaseStack } from './stacks/database-stack';
import { DomainStack } from './stacks/domain-stack';
import { PlatformStack } from './stacks/platform-stack';

const app = new cdk.App();

//Sandbox account from "SSO start url" portal: https://d-9067ff87d6.awsapps.com/start/#/?tab=accounts
//Bootstrap needed admin access but in theory not needed for regular dev.
const account = "654654381893";

const env: cdk.Environment = { account, region: "us-east-2" };

const domainStack = new DomainStack(app, 'HyperspaceDomainStack', {
  env,
  crossRegionReferences: true,
});

// CloudFront requires ACM certificates in us-east-1.
const certificateStack = new CertificateStack(app, 'HyperspaceCertificateStack', {
  env: { account, region: "us-east-1" },
  crossRegionReferences: true,
  hostedZone: domainStack.hostedZone,
  domainName: 'console.filhyperspace.com',
});
certificateStack.addDependency(domainStack);

const databaseStack = new DatabaseStack(app, 'HyperspaceDatabaseStack', { env });

const platformStack = new PlatformStack(app, 'HyperspacePlatformStack', {
  env,
  crossRegionReferences: true,
  uploadsTable: databaseStack.uploadsTable,
  certificate: certificateStack.certificate,
  hostedZone: domainStack.hostedZone,
  domainName: 'console.filhyperspace.com',
});
platformStack.addDependency(databaseStack);
platformStack.addDependency(certificateStack);

app.synth();
