import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class DomainStack extends cdk.Stack {
  // Concrete HostedZone (not IHostedZone) so callers can read hostedZoneNameServers.
  public readonly hostedZone: route53.HostedZone;
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = 'hyperspace.filecoin.io';

    this.hostedZone = new route53.HostedZone(this, 'HostedZone', {
      zoneName: domainName,
    });

    // Certificate must be in us-east-1 for CloudFront compatibility.
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    // After deploying this stack, add an NS record in the filecoin.io hosted
    // zone that delegates hyperspace.filecoin.io to these four nameservers.
    new cdk.CfnOutput(this, 'DelegationNameServers', {
      value: cdk.Fn.join(', ', this.hostedZone.hostedZoneNameServers!),
      description:
        'NS values — create a NS record for hyperspace.filecoin.io in the filecoin.io Route53 hosted zone pointing to these nameservers',
    });

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route53 hosted zone ID for hyperspace.filecoin.io',
    });
  }
}
