# @filone/rag-engine

Bucket Intelligence for Forge regions (`eu-central-3`, `us-east-9`). The engine
runs as a container on the Forge appliance. It keeps each bucket's index as a
Lance dataset in a companion bucket on the tenant's own Forge storage, embeds
text with an OpenAI-compatible embeddings server running next to it, and writes
answers with Anthropic or any OpenAI-compatible chat endpoint. Other regions
keep the Lambda and S3 Vectors pipeline.

The wire contract with the console backend is
`packages/shared/src/api/rag-engine.ts`.

## How it works

- **No AWS, no database.** Every request carries the tenant's Forge S3
  endpoint, region and static key (`target.s3`). The engine reads source
  objects with it and keeps the dataset at
  `s3://filone-rag-<hash>/lance/chunks.lance`, where the hash is the first 40
  hex characters of sha256(`orgId#region#bucketName`). It creates the companion
  bucket on the first sync that has something to index. A sync of an unchanged
  bucket only reads; it rewrites the engine state at most once an hour.
- **The dataset describes itself.** Each row is one chunk: `objectKey`, `etag`,
  `objectSize`, `chunkIndex`, `text`, `vector`. A sync lists the source bucket,
  compares ETags with the dataset, indexes new and changed objects and removes
  deleted ones. Chunks of a changed object replace the old ones in a single
  commit (merge-insert). Commits are batched (`ENGINE_FLUSH_ROWS`, 1500 chunks).
- **Indexes.** The first commit creates the table and a full-text (BM25) index
  on `text`. Once the table has `ENGINE_VECTOR_INDEX_MIN_ROWS` rows (256), a
  sync builds an `IVF_HNSW_SQ` cosine index; below that, vector search is an
  exact flat scan and the trace says `flat`. Every sync ends with
  `optimize()`, which compacts fragments and folds new rows into the indexes.
  A sync that finds an index missing (an earlier sync stopped between its data
  and index commits) builds it even when no object changed. The full-text index
  stores token positions, so a query wrapped in double quotes runs as a phrase
  search; a sync replaces a full-text index built without positions.
- **Versions.** Every commit is a Lance version, and `/v1/query` takes
  `version` to search the dataset as it was. Each sync tags the version it
  finished at (`sync-20261105T100000.123Z`). `/v1/versions` lists the tagged
  versions plus the latest; the commits in between are partial sync states, and
  the first has no full-text index. The newest 30 sync tags are kept. Lance
  prunes untagged versions older than 7 days during `optimize()`.
- **Query traces.** Timings cover the request as served. `trace.io` comes from
  Lance's analyzed plan, which runs the search a second time after the timed
  one: it reflects a warm cache and is not part of `totalMs`. Hybrid search
  reports no I/O.
- **Answers are best effort.** The answer call has a 25 s budget. If it fails
  or times out, the query still returns its citations with an empty `answer`.
- **Reads never write.** Status, versions and queries only list and read.
- **Engine state.** `lance/engine-state.json` next to the dataset records when
  the last sync finished, the embedding model, and objects that produced no
  text (so they are not re-read until they change). Sync progress lives in
  memory; one container serves all tenants.
- **Commits need conditional PUT** (`If-None-Match: *`). Forge Ingot supports
  it; a provider that refuses it fails the sync, and reads keep working. A
  first commit that failed leaves data files without a manifest; the next sync
  writes over them.
- **Errors.** `lastSyncError` and `500` bodies carry a short summary, with a
  stable prefix for the common causes (`CONDITIONAL_WRITE_REFUSED`,
  `ACCESS_DENIED`, `BUCKET_NOT_FOUND`, `COMPANION_BUCKET_TAKEN`). The full
  error goes to the engine log.

## Routes

All `/v1/*` routes are `POST` with a JSON body and need
`Authorization: Bearer $ENGINE_TOKEN`. `GET /healthz` is open.

| Route          | Body                    | Response                                                                |
| -------------- | ----------------------- | ----------------------------------------------------------------------- |
| `/v1/sync`     | `{ target }`            | 202, `RagEngineStatus`; starts a sync unless one is running             |
| `/v1/status`   | `{ target }`            | `RagEngineStatus`                                                       |
| `/v1/versions` | `{ target }`            | `RagEngineVersionsResponse`, newest first                               |
| `/v1/query`    | `RagEngineQueryRequest` | `RagEngineQueryResponse`                                                |
| `/v1/drop`     | `{ target }`            | `{ dropped: boolean }`; deletes the dataset, state and companion bucket |

Errors are `{ error: { code, message } }`: `400 BAD_REQUEST`/`BAD_JSON`,
`401 UNAUTHORIZED`, `404 VERSION_NOT_FOUND`, `409 NOT_INDEXED`,
`409 NO_FULLTEXT_INDEX` (a version from before the full-text index),
`409 NO_PHRASE_INDEX` (a quoted phrase against a version whose full-text index
has no token positions), `500 INTERNAL`.

## Configuration

| Variable                            | Default                                                |                                                     |
| ----------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `ENGINE_TOKEN`                      | required                                               | Shared bearer token                                 |
| `ENGINE_PORT`                       | `8080`                                                 |                                                     |
| `ENGINE_S3_ENDPOINT_OVERRIDE`       | unset                                                  | `region=url` pairs, comma-separated; see below      |
| `EMBEDDING_BASE_URL`                | required                                               | OpenAI-compatible base URL, e.g. `http://tei:80/v1` |
| `EMBEDDING_MODEL`                   | `BAAI/bge-small-en-v1.5`                               |                                                     |
| `EMBEDDING_API_KEY`                 | unset                                                  |                                                     |
| `EMBEDDING_BATCH_SIZE`              | `32`                                                   |                                                     |
| `ANSWER_PROVIDER`                   | `anthropic` if `ANTHROPIC_API_KEY` is set, else `none` | `anthropic`, `openai-compatible` or `none`          |
| `ANTHROPIC_API_KEY`                 | unset                                                  |                                                     |
| `ANSWER_MODEL`                      | `claude-opus-5-5` for Anthropic                        | Required for `openai-compatible`                    |
| `ANSWER_BASE_URL`, `ANSWER_API_KEY` | unset                                                  | For `openai-compatible`                             |
| `ENGINE_VECTOR_INDEX_MIN_ROWS`      | `256`                                                  |                                                     |
| `ENGINE_FLUSH_ROWS`                 | `1500`                                                 |                                                     |
| `ENGINE_MAX_OBJECT_BYTES`           | `67108864`                                             | Larger objects are skipped                          |

With no answer provider, queries return citations and an empty `answer`.

`ENGINE_S3_ENDPOINT_OVERRIDE` replaces `target.s3.endpointUrl` for the named
regions only, for example `eu-central-3=http://127.0.0.1:15200` on the
appliance that runs that region's Ingot. Other regions use the endpoint the
console sends. `*=url` overrides every region and suits a local engine talking
to one Ingot. A bare URL is refused, because on a stage with both Forge regions
it would send one region's requests to the other region's gateway.

## Running locally against smelt

```sh
# Forge network (fil-forge/smelt)
INGOT_REGION=us-east-9 make up && make s3-key

# Engine + embedding server (on Apple silicon add
# TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-1.9)
docker compose -f packages/rag-engine/docker-compose.local.yml up -d --build

# End-to-end check: uploads documents, syncs, queries all modes, changes and
# deletes a document, re-syncs, and queries a past version
RAG_ENGINE_E2E=1 node packages/rag-engine/scripts/e2e-smelt.ts
```

The same dataset opens from Python with the tenant's key:

```python
import lancedb
db = lancedb.connect("s3://filone-rag-<hash>/lance", storage_options={
    "aws_endpoint": "http://127.0.0.1:15130", "aws_region": "us-east-9",
    "aws_access_key_id": "<key>", "aws_secret_access_key": "<secret>",
    "aws_virtual_hosted_style_request": "false", "allow_http": "true"})
db.open_table("chunks").search("forge", query_type="fts").limit(3).to_pandas()
```

## Tests

`pnpm --filter @filone/rag-engine test` runs the engine over HTTP against an
in-process S3 server (`src/testing/test-s3-server.ts`) with a deterministic
embedder: sync add/change/delete, batching, the three search modes, versions
and time travel, reads that never write, the conditional-PUT requirement, auth
and request validation.
