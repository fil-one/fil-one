# ADR: Client-Side Caching

**Status:** Accepted
**Date:** 2026-04-01

## Context

The SPA makes repeated API calls on every mount with no caching layer. The current pattern in each page component is a `useEffect` + three state variables (`loading`, `error`, `data`) backed by direct `apiRequest()` calls. This has two concrete problems:

1. **High-frequency endpoints** (e.g. `GET /api/me`) are called on every route navigation with no reuse.
2. **List views** (e.g. `GET /api/buckets`) show a spinner on every visit, even when the data from a few seconds ago is good enough to render immediately.

Additionally, auth state changes — email verification, MFA enrollment/removal — require invalidating the `getMe` cache so the SPA reflects the new token claims without a hard reload.

## Options Considered

### SWR

Lightweight (~4 kB), built around the stale-while-revalidate pattern. Handles background revalidation and deduplication well. Mutations are just async functions paired with a `mutate()` call — workable but not a first-class primitive. Weaker devtools, less granular cache control compared to TanStack Query.

### TanStack Query

Richer feature set: `useQuery`, `useMutation`, `queryClient.invalidateQueries`, and separate `staleTime`/`gcTime` controls. The `staleTime`/`gcTime` distinction is directly useful — it lets a query serve stale data immediately while refetching in the background, which is the exact pattern needed for list views. `invalidateQueries` provides targeted, event-driven cache busting for auth state changes. DevTools are available as an optional install (`@tanstack/react-query-devtools`) and can be added in development if cache debugging becomes useful. (~13 kB, not a concern at this scale.)

Critically: the project already uses **TanStack Router**. Using TanStack Query keeps the data-fetching layer in the same ecosystem, with consistent mental models and tooling.

## Decision

Use **TanStack Query** (`@tanstack/react-query`) as the client-side caching and async state layer.

A `QueryClientProvider` is added at the root (alongside the existing `ToastProvider`). The existing `apiRequest()` function in `src/lib/api.ts` is used as-is as the `queryFn` — no changes to the API layer are required.

## Access Patterns

### `getMe` — time-bounded cache, invalidated on auth events

`GET /api/me` is called on every app route navigation today. With TanStack Query it is fetched once and cached for 10 minutes, well within the 1-hour Auth0 access token lifetime. On re-navigation within that window the cached value is returned immediately with no network call.

```ts
useQuery({
  queryKey: ['me'],
  queryFn: getMe,
  staleTime: 10 * 60_000, // 10 minutes — safe within the 1-hour token lifetime
});
```

Cache is invalidated early in response to auth state changes:

| Event                        | Action                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Email verified               | `queryClient.invalidateQueries({ queryKey: ['me'] })`                                                |
| MFA enrolled or removed      | `queryClient.resetQueries({ queryKey: ['me'] })` — hard reset because the Auth0 token itself changes |
| Profile updated (name/email) | `queryClient.invalidateQueries({ queryKey: ['me'] })`                                                |

`invalidateQueries` marks the entry stale and triggers a background refetch. `resetQueries` removes the entry entirely, forcing a fresh fetch on next access — used when the underlying token changes and stale data must not be served.

### Buckets list — stale-while-revalidate

The buckets page should render immediately on re-navigation using whatever was last fetched, while a fresh request runs in the background. When the response arrives, the UI updates automatically.

```ts
useQuery({
  queryKey: ['buckets'],
  queryFn: () => apiRequest<ListBucketsResponse>('/buckets'),
  staleTime: 0, // always stale, so a background refetch fires on every mount
  gcTime: 5 * 60_000, // keep in cache for 5 min so re-navigation renders instantly
});
```

`staleTime: 0` means the cached value is immediately considered stale, so a refetch always fires — but the stale data renders while the request is in-flight. `gcTime` controls how long the cache entry survives when no component is subscribed to it.

After a successful create or delete, the mutation handler calls `queryClient.invalidateQueries({ queryKey: ['buckets'] })` to force a fresh fetch rather than manually splicing the local array.

### Other list endpoints (access keys, objects, usage)

Same `staleTime: 0` / `gcTime: 5min` pattern as buckets. Query keys are scoped by resource and any relevant parameters:

```ts
queryKey: ['access-keys', bucketName];
queryKey: ['objects', bucketName, nextToken];
queryKey: ['usage'];
```

## Consequences

- The `useEffect` + `useState` pattern in page components is replaced by `useQuery`. The `loading` / `error` / `data` state variables collapse into a single hook call.
- `useMutation` replaces inline async handlers for create/delete operations, giving consistent loading and error state for mutations.
- `getMe` is fetched at most once per 10 minutes rather than on every navigation — aligned with the 1-hour Auth0 token lifetime.
- Auth-related events (email verification, MFA changes) must call `invalidateQueries` or `resetQueries` on `['me']` to keep the cached identity current. This is the contract that must be upheld when adding new auth flows.
- The existing `apiRequest()` function and all API types remain unchanged.
