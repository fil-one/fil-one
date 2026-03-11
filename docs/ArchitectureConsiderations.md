# Fil.one General Architecture

## Business Requirements

PRD: https://docs.google.com/document/d/1aCCJbe9WF-HZlkn3I5QUdjasVN8eJs1PDQ8qH8lWUIA/edit?tab=t.0

UI Mocks: https://www.figma.com/design/Keny3r8U9iZyBjJU2pyLgU/Web2-Pod-Product?node-id=80-2371&t=zi1VEqYHFysbOW5c-1

High Level Data Flow: https://miro.com/app/board/uXjVGBRbr7E=/?focusWidget=3458764659528385541

## Development Assumptions & Needs

- local testing for UI + API layer(s)
- Replication of stacks with Terraform (for duplication amongst community and selves with integration environment)
- Database - either Postgres or DynamoDB - For Authorization info, customer metadata, Stripe info, etc.
- Secure key storage - API Keys, Customer/bucket-specific Encryption Keys
- Stripe for payments.
- API Layer for onramp providers (which can be open sourced)
- Second non-open sourced API Layer for our specific Integrations (stripe, Key management, authZ, encryption keys)
- Third open sourced layer for S3Client Compatibility. Alternatively consider this being a part of client or the Onramp provider layer.
- Glacier Backups in case of emergencies?
- Access to logs for Paul and others - Ken says AWS Session manager with pass-thru creds via Okta. Also suggested
- Use AWS - if we want GCP, we can use equivalent services to what I suggest below.
- Use a non-egress charging provider for the S3 compatibility layer.
- Lots of AB Testing - AB Solutions - Maybe just language and no need for proper solution.
- Ideally PDP and PoRep pipeline fan-out.
- Not discussed in depth here:
  - See EncryptionKeyManagement.md for thoughts on ways to encrypt user data without egress through AWS.
  - See S3Considerations.md for thoughts on ways to enable S3 SDK and CLI for Filecoin storage.
  - See Authentication.md for Auth portal/services to consider
  - See StripeIntegrationConsiderations.md for stripe specific info.

### Unknowns + Open questions

- How do Onramps do access control? How do they differ?
- CI/CD Tools?
- Backend Language used by community?
- metrics and monitoring (outside general owned-infra monitoring)
- How to track proof status? Polling the onramp API, webhooks, events? May be specific to onramps.
- Do we need to handle Onramp failures?
- Big tension between egress cost (hundreds of TB of data leaving AWS or other common providers will cost too much) vs ease of onboarding for customer (limits what we can do client side).

## Backend Tech Choices

### Core:

- CDN for JS/CSS assets (cloudfront), maybe HTML if not using SSR - See below Frontend Tech Choices.
- Docker compose for packaging of runtime for both ease of local development and deployments in a repeatable way
  - One for Our "private" APIs - Serving web pages if using SSR, APIs for payment flows and other CRUD operations against our owned data.
  - Another for the Fil.one Unified Onramp interface API and/or S3 Gateway API - Future OSS.
- Kubernetes and AWS EKS for compute.
-

### Code level needs (and questions)

- What language to use on backend? Seeing a lot in Go -- is this what is supported most by community? Could consider Typescript for our specific APIs tied to the UI Console since it gives easy affordance for enforcing API contracts with Typescript shared interfaces (assuming we deploy together).
- If using different language in backend and frontend, consider some sort of lib to create API Contracts by auto generating typescript client to break at build time rather than runtime. This helps AI write code, too.
- Middleware library for enforcing Authentication, Authorization, and Payments across API endpoints
- Simple web app library like express.js but in whatever language we use.

## Frontend Tech

- Language: Typescript for use with React and ease of integration with existing UI Libs
- [UI Library](https://github.com/FilecoinFoundationWeb/filecoin-foundation/tree/main/packages/ui-filecoin) (pull in via NPM)
- Vite for bundling and local testing?
- Vercel vs AWS -
- HTTP-Only cookies for refresh, identity, access tokens.
- Consider [Tanstack Query](https://tanstack.com/query/latest) for API with backend.
-

Main question: Do we want serverside rendering (SSR) or a single page app?

## SSR

Pros:

- SSR enables better structural SEO, especially with regard to AI search clients who generally are not inflating JS. We can add SEO schemas, and other head metadata easily that are page specific.
- Faster for first render of meaningful, user specific data since an internal DB hit is much faster than API call after JS loads.

Cons:

- Need compute like lambda@edge for doing the rendering.
- HTML not cacheable since has user specific data. (Not a big deal for this)

If we do go with SSR, I like to use lightweight frameworks or templating engines. I don't like the complexity and security tradeoffs of React Server Components without clear value add. Less libraries and frameworks == less maintenance requirements, too.

## SPA

Pros:

- No Compute needed - simpler to create, serve, and cache. Static HTML can serve as entry point into entire app.
- If hosting multiple different, public facing pages, we can have multiple static HTML files with SEO and other structural elements.
- Opens up frontend frameworks for reacty tools like routing libraries

Cons:

- Lack of structural SEO elements that are dynamic which is worse for AI search engines in particular that _generally_ do not inflate JS.

**Recommendation**: SPA approach unless we want to support dynamic, public pages. 2-way door and can move to SSR later if we need.

## Vercel/Next.js

Vercel if we want to use next.js. The framework has all the tools we need. Downside is it has a lot of tools. More tools means more potential issues: more surface area for forcing version bumps (certain versions of libs requiring other versions) as well as security issues ([ex](https://nextjs.org/blog/CVE-2025-66478)).

Data we are handling is critical files in the frontend console since these files really can be anything. We also will be handling plaintext encryption keys (can do so via a web worker).

### Vercel

## Database

### Constraints

- Same code in local dev (Docker Compose with `postgres:16` container) as in production — no local-only emulators with behavioral differences
- Accessed primarily from API services (EKS pods in AWS path, or serverless functions in Vercel path)
- Must support: user accounts, file/bucket metadata, billing records, API keys, audit logs, encryption key references (wrapped DEKs)

### Why PostgreSQL

Regardless of hosting, PostgreSQL is the right engine:

- Runs in a Docker container locally — identical SQL dialect, drivers, and behavior as production
- Every managed offering below is wire-compatible with standard PostgreSQL
- Rich data types (JSONB for flexible metadata, arrays, full-text search) reduce the need for supplementary datastores
- Application code, queries, and migrations are identical across all options below

### AWS Database Options (EKS Fargate)

#### 1. Amazon RDS PostgreSQL (Starting here)

Managed PostgreSQL. You pick the instance size, AWS handles patching, backups, failover.

- Local dev: `postgres:16` Docker image in docker-compose — identical behavior
- Connection from EKS: standard PostgreSQL connection string, pods connect over VPC internal networking
- Pros: Simple, well-understood, cheapest managed option, read replicas available
- Cons: Fixed instance size (you pay for provisioned capacity even when idle), manual scaling
- Cost: ~$50-150/mo for a small instance (db.t4g.medium)

#### 2. Amazon Aurora PostgreSQL (Use this possibly for prod or when we have more traffic)

AWS-enhanced PostgreSQL with better replication, failover, and storage auto-scaling. Wire-compatible with PostgreSQL — your code doesn't change.

- Local dev: Same `postgres:16` Docker image — Aurora-specific features (storage, replication) are transparent to the application
- Connection from EKS: same PostgreSQL connection string
- Pros: Automatic storage scaling, faster failover (30s vs minutes for RDS), up to 15 read replicas, better I/O performance
- Cons: ~20% more expensive than RDS for equivalent instance, minimum cost higher
- Cost: ~$60-200/mo starting

#### 3. Aurora Serverless v2 (Probably not this)

Aurora with compute that scales based on load, including down to a minimum ACU (Aurora Capacity Unit).

- Local dev: Same `postgres:16` Docker image
- Connection from EKS: same PostgreSQL connection string
- Pros: Scales with traffic (good for variable load), no instance size decisions, can scale to near-zero
- Cons: Cost per ACU-hour can exceed provisioned Aurora if load is constant, minimum 0.5 ACU (~$43/mo) even when "idle"
- Best for: Unpredictable traffic patterns, early-stage when you don't know your load profile

While we might have unpredictable traffic at first, we likely don't need super high throughput on this at first. We can consider it later iff regular Aurora is not working out.

#### Connection Pooling Note (AWS)

EKS pods maintain persistent connections — standard PostgreSQL connection pooling (via your ORM or a pool library) works fine. If you scale to many pods, add PgBouncer as a sidecar or use RDS Proxy (~$15/mo extra) to avoid exhausting database connections.

### Vercel Database Options

If Vercel serverless functions need direct DB access (BFF session lookups, SSR data fetching), there is a key challenge:

**Serverless Connection Problem:** Vercel functions are ephemeral — each invocation may spin up a new execution context. Traditional persistent database connections don't work because each invocation opens a new connection and connection limits get exhausted quickly at scale. You need either an HTTP-based database driver or a connection pooler in front of the database.

#### 1. Neon / Vercel Postgres (Recommended with Vercel)

Neon is serverless PostgreSQL with an HTTP-based query interface and a WebSocket-based driver for edge runtimes. Vercel Postgres is Neon with Vercel billing.

- Local dev: Same `postgres:16` Docker image — use the standard `pg` driver locally, Neon's `@neondatabase/serverless` driver in production (same SQL, same queries, driver swap is config-level)
- Pros: Built for serverless (no connection pooling headaches), scales to zero, branching (create DB branches for preview deployments), generous free tier
- Cons: Additional vendor, may have slightly different performance characteristics than RDS/Aurora at high throughput
- Cost: Free tier is generous, paid starts ~$19/mo

#### 2. Connect Vercel to AWS Aurora/RDS

Keep the database in AWS and have Vercel functions connect to it remotely.

- Requires RDS Proxy or PgBouncer to pool connections (serverless functions will exhaust connection limits otherwise)
- Higher latency: Vercel edge → public internet → AWS VPC → RDS (~20-50ms added per query vs <1ms within VPC)
- Pros: Single database for everything, no data sync issues
- Cons: Cross-network latency, need connection pooling infrastructure, more complex networking (VPC peering or public endpoint with TLS)

#### 3. Supabase

Hosted PostgreSQL with built-in connection pooling (Supavisor), auth, realtime subscriptions, and a REST/GraphQL auto-generated API.

- Local dev: `supabase start` runs the full stack in Docker (PostgreSQL + pooler + API)
- Pros: Serverless-friendly connection pooling built in, auto-generated REST API reduces boilerplate, local dev story is excellent
- Cons: Opinionated — brings its own auth and API layer which may overlap/conflict with your other choices

### Database Recommendation

| Scenario                                       | Database                                                                        | Reasoning                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| AWS-only (EKS)                                 | Start with RDS PostgreSQL, move to Aurora when scaling                          | Simplest, cheapest, same code locally and in prod               |
| Vercel + EKS (DB only accessed from EKS)       | Same as above — Vercel doesn't touch the DB                                     | Vercel is just the frontend/BFF, API pods handle all DB access  |
| Vercel + EKS (Vercel functions need DB access) | Neon for Vercel functions + RDS/Aurora for EKS, OR single Aurora with RDS Proxy | Two-DB approach is cleaner but requires data sync consideration |
| Vercel-only (no EKS)                           | Neon / Vercel Postgres                                                          | Purpose-built for serverless                                    |

### ORM / Query Layer

To ensure code portability across all options, use an ORM or query builder that speaks standard PostgreSQL:

- **Drizzle ORM** — lightweight, TypeScript-native, generates SQL close to what you'd write by hand, supports both `pg` and `@neondatabase/serverless` drivers via config swap
- **Prisma** — more opinionated, great migration tooling and type generation, larger community, slightly heavier runtime
- **Kysely** — type-safe query builder (not a full ORM), minimal abstraction, good if you prefer writing SQL-ish code

Any of these ensure that queries and schema are identical between local Docker PostgreSQL and whatever managed service is used in production. The driver/connection config is the only thing that changes per environment.

### Migration Strategy

Regardless of ORM choice:

- Migrations live in the repo as versioned SQL or ORM migration files
- `docker-compose up` runs pending migrations against local PostgreSQL automatically
- CI/CD runs the same migrations against the production database before deploying new code
- This is a solved problem with any of the ORMs above (Prisma Migrate, Drizzle Kit, etc.)
