# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Fil One, please report it responsibly. **Do not open a public issue.**

### For vulnerabilities in Fil One

Use GitHub's private vulnerability reporting feature, available at https://github.com/fil-one/fil-one/security.

Alternatively, email **security@fil.one**.

This covers:

- Fil One Staging environment. (https://staging.fil.one)
- Authentication, authorization, and session management
- Billing and subscription management
- API key issuance and access controls
- Infrastructure and CI/CD as defined in this repository

**Testing must be limited to the staging environment.** Do not test against production (`app.fil.one`) or access other users' data. Reports involving unauthorized production testing may be disqualified.

### For vulnerabilities in the Filecoin protocol

Bugs affecting the core Filecoin protocol (Lotus, builtin-actors, FVM, F3, and other [in-scope repositories](https://immunefi.com/bug-bounty/filecoin/)) should be reported through the **Filecoin Bug Bounty Program** on Immunefi:

> **https://immunefi.com/bug-bounty/filecoin/**

The program is administered by Filecoin Foundation and offers bounties for qualifying vulnerabilities. See the [Coordinated Disclosure Policy](https://fil.org/security/coordinated-disclosure-policy) for details.

### For vulnerabilities in third-party services & dependencies

- **Aurora storage backend** (`https://aurorainfra.ai/`). Is Out of Scope from this program, and should be reported directly at support@aurorainfra.ai
- **Auth0** — [Auth0 Responsible Disclosure](https://auth0.com/responsible-disclosure-policy)
- **Stripe** — [Stripe Security](https://stripe.com/docs/security/reporting)

### Bug bounty eligibility

FilOne currently doesn't operate a bug bounty program. Refer above for Filecoin related bug bounty.

## What to include in a report

- Description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- Affected version(s) or commit(s)
- Any suggested mitigation or fix

## What to expect

- Acknowledgement within 3 business days
- An initial assessment within 10 business days
- We will coordinate with you on disclosure timing

## Security contacts

For questions about this policy, reach out to the [Filecoin Foundation security team](https://fil.org/security).
