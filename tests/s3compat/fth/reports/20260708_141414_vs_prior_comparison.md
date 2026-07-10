# S3 API Comparison — New (2026-07-08) vs Prior Runs

| Field           | Value                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| New runs        | upload `20260708_140206`, fetch `20260708_141414`, delete `20260708_140131`, presign `20260708_134748` |
| Prior baselines | upload `20260219_143221`, presign `20260421_155757`                                                    |
| Provider        | `fth`                                                                                                  |

> ⚠️ **Caveat:** endpoint and bucket changed between runs, so these are trend comparisons, not strict apples-to-apples. Upload: `filecoin-foundation-bucket-nolock` (Feb) → `us-ceph-bucket-1` behind `Caddy`/Ceph (Jul). Presign: `us-east-1.fortilyx.com` / `filone-mbajtos-04-21` (Apr) → `us-east-1.s3.fil.one` / `us-ceph-bucket-1` (Jul).

## Headline

| Suite   | Prior                       | New                               |       Trend       |
| ------- | --------------------------- | --------------------------------- | :---------------: |
| Upload  | `20260219_143221`: 5/5 OK   | `20260708_140206`: 2/5 OK, 3 fail | 🔴 **Regression** |
| Presign | `20260421_155757`: 11/23 OK | `20260708_134748`: 20/24 OK       |  🟢 **Improved**  |
| Fetch   | _(no prior report)_         | `20260708_141414`: 6/6 OK         |  🆕 New coverage  |
| Delete  | _(no prior report)_         | `20260708_140131`: 2/2 OK         |  🆕 New coverage  |

---

## 🔴 Upload — regression on large objects

Same five source objects in both runs. Small objects still succeed; the three ~21 MB `.zip` files went from fast success to `BadDigest` failure after 4 retries.

| Key (suffix)                      |    Size | Feb `143221`          | Jul `140206`            |
| --------------------------------- | ------: | --------------------- | ----------------------- |
| `README.md`                       |  5.5 KB | ✅ 1.08s              | ✅ 2.05s                |
| `-511-event-extents-6f436/v1.zip` |  740 KB | ✅ 1.62s              | ✅ 3.52s                |
| `…ex-0397e/v1.zip`                | 21.0 MB | ✅ 3.22s              | ❌ BadDigest (260.1s)   |
| `…ex-54c47/v1.zip`                | 21.1 MB | ✅ 2.26s              | ❌ BadDigest (239.1s)   |
| `…ex-aa506/v1.zip`                | 21.1 MB | ✅ 2.26s              | ❌ BadDigest (185.5s)   |
| **Totals**                        |         | **5/5 OK, avg 2.09s** | **2/5 OK, avg 138.05s** |

**Observations**

- **Reproducible**: the _earlier_ same-day July run (`20260708_134902`) shows the identical 2/5 result with `BadDigest` on the same three files — not a transient blip.
- **Size-gated**: everything ≤ 740 KB passes; everything ~21 MB fails → points at the **multipart** checksum path (server-computed digest ≠ client-sent digest).
- **Latency exploded**: 21 MB objects went from ~2–3 s to 185–266 s (4 retries each before giving up).
- **New infra in the failure path**: responses carry `via: 1.1 Caddy` and Ceph-style request IDs, absent in the Feb run. The Caddy proxy + Ceph backend combination is the prime suspect for altering/mis-hashing the multipart body.
- Note: an even older Feb run (`20260219_141454`) failed 5/5 too, but with different errors (`InvalidRequest` / `SSLError` against `gw.future-tech-holdings.com`) — a _different_ problem on since-retired infra.

**Action:** reproduce with one ~21 MB object; capture whether the client sends a whole-object `Content-MD5` while streaming a multipart/chunked body, and whether Caddy re-chunks or mutates the payload.

---

## 🟢 Presign — broad improvement, one narrow issue remains

| Metric                              | Apr `155757`        | Jul `134748`                       |
| ----------------------------------- | ------------------- | ---------------------------------- |
| Total / OK / Failed                 | 23 / 11 / 12        | 24 / 20 / 3 (+1 skipped)           |
| Preflight (PUT, DELETE)             | ❌ 403 both         | ✅ pass both                       |
| Execute GET / DELETE / GetRetention | ❌ 401 Unauthorized | ✅ pass (retention = accepted 400) |
| `Access-Control-Allow-Origin`       | ❌ empty            | ✅ `https://app.fil.one`           |
| Response-CORS checks passing        | 0 / 7               | 4 / 7                              |

**What got fixed:** the whole auth+preflight pipeline. In April, presigned executes returned **401 Unauthorized** and preflights were **403** with no CORS origin at all; now presigned URLs authenticate, preflights are permitted, and `etag`/`content-length` are exposed.

**What remains (3 failures):** `response_cors` on `getObject`, `headObject`, `headObjectFilMeta` — `Access-Control-Expose-Headers` still omits:

| Operation                         | Missing (Apr)                                                | Missing (Jul)                          |
| --------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| `response_cors_getObject`         | etag, content-length, content-type, last-modified            | content-type, last-modified            |
| `response_cors_headObject`        | etag, content-length, content-type, last-modified            | content-type, last-modified            |
| `response_cors_headObjectFilMeta` | etag, content-length, content-type, last-modified, x-fil-cid | content-type, last-modified, x-fil-cid |

The remaining gap is a **strict subset** of April's — real progress, same root cause (expose-headers list incomplete for GET/HEAD).

**Also new:** `bucket_cors_read_pre` is now _skipped_ on `AccessDenied` (April got `NoSuchCORSConfiguration`) — the test principal lacks `s3:GetBucketCors`.

**Action:** add `Content-Type`, `Last-Modified` (and `x-fil-cid` on the Fil-meta path) to the bucket's `Access-Control-Expose-Headers`.

---

## 🆕 Fetch & Delete — new coverage, both green

No prior `fetch` or `delete` reports exist, so these are new to the suite. Both passed cleanly:

- **Fetch** (`20260708_141414`): 6/6 OK — `head_object`, `get_object_preview`, `list_versions` across 2 keys, all sub-600 ms.
- **Delete** (`20260708_140131`): 2/2 OK — `delete_object`, 0.33s / 0.63s.

Treat these as the **baseline** for future comparisons.

---

## Net Assessment

|                         | Status                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| Presign auth/CORS       | **Materially better** — 401/403 pipeline failures resolved          |
| Upload of large objects | **Newly broken** — `BadDigest` on multipart, likely Caddy/Ceph path |
| Fetch / Delete          | **Green** — new baselines established                               |

**Top priority:** the upload `BadDigest` regression — it's the only data-loss-adjacent failure and it's new since the last known-good upload run.

## Source Files

| Suite   | New report                                  | Prior report                                 |
| ------- | ------------------------------------------- | -------------------------------------------- |
| Upload  | `20260708_140206_upload_report.md`          | `20260219_143221_upload_report.txt`          |
| Presign | `20260708_134748_console_presign_report.md` | `20260421_155757_console_presign_report.txt` |
| Fetch   | `20260708_141414_fetch_report.md`           | —                                            |
| Delete  | `20260708_140131_delete_report.md`          | —                                            |
