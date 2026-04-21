"""
Console presigned-URL smoke test: verify that a given S3-compatible provider
serves the presigned URL operations used by the FilOne Console (PR #198), and
that those URLs are executable from a browser on https://app.fil.one (CORS).

Operations tested (all signed with AWS Sig V4, 300s expiry):

  putObject           PUT     /{bucket}/{key} + Content-Type + x-amz-meta-*
  listObjects         GET     /{bucket}?list-type=2&...
  headObject          HEAD    /{bucket}/{key}
  headObjectFilMeta   HEAD    /{bucket}/{key}?fil-include-meta=1   (expects x-fil-cid)
  getObject           GET     /{bucket}/{key}
  getObjectRetention  GET     /{bucket}/{key}?retention
  deleteObject        DELETE  /{bucket}/{key}

For each operation, up to four log entries are written:

  presign_<op>    boto3 produces a Sig V4 signed URL
  preflight_<op>  OPTIONS with Origin=<browser origin> returns CORS allows
                  covering the method and any custom request headers.
                  Only emitted for non-simple requests (PUT/DELETE) — per the
                  Fetch spec, browsers don't preflight simple requests (GET/
                  HEAD with only CORS-safelisted headers), so the server's
                  OPTIONS handling doesn't affect those ops in a browser.
  execute_<op>    the URL returns an expected HTTP status
  response_cors_<op>
                  the real response carries Access-Control-Allow-Origin and
                  (for HEAD/GET) an Access-Control-Expose-Headers list that
                  lets the browser read ETag, Content-Length, Content-Type,
                  Last-Modified, and for the fil-include-meta variant
                  x-fil-cid and x-amz-meta-*

Usage:
  python console_presign_test.py --provider aurora
  python console_presign_test.py --provider aurora --bucket my-bucket
  python console_presign_test.py --provider aurora --browser-origin https://app.fil.one

Env (loaded from <provider>/.env via client.py):
  S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_BUCKET
"""
import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import boto3
import requests
from botocore.client import Config

from client import resolve_provider
from logger import Logger


BROWSER_ORIGIN_DEFAULT = "https://app.fil.one"
PRESIGN_EXPIRY_SECONDS = 300
TEST_BODY = b"FilOne Console presigned-URL smoke test.\n"
TEST_CONTENT_TYPE = "text/plain"
TEST_FILENAME = "probe.txt"
HTTP_TIMEOUT = 30

# Providers whose CORS config can be managed through the S3 API.
# Aurora configures CORS out-of-band (edge/CDN layer) and rejects put_bucket_cors.
PROVIDERS_WITH_PUT_BUCKET_CORS = {"akave"}

# Response headers the Console needs to read after HeadObject.
# Per PR #198 ADR: Aurora CORS must expose these via Access-Control-Expose-Headers.
REQUIRED_EXPOSE_HEADERS_BASE = ("etag", "content-length", "content-type", "last-modified")
# Only applicable to the fil-include-meta=1 variant.
REQUIRED_EXPOSE_HEADERS_FIL_META = ("x-fil-cid",)
# x-amz-meta-* is a prefix — we check any x-amz-meta-<something> header we sent
# actually survives to the response (handled separately).

# Allowlist of response headers written to log entries. Headers outside this
# set (e.g. x-amz-server-side-encryption-aws-kms-key-id, x-amz-id-2,
# x-amz-storage-class, rate-limit counters) are sensitive operational data
# that should not be committed to the repo alongside the test reports.
LOGGED_RESPONSE_HEADERS = frozenset({
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "access-control-expose-headers",
    "access-control-max-age",
    "content-disposition",
    "content-encoding",
    "content-length",
    "content-type",
    "date",
    "etag",
    "last-modified",
    "vary",
})
LOGGED_RESPONSE_HEADER_PREFIXES = ("x-amz-meta-", "x-fil-")


@dataclass
class PreflightCheck:
    method: str
    request_headers: list[str] = field(default_factory=list)


@dataclass
class ResponseCorsCheck:
    required_expose: tuple[str, ...] = ()
    required_meta_survives: list[str] = field(default_factory=list)


@dataclass
class OpCase:
    name: str                       # Short id used in log entry names.
    s3_op: str                      # boto3 operation name (e.g. "head_object").
    http_method: str                # HTTP method.
    params: dict                    # Params passed to generate_presigned_url.
    extra_query: dict = field(default_factory=dict)  # Signed query params (e.g. fil-include-meta).
    request_body: bytes | None = None
    request_headers: dict = field(default_factory=dict)  # Headers sent with the execute request.
    preflight: PreflightCheck | None = None
    response_cors: ResponseCorsCheck | None = None
    ok_statuses: tuple[int, ...] = (200,)  # Statuses treated as execution success.
    acceptable_error_statuses: tuple[int, ...] = ()  # S3 errors that still prove the pipeline works.


def main():
    parser = argparse.ArgumentParser(
        description="Verify presigned-URL support + CORS for FilOne Console ops",
    )
    parser.add_argument("--provider", required=True, help="Provider name (e.g. aurora, akave)")
    parser.add_argument("--bucket", default=None, help="Bucket (default: S3_BUCKET from .env)")
    parser.add_argument(
        "--browser-origin",
        default=BROWSER_ORIGIN_DEFAULT,
        help=f"Origin used in CORS checks (default: {BROWSER_ORIGIN_DEFAULT})",
    )
    parser.add_argument(
        "--key-prefix",
        default="console-presign-test/",
        help="Prefix for the randomly-named test object (default: console-presign-test/)",
    )
    args = parser.parse_args()

    provider_dir = resolve_provider(args.provider)
    log = Logger("console_presign", provider_dir)
    s3 = _get_sigv4_s3_client()
    bucket = args.bucket or os.environ["S3_BUCKET"]
    origin = args.browser_origin
    test_key = f"{args.key_prefix.rstrip('/')}/{uuid.uuid4()}/{TEST_FILENAME}"
    put_metadata = {"filename": TEST_FILENAME}

    cors_applied = args.provider in PROVIDERS_WITH_PUT_BUCKET_CORS
    pre_cors_rules, pre_cors_display = _snapshot_bucket_cors(s3, bucket, log, "pre")
    post_cors_display: str | None = None

    if cors_applied:
        _apply_bucket_cors(s3, bucket, origin, list(put_metadata.keys()), log)
        _, post_cors_display = _snapshot_bucket_cors(s3, bucket, log, "post")

    cases = _build_cases(bucket, test_key, put_metadata)

    try:
        for case in cases:
            _run_case(s3, log, case, origin)
    finally:
        _cleanup(s3, bucket, test_key, log)
        if cors_applied:
            _restore_bucket_cors(s3, bucket, pre_cors_rules, log)

    extra = [
        "TEST RUN",
        f"  Provider         : {args.provider}",
        f"  Endpoint         : {os.environ.get('S3_ENDPOINT', '(default)')}",
        f"  Bucket           : {bucket}",
        f"  Test key         : {test_key}",
        f"  Browser origin   : {origin}",
        f"  Presign expiry   : {PRESIGN_EXPIRY_SECONDS}s",
        f"  CORS applied     : {'yes (via put_bucket_cors, restored after test)' if cors_applied else 'no (provider manages CORS out-of-band)'}",
        "",
        "BUCKET CORS CONFIGURATION (before test)",
        *(f"  {line}" for line in pre_cors_display.splitlines() or ["(none)"]),
    ]
    if post_cors_display is not None:
        extra += [
            "",
            "BUCKET CORS CONFIGURATION (after test-applied rule)",
            *(f"  {line}" for line in post_cors_display.splitlines() or ["(none)"]),
        ]
    log.write_report("Console Presigned-URL Test", extra_lines=extra)


# ── Test cases ─────────────────────────────────────────────────────────

def _build_cases(bucket: str, key: str, metadata: dict[str, str]) -> list[OpCase]:
    """Build the ordered list of operations the Console uses."""
    # Headers the browser sends when uploading. Content-Type is always signed;
    # Metadata becomes x-amz-meta-* headers that boto3 adds to SignedHeaders.
    put_headers = {"Content-Type": TEST_CONTENT_TYPE}
    put_headers.update({f"x-amz-meta-{k}": v for k, v in metadata.items()})

    return [
        OpCase(
            name="putObject",
            s3_op="put_object",
            http_method="PUT",
            params={
                "Bucket": bucket,
                "Key": key,
                "ContentType": TEST_CONTENT_TYPE,
                "Metadata": metadata,
            },
            request_body=TEST_BODY,
            request_headers=put_headers,
            preflight=PreflightCheck(method="PUT", request_headers=sorted(put_headers.keys())),
            response_cors=ResponseCorsCheck(),
            ok_statuses=(200,),
        ),
        OpCase(
            name="listObjects",
            s3_op="list_objects_v2",
            http_method="GET",
            params={"Bucket": bucket, "Prefix": key, "MaxKeys": 10},
            response_cors=ResponseCorsCheck(),
            ok_statuses=(200,),
        ),
        OpCase(
            name="headObject",
            s3_op="head_object",
            http_method="HEAD",
            params={"Bucket": bucket, "Key": key},
            response_cors=ResponseCorsCheck(
                required_expose=REQUIRED_EXPOSE_HEADERS_BASE,
                required_meta_survives=[f"x-amz-meta-{k}" for k in metadata],
            ),
            ok_statuses=(200,),
        ),
        OpCase(
            name="headObjectFilMeta",
            s3_op="head_object",
            http_method="HEAD",
            params={"Bucket": bucket, "Key": key},
            extra_query={"fil-include-meta": "1"},
            response_cors=ResponseCorsCheck(
                required_expose=REQUIRED_EXPOSE_HEADERS_BASE + REQUIRED_EXPOSE_HEADERS_FIL_META,
                required_meta_survives=[f"x-amz-meta-{k}" for k in metadata],
            ),
            ok_statuses=(200,),
        ),
        OpCase(
            name="getObject",
            s3_op="get_object",
            http_method="GET",
            params={"Bucket": bucket, "Key": key},
            response_cors=ResponseCorsCheck(required_expose=REQUIRED_EXPOSE_HEADERS_BASE),
            ok_statuses=(200,),
        ),
        OpCase(
            name="getObjectRetention",
            s3_op="get_object_retention",
            http_method="GET",
            params={"Bucket": bucket, "Key": key},
            response_cors=ResponseCorsCheck(),
            # Object Lock may not be enabled on the bucket. 404/400 still means
            # the URL was signed correctly and CORS let the request through.
            ok_statuses=(200,),
            acceptable_error_statuses=(400, 404),
        ),
        OpCase(
            name="deleteObject",
            s3_op="delete_object",
            http_method="DELETE",
            params={"Bucket": bucket, "Key": key},
            preflight=PreflightCheck(method="DELETE"),
            response_cors=ResponseCorsCheck(),
            ok_statuses=(200, 204),
        ),
    ]


# ── Per-case runner ────────────────────────────────────────────────────

def _run_case(s3, log: Logger, case: OpCase, origin: str):
    print(f"\n=== {case.name} ===")

    # 1. Presign
    t0 = time.monotonic()
    try:
        url = _sign(s3, case)
    except Exception as e:
        log.error(f"presign_{case.name}", e,
                  elapsed_s=round(time.monotonic() - t0, 3),
                  s3_op=case.s3_op, http_method=case.http_method)
        return
    log.success(f"presign_{case.name}",
                elapsed_s=round(time.monotonic() - t0, 3),
                s3_op=case.s3_op, http_method=case.http_method,
                url_host=urlparse(url).hostname,
                signed_query_contains_fil_meta="fil-include-meta=1" in url)

    # 2. Preflight
    if case.preflight:
        t0 = time.monotonic()
        try:
            resp = _preflight(url, origin, case.preflight)
        except Exception as e:
            log.error(f"preflight_{case.name}", e,
                      elapsed_s=round(time.monotonic() - t0, 3))
            # Continue — preflight failure doesn't prevent the execute check.
        else:
            ok, details = _check_preflight(resp, origin, case.preflight)
            entry = {
                "elapsed_s": round(time.monotonic() - t0, 3),
                "request_method": case.preflight.method,
                "request_headers": case.preflight.request_headers,
                "status_code": resp.status_code,
                "response_headers_lower": _filter_response_headers(resp.headers),
                **details,
            }
            if ok:
                log.success(f"preflight_{case.name}", **entry)
            else:
                log.error_raw(f"preflight_{case.name}",
                              error_code="PreflightFailed",
                              error_message="CORS preflight did not permit the request",
                              **entry)

    # 3. Execute
    t0 = time.monotonic()
    try:
        resp = _execute(url, case, origin)
    except Exception as e:
        log.error(f"execute_{case.name}", e,
                  elapsed_s=round(time.monotonic() - t0, 3))
        return

    exec_entry = {
        "elapsed_s": round(time.monotonic() - t0, 3),
        "status_code": resp.status_code,
        "response_headers_lower": _filter_response_headers(resp.headers),
    }
    if resp.status_code in case.ok_statuses:
        log.success(f"execute_{case.name}", **exec_entry)
    elif resp.status_code in case.acceptable_error_statuses:
        # URL + CORS pipeline worked; S3 returned a documented error (e.g.,
        # retention not set on the object).
        log.success(f"execute_{case.name}",
                    note="acceptable S3 error (pipeline still validated)",
                    **exec_entry)
    else:
        log.error_raw(f"execute_{case.name}",
                      error_code=f"HTTP {resp.status_code}",
                      error_message=resp.reason or "Unexpected status",
                      **exec_entry)

    # 4. Response CORS
    if case.response_cors is not None:
        ok, details = _check_response_cors(resp, origin, case)
        entry = {"status_code": resp.status_code, **details}
        if ok:
            log.success(f"response_cors_{case.name}", **entry)
        else:
            log.error_raw(f"response_cors_{case.name}",
                          error_code="ResponseCorsMissing",
                          error_message="Response lacks CORS headers the browser needs",
                          **entry)


# ── Signing ────────────────────────────────────────────────────────────

def _sign(s3, case: OpCase) -> str:
    """Generate a presigned URL, with optional signed extra query params."""
    if not case.extra_query:
        return s3.generate_presigned_url(
            case.s3_op,
            Params=case.params,
            ExpiresIn=PRESIGN_EXPIRY_SECONDS,
            HttpMethod=case.http_method,
        )

    event = f"before-sign.s3.{_op_class_name(case.s3_op)}"
    hooks = [_make_query_param_hook(n, v) for n, v in case.extra_query.items()]
    for hook in hooks:
        s3.meta.events.register(event, hook)
    try:
        return s3.generate_presigned_url(
            case.s3_op,
            Params=case.params,
            ExpiresIn=PRESIGN_EXPIRY_SECONDS,
            HttpMethod=case.http_method,
        )
    finally:
        for hook in hooks:
            s3.meta.events.unregister(event, hook)


def _make_query_param_hook(name: str, value: str) -> Callable:
    """A before-sign hook that adds a query parameter before SigV4 signs the URL."""
    def hook(request, **kwargs):
        parsed = urlparse(request.url)
        q = dict(parse_qsl(parsed.query, keep_blank_values=True))
        q[name] = value
        request.url = urlunparse(parsed._replace(query=urlencode(q)))
    return hook


def _op_class_name(s3_op: str) -> str:
    """Convert boto3 op name (snake_case) to the operation class name used in events."""
    return "".join(p.capitalize() for p in s3_op.split("_"))


# ── HTTP requests ──────────────────────────────────────────────────────

def _preflight(url: str, origin: str, pf: PreflightCheck) -> requests.Response:
    headers = {
        "Origin": origin,
        "Access-Control-Request-Method": pf.method,
    }
    if pf.request_headers:
        headers["Access-Control-Request-Headers"] = ", ".join(pf.request_headers)
    return requests.options(url, headers=headers, timeout=HTTP_TIMEOUT)


def _execute(url: str, case: OpCase, origin: str) -> requests.Response:
    headers = {"Origin": origin, **case.request_headers}
    return requests.request(
        case.http_method,
        url,
        headers=headers,
        data=case.request_body,
        timeout=HTTP_TIMEOUT,
        allow_redirects=False,
    )


# ── Checks ─────────────────────────────────────────────────────────────

def _check_preflight(resp: requests.Response, origin: str, pf: PreflightCheck) -> tuple[bool, dict]:
    allow_origin = resp.headers.get("Access-Control-Allow-Origin", "")
    allow_methods = _split_header(resp.headers.get("Access-Control-Allow-Methods", ""))
    allow_headers = _split_header(resp.headers.get("Access-Control-Allow-Headers", ""), lower=True)

    status_ok = resp.status_code in (200, 204)
    origin_ok = allow_origin == "*" or allow_origin.lower() == origin.lower()
    method_ok = "*" in allow_methods or pf.method.upper() in {m.upper() for m in allow_methods}
    missing = [
        h for h in pf.request_headers
        if "*" not in allow_headers and h.lower() not in allow_headers
    ]
    headers_ok = not missing

    return (status_ok and origin_ok and method_ok and headers_ok), {
        "allow_origin": allow_origin,
        "allow_methods": sorted(allow_methods),
        "allow_headers": sorted(allow_headers),
        "missing_request_headers": missing,
        "status_ok": status_ok,
        "origin_ok": origin_ok,
        "method_ok": method_ok,
        "headers_ok": headers_ok,
    }


def _check_response_cors(resp: requests.Response, origin: str, case: OpCase) -> tuple[bool, dict]:
    rc = case.response_cors
    allow_origin = resp.headers.get("Access-Control-Allow-Origin", "")
    origin_ok = allow_origin == "*" or allow_origin.lower() == origin.lower()

    exposed = _split_header(resp.headers.get("Access-Control-Expose-Headers", ""), lower=True)
    wildcard_expose = "*" in exposed

    missing_expose = [
        h for h in rc.required_expose
        if not wildcard_expose and h.lower() not in exposed
    ]
    expose_ok = not missing_expose

    # For a HEAD response, custom metadata the server sends as x-amz-meta-<name>
    # must actually appear in the wire response so the browser can read it.
    # (Exposure via Access-Control-Expose-Headers is independent — covered above
    # when 'x-amz-meta-*' or individual names are required.)
    response_headers_lower = {k.lower(): v for k, v in resp.headers.items()}
    missing_meta = [
        h for h in rc.required_meta_survives
        if h.lower() not in response_headers_lower
    ]
    meta_ok = not missing_meta

    return (origin_ok and expose_ok and meta_ok), {
        "allow_origin": allow_origin,
        "expose_headers": sorted(exposed),
        "missing_expose_headers": missing_expose,
        "missing_response_meta_headers": missing_meta,
        "origin_ok": origin_ok,
        "expose_ok": expose_ok,
        "meta_ok": meta_ok,
    }


def _split_header(value: str, *, lower: bool = False) -> set[str]:
    parts = {p.strip() for p in value.split(",") if p.strip()}
    return {p.lower() for p in parts} if lower else parts


def _filter_response_headers(headers) -> dict:
    """Return only the response headers we care about, dropping sensitive ones.

    Restricts logged headers to the CORS + content metadata we assert on, plus
    ``x-amz-meta-*`` / ``x-fil-*`` which the test validates directly. Everything
    else (KMS key ARNs, internal request IDs, storage-class UUIDs, rate-limit
    counters, backend hints) is excluded so committed logs stay free of
    sensitive operational data.
    """
    out = {}
    for k, v in headers.items():
        lk = k.lower()
        if lk in LOGGED_RESPONSE_HEADERS or any(lk.startswith(p) for p in LOGGED_RESPONSE_HEADER_PREFIXES):
            out[lk] = v
    return out


# ── Setup helpers ──────────────────────────────────────────────────────

def _get_sigv4_s3_client():
    """S3 client forced to AWS Sig V4 (browser presigned URLs use X-Amz-* params).

    The default get_s3_client() lets boto3 pick the signer, which defaults to
    SigV2 against non-AWS endpoints. SigV2 does not sign arbitrary query
    parameters, so the fil-include-meta=1 hook would silently have no effect
    on the signature and the browser-facing URL would not match what the
    Console's presign handler produces.
    """
    session = boto3.session.Session(
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
    )
    return session.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def _apply_bucket_cors(s3, bucket: str, origin: str, metadata_keys: list[str], log: Logger):
    """Overwrite the bucket's CORS config so the Console operations succeed from `origin`.

    The rule mirrors exactly what the test case list needs: every HTTP method
    used below, wildcard request headers (so Content-Type + x-amz-meta-* are
    accepted on PUT), and an ExposeHeaders list covering every response header
    the browser must be able to read (ETag/Content-Length/Content-Type/
    Last-Modified, x-fil-cid for the fil-include-meta variant, and the
    x-amz-meta-* headers the test actually sets).
    """
    expose = [
        *REQUIRED_EXPOSE_HEADERS_BASE,
        *REQUIRED_EXPOSE_HEADERS_FIL_META,
        *(f"x-amz-meta-{k}" for k in metadata_keys),
    ]
    cors = {
        "CORSRules": [
            {
                "AllowedOrigins": [origin],
                "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
                "AllowedHeaders": ["*"],
                "ExposeHeaders": expose,
                "MaxAgeSeconds": 3000,
            }
        ]
    }
    try:
        s3.put_bucket_cors(Bucket=bucket, CORSConfiguration=cors)
    except Exception as e:
        log.error("bucket_cors_apply", e, bucket=bucket)
        raise
    log.success("bucket_cors_apply",
                bucket=bucket,
                allowed_origins=[origin],
                allowed_methods=cors["CORSRules"][0]["AllowedMethods"],
                expose_headers=expose)


def _snapshot_bucket_cors(s3, bucket: str, log: Logger, label: str) -> tuple[list | None, str]:
    """Fetch the bucket's CORS config.

    Returns ``(rules, display)``:

    - ``rules`` is the CORSRules list (possibly empty) when GetBucketCors
      succeeds or returns NoSuchCORSConfiguration — safe to pass to
      :func:`_restore_bucket_cors`.
    - ``rules`` is ``None`` when the provider refuses to disclose the config
      (AccessDenied/AllAccessDisabled) or returns another error. Restoration
      is not possible in that case.
    - ``display`` is always a human-readable snapshot for the report.
    """
    try:
        resp = s3.get_bucket_cors(Bucket=bucket)
    except Exception as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code", type(e).__name__)
        if code in {"NoSuchCORSConfiguration", "NoSuchBucket"}:
            return [], f"(provider returned {code})"
        if code in {"AccessDenied", "AllAccessDisabled"}:
            log.success(f"bucket_cors_read_{label}",
                        bucket=bucket,
                        status="skipped",
                        error_code=code,
                        error_message=str(e))
            return None, f"(cannot read: {code})"
        log.error_raw(f"bucket_cors_read_{label}",
                      error_code=code, error_message=str(e))
        return None, f"(error reading CORS: {code})"
    rules = resp.get("CORSRules", [])
    return rules, json.dumps(rules, indent=2, default=str)


def _restore_bucket_cors(s3, bucket: str, rules: list | None, log: Logger):
    """Restore the CORS config captured by :func:`_snapshot_bucket_cors`.

    If ``rules`` is ``None`` the pre-existing config was not readable, so we
    cannot restore it — log a soft error and leave the test-applied rules in
    place. The operator can reconcile manually.
    """
    if rules is None:
        log.error_raw("bucket_cors_restore",
                      error_code="NotRestorable",
                      error_message="Pre-existing CORS config was not readable; "
                                    "test-applied rules remain in place.",
                      bucket=bucket)
        return
    try:
        if rules:
            s3.put_bucket_cors(Bucket=bucket,
                               CORSConfiguration={"CORSRules": rules})
            log.success("bucket_cors_restore", bucket=bucket,
                        action="put", rules_count=len(rules))
        else:
            s3.delete_bucket_cors(Bucket=bucket)
            log.success("bucket_cors_restore", bucket=bucket, action="delete")
    except Exception as e:
        log.error("bucket_cors_restore", e, bucket=bucket)


def _cleanup(s3, bucket: str, key: str, log: Logger):
    """Best-effort removal of the test object even if the presigned delete failed."""
    try:
        s3.delete_object(Bucket=bucket, Key=key)
    except Exception as e:
        # The `deleteObject` case ordinarily succeeds, so finding the key gone
        # here is the expected outcome — don't log it as a failure.
        response = getattr(e, "response", {}) or {}
        code = str(response.get("Error", {}).get("Code", ""))
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code == "NoSuchKey" or status == 404:
            return
        log.error("cleanup_delete", e, bucket=bucket, key=key)


if __name__ == "__main__":
    sys.exit(main() or 0)
