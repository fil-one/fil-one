# ADR: OpenAPI Client + Auto-Generated Typings

**Status:** Accepted
**Date:** 2026-03-05

## Decision

Use `@hey-api/openapi-ts` to generate a typed API client (with a built-in fetch-based client) from the OpenAPI spec.

## Rationale

### AI-assisted development

Hey API generates named, exported functions with explicit type signatures — far more discoverable by Claude Code than openapi-typescript's string-literal path approach and deeply nested mapped types.

### Lightweight for Lambda

The generated client is a thin wrapper over the native Fetch API (available in Node.js 20+), with no heavy dependencies like Axios. Combined with esbuild tree-shaking, bundle impact is minimal.

### Batteries-included codegen

Generates TypeScript types, SDK functions, and optionally Zod validation schemas from a single `npx @hey-api/openapi-ts` invocation. Plugin architecture supports adding TanStack Query, Valibot, or other integrations later without switching tools.

### Active maintenance with broad adoption

~977K weekly npm downloads, weekly releases through Feb 2026, used in production by Vercel and PayPal. Recommended by FastAPI's official docs for TS client generation.

### Mocking gap is acceptable

Hey API's mock plugins (MSW, Faker, etc.) are not yet shipped. For Lambda integration tests, mocking `fetch` directly with Vitest is sufficient. If richer mock generation becomes critical, Orval is the fallback option.

## Risks

### Hey API is pre-1.0

Mitigations: pin exact versions, re-test on upgrades, expect occasional breaking changes.

## Alternatives Considered

### openapi-typescript + openapi-fetch

Smallest possible runtime (~6 KB), zero-dependency type generation, and the highest npm download count in this space (~2.5M/week). However, its types-only approach means API endpoints are addressed by URL string literals, not named functions. This makes the codebase harder for Claude Code to navigate and for developers to discover endpoints via autocomplete. Ideal if bundle size were the sole priority, but the DX tradeoff wasn't worth the few KB saved.

### Orval

The most mature full-featured generator with a key advantage: built-in MSW mock handler and Faker.js test data generation out of the box. Strong TanStack Query integration and a stable v8 API. We decided against it because its function output is less cleanly greppable than Hey API's, and our mocking needs are modest enough to handle with Vitest's `fetch` mocking. Orval remains the fallback if mock generation becomes a higher priority.

### OpenAPI Generator (typescript-fetch)

Largest project by GitHub stars (~25K) and the only option supporting multi-language SDK generation. Rejected for three reasons: it requires a Java runtime (JDK 11+) in the build pipeline, its class-based output prevents tree-shaking (importing one endpoint pulls in all endpoints in that API class), and it carries ~5,000 open issues making it difficult to gauge bug-fix status. Poor fit for size-sensitive Lambda deployments.

### Swagger Codegen

Legacy project from which OpenAPI Generator forked in 2018. Still receives maintenance patches but is not recommended for new TypeScript projects. No advantages over any of the above.
