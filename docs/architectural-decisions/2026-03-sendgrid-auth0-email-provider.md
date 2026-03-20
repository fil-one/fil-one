# ADR: SendGrid as Auth0 Email Provider

**Status:** Accepted
**Date:** 2026-03-16

## Context

Auth0 sends transactional emails for verification, password reset, MFA, and passwordless login. By default these come from Auth0's shared email infrastructure with generic branding. For a production-quality experience, emails should come from our own domain (`filone.ai`) with proper DKIM/SPF/DMARC alignment.

We need an email provider that:

- Integrates natively with Auth0 (API key, not SMTP relay)
- Supports domain authentication (DKIM, SPF alignment)
- Has a reasonable free tier for low-volume transactional auth emails
- Does not require lengthy approval processes (e.g., SES sandbox escape)

## Options Considered

### Amazon SES

Native Auth0 integration exists. However, new SES accounts start in sandbox mode which limits sending to verified addresses only — escaping sandbox requires a manual AWS support request with a business justification and typical turnaround of 24-48 hours. Additional configuration overhead (IAM credentials, SES identity verification) compared to SendGrid's single API key. Would be the right choice if we already had SES in production for other email workflows.

### Postmark

Strong deliverability reputation and purpose-built for transactional email. However, Auth0 has no native Postmark integration — it would require SMTP-only configuration, losing the simpler API-key setup path. SMTP relay also adds latency and a failure mode (connection timeouts) that the API-key approach avoids.

### Mailgun

Feature-comparable to SendGrid with a native Auth0 integration. The main differentiator is pricing: Mailgun's free tier is a 3-month trial that drops to a paid plan, while SendGrid offers 100 emails/day permanently on the free tier. For auth-only email volume this matters — we may never need to move to a paid plan with SendGrid.

### HubSpot

Requires Marketing Hub Professional ($800/mo minimum). Designed for marketing automation and campaign email, not transactional auth flows. No Auth0 integration. Wrong tool entirely for this use case.

## Decision

Use **SendGrid** as the email provider for Auth0 transactional emails across all environments. Auth0 has a first-class SendGrid integration that requires only an API key. Each Auth0 tenant gets its own SendGrid API key scoped to **Mail Send** permission only.

### Domain: `filone.ai`

Emails are sent from the `filone.ai` domain. DNS records for SendGrid domain authentication were added to the infrastructure repo via Terraform/Cloudflare.

**Infrastructure commit:** [FilHyperspace-Infrastructure@e2a96b09](https://github.com/FilecoinFoundationWeb/FilHyperspace-Infrastructure/commit/e2a96b090ce9f17bfa421678f0f8cb12eeaf5021)

Records added to `filone.ai` zone (all Cloudflare proxy disabled / DNS-only):

| Record                      | Type  | Name            | Value                                       |
| --------------------------- | ----- | --------------- | ------------------------------------------- |
| Link branding               | CNAME | `url4986`       | `sendgrid.net`                              |
| Link branding               | CNAME | `60831039`      | `sendgrid.net`                              |
| Return path (SPF alignment) | CNAME | `em1893`        | `u60831039.wl040.sendgrid.net`              |
| DKIM key 1                  | CNAME | `s1._domainkey` | `s1.domainkey.u60831039.wl040.sendgrid.net` |
| DKIM key 2                  | CNAME | `s2._domainkey` | `s2.domainkey.u60831039.wl040.sendgrid.net` |
| DMARC                       | TXT   | `_dmarc`        | `v=DMARC1; p=none;`                         |

### Per-environment configuration

| Setting               | Staging (shared Auth0 tenant)       | Production           |
| --------------------- | ----------------------------------- | -------------------- |
| Auth0 tenant          | `dev-oar2nhqh58xf5pwf.us.auth0.com` | TBD                  |
| SendGrid API key name | `filone-staging`                    | `filone-prod`        |
| From address          | `no-reply+staging@filone.ai`        | `no-reply@filone.ai` |
| Email subject prefix  | `[STAGING]`                         | (none)               |

The staging Auth0 tenant is shared across all development stacks — only one SendGrid API key is needed for the shared tenant, not one per developer.

### Integration approach

SendGrid configuration is applied to Auth0 via the Management API (`PUT /api/v2/emails/provider`) during deploy-time setup, following the same pattern as Stripe webhook and Auth0 callback configuration in `setup-integrations.ts`. The `SendGridApiKey` is stored as an SST secret and linked to the `SetupIntegrations` Lambda.

## Risks

### Shared IP reputation

SendGrid free/low tiers use shared sending IPs. If other senders on the same IP have poor reputation, deliverability could suffer. Mitigated by the low volume of auth-only emails. Consider a dedicated IP if deliverability becomes an issue at scale.

### DMARC policy is `p=none`

The current DMARC record uses `p=none` (monitor only). This should be tightened to `p=quarantine` or `p=reject` once we confirm all legitimate email sources are properly authenticated.

### Single SendGrid account

If the SendGrid account is suspended or rate-limited, all auth emails stop. For the current low volume this is acceptable. At scale, consider a fallback provider or dedicated sending account.
