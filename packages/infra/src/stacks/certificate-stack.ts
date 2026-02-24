import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

interface CertificateStackProps extends cdk.StackProps {
  hostedZone: route53.IHostedZone;
  domainName: string;
}

/**
 * Deploys to us-east-1 — CloudFront requires ACM certificates in that region.
 * Uses the hosted zone from DomainStack (us-east-2) for DNS validation;
 * Route53 hosted zones are global so cross-region lookups work fine.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'HyperspaceCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
    });
  }
}