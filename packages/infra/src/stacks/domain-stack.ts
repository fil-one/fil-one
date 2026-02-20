import * as cdk from 'aws-cdk-lib';
// import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class DomainStack extends cdk.Stack {
  // Concrete HostedZone (not IHostedZone) so callers can read hostedZoneNameServers.
  public readonly hostedZone: route53.HostedZone;

  // Commented out until DNS delegation from filecoin.io is in place —
  // ACM DNS validation will fail until Route53 is authoritative for the zone.
  // public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = 'console.filhyperspace.com';

    this.hostedZone = new route53.HostedZone(this, 'HyperspaceHostedZone', {
      zoneName: domainName,
    });

    // this.certificate = new acm.Certificate(this, 'HyperspaceCertificate', {
    //   domainName,
    //   subjectAlternativeNames: [`*.${domainName}`],
    //   validation: acm.CertificateValidation.fromDns(this.hostedZone),
    // });

    // After deploying this stack, add an NS record in the filecoin.io hosted
    // zone that delegates hyperspace.filecoin.io to these four nameservers.
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
