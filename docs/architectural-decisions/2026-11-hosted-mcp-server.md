# ADR: Hosted MCP server in the console backend

**Status:** Proposed
**Date:** 2026-11-18

## Context

filoneMCP is a separate TypeScript codebase with two entry points. Both expose the same 35 `fil_one_*` tools for storage, analytics, content insight and key audit.

|                     | Local mode                                                              | Hosted mode                                                                        |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Runs on             | The user's machine; the agent starts it over stdio                      | A container Fil One would run behind the console's domain                          |
| User signs in with  | A Fil One access key in environment variables, limited to named buckets | Auth0 login, then an MCP OAuth token from filoneMCP's own OAuth server             |
| Storage credentials | The user's key, held in process memory                                  | S3 keys the user pastes in the console, encrypted with `VAULT_KEY` and stored      |
| State               | In memory                                                               | PostgreSQL: grants, sessions, tokens, rate limits, an enrollment ledger, audit log |
| Status              | Usable, published as a private npm package                              | Release candidate; never deployed                                                  |

Large transfers already go directly between the client and Fil One through presigned URLs. Inline reads, verification and content insight pass object bytes through the server, capped at 1 to 16 MiB per call.

The hosted container would be a second production system that duplicates what the console backend already runs:

- **A second stack to operate.** A container service, ALB and CloudFront routing, RDS PostgreSQL with `verify-full` TLS, startup migrations, a managed `VAULT_KEY` and exact trusted-proxy CIDRs. None of it exists in fil-one.
- **Paid while idle.** The container and database run all the time; the console backend is Lambda and DynamoDB, billed per request.
- **It stores customer secrets.** Anyone holding the database and `VAULT_KEY` gets direct access to customer data.
- **It can't do account work.** It has no API for access keys, usage is stubbed, and costs are list-price estimates.
- **Duplicated identity and limits.** Its own OAuth server, sessions and rate limiting sit beside the console's Auth0 handling.

## Decisions

### 1. Hosted MCP is a route in the console backend

Add `POST /api/mcp` on the existing API Gateway, handled by a Lambda built with the project's `createFunction` helper. The handler is stateless [JSON-RPC](https://www.jsonrpc.org/specification) over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): one JSON response per request, no sessions and no server-sent events. State lives in the console's existing DynamoDB tables; there is no PostgreSQL. The first tool, `list_buckets`, calls `listOrgBuckets`, the same code the console's bucket list uses.

### 2. Auth0 is the authorization server

[MCP clients](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) find Auth0 through the [protected-resource metadata](https://www.rfc-editor.org/rfc/rfc9728) at `/.well-known/oauth-protected-resource/api/mcp`, and sign the user in with the console's own connections. Auth0 issues access tokens whose audience is the MCP URL ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)). Clients register through [Client ID Metadata Documents](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/); [dynamic client registration](https://www.rfc-editor.org/rfc/rfc7591) stays off. The backend verifies the token and resolves the same user, org and role as a console session.

This change turns on Client ID Metadata Document support in each Auth0 tenant behind the MCP URL. Without it, clients can't register and no tool call authenticates; `auth.fil.one` doesn't advertise it today.

### 3. Tools act as the user, with the console's permissions

An MCP token carries the user's identity, not scopes of its own. Each tool calls the backend services a console handler would, under the same role checks and bucket policies, so the MCP can never do more than the user can in the console. Each tool checks its own permission, the way the matching console route does. The route itself requires no single permission, because one permission such as `buckets.read` would fit only read tools.

### 4. Fil One never reads object contents

Every read and write of object data goes through a [presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html) that the agent fetches itself. Tools return metadata and links, never object bytes.

### 5. Presigned URLs are signed with the org's console key

The backend checks the user's role and the bucket policy, then signs with the org's console key, as the console's presign handler does. Fil One stores no access key secrets, so it can't sign as a user's key. Lifetimes stay short, because an issued URL stays valid until it expires.

### 6. No MCP-specific quotas or concurrency limits

The route has the same limits as other console routes.

### 7. Local mode stays a separate implementation

filoneMCP's stdio package keeps working with the user's own scoped key. Sharing code with the hosted route can wait.

## Consequences

The database, the OAuth server and the stored customer keys go away; the remaining work is mostly adding tools.

| Concern                  | filoneMCP hosted mode                                                        | This decision                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Sign-in and tokens       | Own OAuth server; sessions and tokens in PostgreSQL                          | Auth0 tokens for the MCP URL                                                          |
| Identity and permissions | Connection grants with their own scopes                                      | The console's user, org membership and role                                           |
| Storage credentials      | Pasted S3 keys, stored encrypted                                             | None stored per user; the org's console key signs after role and bucket-policy checks |
| State                    | PostgreSQL                                                                   | The console's existing DynamoDB tables                                                |
| Quotas and limits        | 50 connections per owner, per-owner request budgets, per-process concurrency | None beyond what console routes have                                                  |
| Transport                | Long-running HTTP server                                                     | Stateless JSON-RPC, one JSON response per request                                     |

### Accepted costs

- **The backend check is the only control on object access.** A presigned URL carries the console key's full access, so storage doesn't apply the user's limits when the URL is used, and revoking access doesn't cancel URLs already issued.
- **No hosted equivalent of inline reads, verification or content insight.** The agent downloads the object and does that work itself.
- **A 30-second ceiling per request.** [API Gateway HTTP APIs cap an integration at 30 s](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), and raising the Lambda timeout doesn't change that.
- **Clients without Client ID Metadata Document support need a pasted client id.** Cursor and Gemini CLI connect through one pre-registered public Auth0 client.
- **Two implementations.** Local and hosted tools can drift apart until they share code.

### Follow-up work

- Add the tools users need first, written against backend services: access keys, members and roles, usage and billing, bucket creation.
- Put the route behind a feature flag. Add a docs.filone.com page before launch, or the `docs:gated` label while it's flagged.

## Alternatives considered

### Deploy filoneMCP's hosted container as built

Rejected for the reasons in Context: a second stack to run, paid while idle, stored customer keys, and no account tools.

### Port filoneMCP's hosted mode to Lambda with its own OAuth and grant store

Replacing PostgreSQL with DynamoDB would remove the container, but keep a second OAuth server and the pasted customer keys. Auth0 and the console's permissions already cover both.

### Act as an access key the agent names

Fil One stores no key secrets, so the backend can't sign as a user's key. Storing every new key's secret would make the console hold all of them. A Hilt route that presigns as a key would cover only Forge, not FTH or Aurora.

### Auth0 Organizations for picking the org

The [organizations ADR](2026-08-organizations-roles-m1.md) keeps orgs in DynamoDB. With [Auth0 Organizations](https://auth0.com/docs/manage-users/organizations), the picker always offers a personal account, the B2C plan caps them at 10, and every membership would be copied into Auth0.

### Turn on dynamic client registration

It opens an endpoint that creates applications in the tenant, creates a new client on every fresh connection, and the 2025-11-25 MCP spec makes it optional in favour of Client ID Metadata Documents.

## Open questions

- **Request duration.** Which tools could need more than 30 s? A longer tool needs a [Lambda Function URL](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html) behind the Router, or an async job.
- **Client support.** Claude (web and Desktop), Codex CLI and VS Code support Client ID Metadata Documents. Claude Code and ChatGPT need an end-to-end test: Claude Code uses a random loopback port, and ChatGPT defaults to `private_key_jwt`, which Auth0 limits to Enterprise. Auth0's dynamic registration of these clients is Early Access. Without `scopes_supported` in the resource metadata, some clients may not ask for a refresh token.
- **Org selection.** Without a choice, a token acts for the user's home org. Proposed: a [post-login Auth0 Action](https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger/redirect-with-actions), run only for the MCP audience, sends the user to a Fil One org picker and puts the chosen org on the access token as a claim. The backend treats that claim like the console's active-org header, so membership is still checked on every call. To confirm: the claim survives token refresh, and Actions run for these clients. Switching org means authorizing the agent again.

## References

- [MCP specification: authorization (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP specification: transports (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 7591: OAuth 2.0 Dynamic Client Registration](https://www.rfc-editor.org/rfc/rfc7591)
- [OAuth Client ID Metadata Document (IETF draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
- [Auth0: Client ID Metadata Documents](https://auth0.com/docs/get-started/auth0-overview/create-applications/cimd-overview)
- [Auth0: redirect with Actions](https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger/redirect-with-actions)
- [ADR: Organizations and roles, M1](2026-08-organizations-roles-m1.md)
