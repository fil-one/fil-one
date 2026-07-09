# Console Presigned-URL Test

| Field  | Value             |
| ------ | ----------------- |
| Script | `console_presign` |
| Run    | `20260708_134748` |

## Summary

| Total |  OK | Skipped | Failed | Status   |
| ----: | --: | ------: | -----: | :------- |
|    24 |  20 |       1 |      3 | **FAIL** |

## BY OPERATION

| Operation                          |  OK | Failed | Total |    Avg | Stddev |    Min |    Max |
| ---------------------------------- | --: | -----: | ----: | -----: | -----: | -----: | -----: |
| `bucket_cors_read_pre`             |   1 |      0 |     1 |      — |      — |      — |      — |
| `execute_deleteObject`             |   1 |      0 |     1 | 1.131s | 0.000s | 1.131s | 1.131s |
| `execute_getObject`                |   1 |      0 |     1 | 1.025s | 0.000s | 1.025s | 1.025s |
| `execute_getObjectRetention`       |   1 |      0 |     1 | 0.477s | 0.000s | 0.477s | 0.477s |
| `execute_headObject`               |   1 |      0 |     1 | 1.586s | 0.000s | 1.586s | 1.586s |
| `execute_headObjectFilMeta`        |   1 |      0 |     1 | 0.480s | 0.000s | 0.480s | 0.480s |
| `execute_listObjects`              |   1 |      0 |     1 | 0.491s | 0.000s | 0.491s | 0.491s |
| `execute_putObject`                |   1 |      0 |     1 | 1.364s | 0.000s | 1.364s | 1.364s |
| `preflight_deleteObject`           |   1 |      0 |     1 | 0.463s | 0.000s | 0.463s | 0.463s |
| `preflight_putObject`              |   1 |      0 |     1 | 0.473s | 0.000s | 0.473s | 0.473s |
| `presign_deleteObject`             |   1 |      0 |     1 | 0.001s | 0.000s | 0.001s | 0.001s |
| `presign_getObject`                |   1 |      0 |     1 | 0.001s | 0.000s | 0.001s | 0.001s |
| `presign_getObjectRetention`       |   1 |      0 |     1 | 0.002s | 0.000s | 0.002s | 0.002s |
| `presign_headObject`               |   1 |      0 |     1 | 0.001s | 0.000s | 0.001s | 0.001s |
| `presign_headObjectFilMeta`        |   1 |      0 |     1 | 0.000s | 0.000s | 0.000s | 0.000s |
| `presign_listObjects`              |   1 |      0 |     1 | 0.002s | 0.000s | 0.002s | 0.002s |
| `presign_putObject`                |   1 |      0 |     1 | 0.002s | 0.000s | 0.002s | 0.002s |
| `response_cors_deleteObject`       |   1 |      0 |     1 |      — |      — |      — |      — |
| `response_cors_getObject`          |   0 |      1 |     1 |      — |      — |      — |      — |
| `response_cors_getObjectRetention` |   1 |      0 |     1 |      — |      — |      — |      — |
| `response_cors_headObject`         |   0 |      1 |     1 |      — |      — |      — |      — |
| `response_cors_headObjectFilMeta`  |   0 |      1 |     1 |      — |      — |      — |      — |
| `response_cors_listObjects`        |   1 |      0 |     1 |      — |      — |      — |      — |
| `response_cors_putObject`          |   1 |      0 |     1 |      — |      — |      — |      — |

## Run details

```
TEST RUN
  Provider         : fth
  Endpoint         : https://us-east-1.s3.fil.one
  Bucket           : us-ceph-bucket-1
  Test key         : console-presign-test/1ea4e369-a541-40d0-b8cb-43db8c3f2d44/probe.txt
  Browser origin   : https://app.fil.one
  Presign expiry   : 300s
  CORS applied     : no (provider manages CORS out-of-band)

BUCKET CORS CONFIGURATION (before test)
  (cannot read: AccessDenied)
```

## Skipped

- ```json
  {
    "ts": "2026-07-08T11:47:49.236652+00:00",
    "op": "bucket_cors_read_pre",
    "status": "skipped",
    "bucket": "us-ceph-bucket-1",
    "error_code": "AccessDenied",
    "error_message": "An error occurred (AccessDenied) when calling the GetBucketCors operation: Access Denied"
  }
  ```

## Successes

```json
{"ts": "2026-07-08T11:47:49.239581+00:00", "op": "presign_putObject", "status": "ok", "elapsed_s": 0.002, "s3_op": "put_object", "http_method": "PUT", "url_host": "us-east-1.s3.fil.one", "signed_query_contains_fil_meta": false}
{"ts": "2026-07-08T11:47:49.713306+00:00", "op": "preflight_putObject", "status": "ok", "elapsed_s": 0.473, "request_method": "PUT", "request_headers": ["Content-Type", "x-amz-meta-filename"], "status_code": 204, "response_headers_lower": {"access-control-allow-headers": "Content-Type, x-amz-meta-filename", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-max-age": "3600", "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers", "date": "Wed, 08 Jul 2026 11:47:49 GMT"}, "allow_origin": "https://app.fil.one", "allow_methods": ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"], "allow_headers": ["content-type", "x-amz-meta-filename"], "missing_request_headers": [], "status_ok": true, "origin_ok": true, "method_ok": true, "headers_ok": true}
{"ts": "2026-07-08T11:47:51.078649+00:00", "op": "execute_putObject", "status": "ok", "elapsed_s": 1.364, "status_code": 200, "response_headers_lower": {"access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-expose-headers": "ETag, Content-Length, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-delete-marker", "content-length": "0", "date": "Wed, 08 Jul 2026 11:47:49 GMT", "etag": "\"3fa6f61e4062b664e24811f5d6045e9b\"", "vary": "Origin"}}
{"ts": "2026-07-08T11:47:51.079407+00:00", "op": "response_cors_putObject", "status": "ok", "status_code": 200, "allow_origin": "https://app.fil.one", "expose_headers": ["content-length", "etag", "x-amz-delete-marker", "x-amz-id-2", "x-amz-request-id", "x-amz-version-id"], "missing_expose_headers": [], "missing_response_meta_headers": [], "origin_ok": true, "expose_ok": true, "meta_ok": true}
{"ts": "2026-07-08T11:47:51.083637+00:00", "op": "presign_listObjects", "status": "ok", "elapsed_s": 0.002, "s3_op": "list_objects_v2", "http_method": "GET", "url_host": "us-east-1.s3.fil.one", "signed_query_contains_fil_meta": false}
{"ts": "2026-07-08T11:47:51.574770+00:00", "op": "execute_listObjects", "status": "ok", "elapsed_s": 0.491, "status_code": 200, "response_headers_lower": {"access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-expose-headers": "ETag, Content-Length, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-delete-marker", "content-length": "635", "content-type": "application/xml", "date": "Wed, 08 Jul 2026 11:47:50 GMT", "vary": "Origin"}}
{"ts": "2026-07-08T11:47:51.575619+00:00", "op": "response_cors_listObjects", "status": "ok", "status_code": 200, "allow_origin": "https://app.fil.one", "expose_headers": ["content-length", "etag", "x-amz-delete-marker", "x-amz-id-2", "x-amz-request-id", "x-amz-version-id"], "missing_expose_headers": [], "missing_response_meta_headers": [], "origin_ok": true, "expose_ok": true, "meta_ok": true}
{"ts": "2026-07-08T11:47:51.580153+00:00", "op": "presign_headObject", "status": "ok", "elapsed_s": 0.001, "s3_op": "head_object", "http_method": "HEAD", "url_host": "us-east-1.s3.fil.one", "signed_query_contains_fil_meta": false}
{"ts": "2026-07-08T11:47:53.166335+00:00", "op": "execute_headObject", "status": "ok", "elapsed_s": 1.586, "status_code": 200, "response_headers_lower": {"access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-expose-headers": "ETag, Content-Length, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-delete-marker", "content-length": "41", "content-type": "text/plain", "date": "Wed, 08 Jul 2026 11:47:51 GMT", "etag": "\"3fa6f61e4062b664e24811f5d6045e9b\"", "last-modified": "Wed, 08 Jul 2026 11:47:50 GMT", "vary": "Origin", "x-amz-meta-filename": "probe.txt"}}
{"ts": "2026-07-08T11:47:53.167695+00:00", "op": "presign_headObjectFilMeta", "status": "ok", "elapsed_s": 0.0, "s3_op": "head_object", "http_method": "HEAD", "url_host": "us-east-1.s3.fil.one", "signed_query_contains_fil_meta": true}
{"ts": "2026-07-08T11:47:53.647827+00:00", "op": "execute_headObjectFilMeta", "status": "ok", "elapsed_s": 0.48, "status_code": 200, "response_headers_lower": {"access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-expose-headers": "ETag, Content-Length, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-delete-marker", "content-length": "41", "content-type": "text/plain", "date": "Wed, 08 Jul 2026 11:47:52 GMT", "etag": "\"3fa6f61e4062b664e24811f5d6045e9b\"", "last-modified": "Wed, 08 Jul 2026 11:47:50 GMT", "vary": "Origin", "x-amz-meta-filename": "probe.txt"}}
{"ts": "2026-07-08T11:47:53.652971+00:00", "op": "presign_getObject", "status": "ok", "elapsed_s": 0.001, "s3_op": "get_object", "http_method": "GET", "url_host": "us-east-1.s3.fil.one", "signed_query_contains_fil_meta": false}
{"ts": "2026-07-08T11:47:54.678120+00:00", "op": "execute_getObject", "status": "ok", "elapsed_s": 1.025, "status_code": 200, "response_headers_lower": {"access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-expose-headers": "ETag, Content-Length, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-delete-marker", "content-length": "41", "content-type": "text/plain", "date": "Wed, 08 Jul 2026 11:47:53 GMT", "etag": "\"3fa6f61e4062b664e24811f5d6045e9b\"", "last-modified": "Wed, 08 Jul 2026 11:47:50 GMT", "vary": "Origin", "x-amz-meta-filename": "probe.txt"}}
{"ts": "2026-07-08T11:47:54.683938+00:00", "op": "presign_getObjectRetention", "status": "ok", "elapsed_s": 0.002, "s3_op": "get_object_retention", "http_method": "GET", "url_host": "us-east-1.s3.fil.one", "signed_query_contains_fil_meta": false}
{"ts": "2026-07-08T11:47:55.161871+00:00", "op": "execute_getObjectRetention", "status": "ok", "note": "acceptable S3 error (pipeline still validated)", "elapsed_s": 0.477, "status_code": 400, "response_headers_lower": {"access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-expose-headers": "ETag, Content-Length, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-delete-marker", "content-length": "226", "content-type": "application/xml", "date": "Wed, 08 Jul 2026 11:47:54 GMT", "vary": "Origin"}}
{"ts": "2026-07-08T11:47:55.162797+00:00", "op": "response_cors_getObjectRetention", "status": "ok", "status_code": 400, "allow_origin": "https://app.fil.one", "expose_headers": ["content-length", "etag", "x-amz-delete-marker", "x-amz-id-2", "x-amz-request-id", "x-amz-version-id"], "missing_expose_headers": [], "missing_response_meta_headers": [], "origin_ok": true, "expose_ok": true, "meta_ok": true}
{"ts": "2026-07-08T11:47:55.166863+00:00", "op": "presign_deleteObject", "status": "ok", "elapsed_s": 0.001, "s3_op": "delete_object", "http_method": "DELETE", "url_host": "us-east-1.s3.fil.one", "signed_query_contains_fil_meta": false}
{"ts": "2026-07-08T11:47:55.630262+00:00", "op": "preflight_deleteObject", "status": "ok", "elapsed_s": 0.463, "request_method": "DELETE", "request_headers": [], "status_code": 204, "response_headers_lower": {"access-control-allow-headers": "", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-max-age": "3600", "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers", "date": "Wed, 08 Jul 2026 11:47:55 GMT"}, "allow_origin": "https://app.fil.one", "allow_methods": ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"], "allow_headers": [], "missing_request_headers": [], "status_ok": true, "origin_ok": true, "method_ok": true, "headers_ok": true}
{"ts": "2026-07-08T11:47:56.762015+00:00", "op": "execute_deleteObject", "status": "ok", "elapsed_s": 1.131, "status_code": 204, "response_headers_lower": {"access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS", "access-control-allow-origin": "https://app.fil.one", "access-control-expose-headers": "ETag, Content-Length, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-delete-marker", "date": "Wed, 08 Jul 2026 11:47:55 GMT", "vary": "Origin"}}
{"ts": "2026-07-08T11:47:56.762811+00:00", "op": "response_cors_deleteObject", "status": "ok", "status_code": 204, "allow_origin": "https://app.fil.one", "expose_headers": ["content-length", "etag", "x-amz-delete-marker", "x-amz-id-2", "x-amz-request-id", "x-amz-version-id"], "missing_expose_headers": [], "missing_response_meta_headers": [], "origin_ok": true, "expose_ok": true, "meta_ok": true}
```

## Errors

<details markdown="1">
<summary>response_cors_headObject — ResponseCorsMissing: Response lacks CORS headers the browser needs</summary>

**Error details**

```json
{
  "ts": "2026-07-08T11:47:53.166563+00:00",
  "op": "response_cors_headObject",
  "status": "err",
  "error_code": "ResponseCorsMissing",
  "error_message": "Response lacks CORS headers the browser needs",
  "status_code": 200,
  "allow_origin": "https://app.fil.one",
  "expose_headers": [
    "content-length",
    "etag",
    "x-amz-delete-marker",
    "x-amz-id-2",
    "x-amz-request-id",
    "x-amz-version-id"
  ],
  "missing_expose_headers": ["content-type", "last-modified"],
  "missing_response_meta_headers": [],
  "origin_ok": true,
  "expose_ok": false,
  "meta_ok": true
}
```

</details>

<details markdown="1">
<summary>response_cors_headObjectFilMeta — ResponseCorsMissing: Response lacks CORS headers the browser needs</summary>

**Error details**

```json
{
  "ts": "2026-07-08T11:47:53.648774+00:00",
  "op": "response_cors_headObjectFilMeta",
  "status": "err",
  "error_code": "ResponseCorsMissing",
  "error_message": "Response lacks CORS headers the browser needs",
  "status_code": 200,
  "allow_origin": "https://app.fil.one",
  "expose_headers": [
    "content-length",
    "etag",
    "x-amz-delete-marker",
    "x-amz-id-2",
    "x-amz-request-id",
    "x-amz-version-id"
  ],
  "missing_expose_headers": ["content-type", "last-modified", "x-fil-cid"],
  "missing_response_meta_headers": [],
  "origin_ok": true,
  "expose_ok": false,
  "meta_ok": true
}
```

</details>

<details markdown="1">
<summary>response_cors_getObject — ResponseCorsMissing: Response lacks CORS headers the browser needs</summary>

**Error details**

```json
{
  "ts": "2026-07-08T11:47:54.679042+00:00",
  "op": "response_cors_getObject",
  "status": "err",
  "error_code": "ResponseCorsMissing",
  "error_message": "Response lacks CORS headers the browser needs",
  "status_code": 200,
  "allow_origin": "https://app.fil.one",
  "expose_headers": [
    "content-length",
    "etag",
    "x-amz-delete-marker",
    "x-amz-id-2",
    "x-amz-request-id",
    "x-amz-version-id"
  ],
  "missing_expose_headers": ["content-type", "last-modified"],
  "missing_response_meta_headers": [],
  "origin_ok": true,
  "expose_ok": false,
  "meta_ok": true
}
```

</details>

## Log files

- Success: `../logs/20260708_134748_console_presign_success.jsonl`
- Errors: `../logs/20260708_134748_console_presign_errors.jsonl`
