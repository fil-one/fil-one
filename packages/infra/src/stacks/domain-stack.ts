import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class DomainStack extends cdk.Stack {
  // Concrete HostedZone (not IHostedZone) so callers can read hostedZoneNameServers.
  public readonly hostedZone: route53.HostedZone;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = 'console.filhyperspace.com';

    this.hostedZone = new route53.HostedZone(this, 'HyperspaceHostedZone', {
      zoneName: domainName,
    });

    new cdk.CfnOutput(this, 'HyperspaceDelegationNameServers', {
      value: cdk.Fn.join(', ', this.hostedZone.hostedZoneNameServers!),
      description:
        'NS values — create a NS record for console.filhyperspace.com in the filhyperspace.com Route53 hosted zone pointing to these nameservers',
    });

    new cdk.CfnOutput(this, 'HyperspaceHostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route53 hosted zone ID for console.filhyperspace.com',
    });
  }
}
