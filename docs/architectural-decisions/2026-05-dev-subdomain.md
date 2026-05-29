# ADR: Host Dev & Preview Stages at `{stage}.dev.fil.one`

**Status:** Accepted
**Date:** 2026-05-29

## Context

Ephemeral SST stages — per-PR previews (stage `pr-{number}`) and personal dev stages — historically received CloudFront-assigned URLs of the form `{slug}.cloudfront.net`. These URLs are unstable across redeploys, unbranded, and (more importantly) cannot be added to the S3 Gateway CORS allowlists, which require explicit origins. We want every ephemeral stage to be reachable at `{stage}.dev.fil.one`.

The constraints that shaped the design:

- DNS for `fil.one` lives in Cloudflare, managed by Terraform in `fil-one/infrastructure` via HCP Terraform. Production records (`app.fil.one`, `staging.fil.one`, `auth.fil.one`, etc.) live there.
- We do not want a Cloudflare API token in SST, in GitHub Actions, or on developer laptops. Adding a per-stage Cloudflare record from `sst.config.ts` would require one.
- We want a single wildcard ACM cert for `*.dev.fil.one`, mirroring the existing per-domain cert pattern used for staging/prod.
- All ephemeral stages already deploy to the shared staging AWS account, so account-scoping the cert in that account is acceptable.

## Decision

Delegate the subdomain `dev.fil.one` from Cloudflare to AWS Route 53, provision a single wildcard ACM cert there, and let SST manage per-stage records natively through `sst.aws.dns()`.

```
fil.one (Cloudflare zone — unchanged for other subdomains)
└── dev.fil.one   ── NS ──► Route 53 hosted zone (staging AWS account)
                            ├── _<token>.dev.fil.one   ACM DNS validation
                            ├── pr-123.dev.fil.one     A/AAAA → CloudFront (stack pr-123)
                            ├── alice.dev.fil.one      A/AAAA → CloudFront (stack alice)
                            └── …
```

### One-time Terraform (in `fil-one/infrastructure`)

- `aws_route53_zone "dev"` — public hosted zone for `dev.fil.one`.
- `cloudflare_record "dev_delegation"` — NS records on `dev.fil.one` pointing to the Route 53 nameservers, `proxied = false`.
- `aws_acm_certificate "dev_wildcard"` — `*.dev.fil.one` with `dev.fil.one` SAN, in `us-east-1` (CloudFront requirement), DNS-validated via Route 53 records in the new zone.

### Per-stage in SST (`sst.config.ts`)

For ephemeral stages:

- `domainName = ${stage}.dev.fil.one`.
- The wildcard cert is looked up by `aws.acm.getCertificate({ domain: '*.dev.fil.one', ... })`.
- The `sst.aws.Router` `domain` block uses `sst.aws.dns({ override: true })`, which creates the A/AAAA alias record in the delegated Route 53 zone. Cleanup happens automatically on `sst remove`.

Staging and production keep `dns: false` because their records continue to be managed in Cloudflare by Terraform.

### Stage-name validation

Stage names become DNS labels, so `sst.config.ts` rejects ephemeral stage names that aren't valid DNS labels (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`). This fails the deploy early rather than producing a malformed record.

### Downstream — no further code change

`siteUrl` (used by `setup-integrations.ts` to register Auth0 callbacks, the Stripe webhook URL, and `ALLOWED_REDIRECT_ORIGINS`) is `router.url`, which returns the custom-domain URL once the Router has one. The custom resource's `handleOldUrlTeardown` path removes any previous `*.cloudfront.net` entries when the SiteUrl changes. The `SetupStack` `Version` property is bumped to force the Update event on existing stages.

## Alternatives considered

### Per-stage Cloudflare CNAME (via `@pulumi/cloudflare`)

Keep DNS for `dev.fil.one` in Cloudflare; let SST create one CNAME per stage and look up a wildcard cert managed by Terraform.

- Pro: no new AWS hosted zone; all DNS stays in one place.
- Con: requires a Cloudflare API token wherever SST runs — GitHub Actions secrets, every developer laptop. Rejected to keep the credential surface area small.

### Per-stage ACM cert (everything in SST)

SST provisions a fresh cert per stage instead of sharing a wildcard.

- Pro: works in any AWS account; no Terraform changes.
- Con: ~30-120s of cert-validation latency on first deploy of each stage; teardown ordering is fiddly; doesn't address the Cloudflare-token question. Rejected.

### Cloudflare-proxied DNS with Cloudflare-managed TLS

Per-stage Cloudflare record with `proxied = true`; Cloudflare terminates TLS and forwards to CloudFront with the `cloudfront.net` Host header.

- Pro: no ACM management at all.
- Con: adds a Cloudflare hop only on dev URLs, diverging from how staging/prod work today. `*.dev.fil.one` is not covered by Cloudflare Universal SSL (only `*.fil.one`) — would require Advanced Certificate Manager. Rejected.

## Operational notes

- Ephemeral stages must deploy to the staging AWS account (`654654381893`). ACM certs are account-scoped, so the wildcard cert is only usable from that account.
- The wildcard cert covers single-label subdomains only — `foo.dev.fil.one`, not `bar.foo.dev.fil.one`.
- Auth0 callback URLs are stage-specific. Long-lived stages that aren't torn down accumulate entries in the Auth0 client config. Cleanup happens automatically on `sst remove`; if cleanup is skipped the list will grow until the Auth0 cap is hit.
- DNSSEC is not currently enabled on `fil.one`. If it is enabled later, a DS-record exchange is needed for the delegated `dev.fil.one` zone.
