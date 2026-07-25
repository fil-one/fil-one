# RAG vector store: brute force vs a vendored index

Status: **open question**, spike complete. Nothing here is decided.

## Context

FIL-613 moves the RAG index off the central AWS S3 Vectors bucket and into a
per-bucket companion bucket on the tenant's own provider. PR #506 implements
that with `BucketObjectVectorStore`: one JSON blob per source object holding
that object's chunks, their text, and base64 float32 embeddings.

There is no index. A query with no `objectKey` filter lists the companion
bucket, GETs every blob at concurrency 16, and brute-forces a dot product.

## The problem

Measured, not estimated — both stores writing to and reading from the same
S3-compatible server, 10,000 chunks (~10 MB of extracted text, roughly 3,000
pages), `k=10`:

|                           | bytes per query | requests | index write |
| ------------------------- | --------------- | -------- | ----------- |
| `BucketObjectVectorStore` | 65.64 MB        | 501      | 0.9 s       |
| `LanceVectorStore`        | 2.21 MB         | 101      | 4.2 s       |

Reproduce with:

```
RAG_SPIKE=1 N=10000 pnpm --filter @filone/rag-shared exec vitest run spike/lance-probe.test.ts
```

65 MB per query is tenant-billed egress that does not amortise — it is paid
again on every query. It scales linearly, so the ticket's stated ceiling of
20–40k chunks is 130–260 MB per query. Round trips scale with source object
count rather than chunk count, so latency has two independent terms.

The obvious response — pack the vectors at fixed stride, add a partition layer,
range-read only the probed partitions — is the beginning of writing a vector
database: centroid training, rebalancing under drift, deletes and updates within
partitions, recall tuning. That is the surface S3 Vectors provided and we would
own it indefinitely.

## What the spike establishes

`LanceVectorStore` (`packages/rag-shared/src/lance-vector-store.ts`) implements
the same `VectorStore` interface, writes to the same companion bucket, and keeps
the same trust boundary — the dataset lives at `s3://<companion bucket>/lance`
on the tenant's provider and region. Only the storage internals differ. 16 tests
cover it, run against a real S3-compatible server over HTTP rather than a local
path, so they exercise the production code path.

**It works against a non-AWS endpoint.** Path-style addressing, custom endpoint,
plain HTTP. The API surface it uses:

```
GET (incl. Range)   PUT   ListObjectsV2   DeleteObjects
CreateMultipartUpload   UploadPart   CompleteMultipartUpload
```

**It requires conditional writes to commit — but only to commit.** Lance writes
each dataset manifest with `If-None-Match: *`, exactly one conditional PUT per
commit (`createTable`, `mergeInsert`, `delete` — one each; `search` makes none).
So:

- the **query path** runs on any S3-compatible provider, conditional support or
  not;
- the **indexer** does not, unless the provider honours `If-None-Match`.

This is asserted by two tests against a server configured to reject conditional
writes: queries succeed, indexing fails on the manifest PUT.

**This is the open question the spike cannot close.** Whether Aurora and FTH
honour `If-None-Match` needs checking against a real endpoint. If one of them
does not, the options are an external commit store (Lance supports one in
Rust/Python; whether it is reachable through the Node bindings is unverified),
or a different vendored format.

## Honest caveats

- **The latency column is not transferable.** Lance's query was _slower_ in
  wall clock here (1.5 s vs 0.5 s), because against a localhost server bytes are
  effectively free — which is the best case for brute force and the worst-case
  framing for an index. Against a remote provider, where 65 MB has to cross a
  network and is billed, the ordering should invert. The byte count is the
  number worth trusting; the latency number needs a real stage.
- **Index build costs more** (4.2 s vs 0.9 s for 10k chunks) and reads the
  dataset back to train. That cost lands on the indexer, not the query path.
- **Cold start is unmeasured.** This adds a Rust native module (~linux-arm64-gnu
  for nodejs24.x) to a Lambda bundle. The query route has no provisioned
  concurrency outside production.
- **Bundling under SST/esbuild is unverified.** The native `.node` binary needs
  to survive bundling or ship as a layer.
- **Dependency constraint.** `@lancedb/lancedb` peers `apache-arrow >=15 <=18.1`;
  the repo's supply-chain trust policy blocks the `@types/node@20` that arrow 18
  pulls, so this branch adds an `@types/node: ^24.12.0` override to the root
  `pnpm.overrides`. That is a real cost of adoption, not a detail.
- **We would still own the policy** — when to rebuild the index as a bucket
  grows — just not its implementation.

## Options

1. **Keep brute force, cap it deliberately.** ~600 lines, no algorithm to
   maintain, no new dependency. Requires choosing and enforcing a corpus limit
   rather than discovering it, and accepting that limit as a product boundary.
2. **Vendor the index (this spike).** Query cost drops ~30x and stops being the
   thing that forces a rewrite. Costs a native dependency and needs the
   conditional-write question answered.
3. **Per-tenant S3 Vectors buckets.** No store to own at all, ANN retrieval,
   and it fixes the cross-tenant blast radius that motivates part of FIL-613.
   Gives up the jurisdiction argument entirely — S3 Vectors cannot follow the
   product to FTH or to a Filecoin SP, which the Forge migration (FIL-562)
   eventually requires.

Option 3 is cheapest if no customer is choosing FilOne specifically because it
is not AWS. That is a product question, not an engineering one, and it should be
answered before either of the other two is built out.
