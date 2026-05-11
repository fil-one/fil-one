"""Aurora Portal API — HTTP wrappers for bucket operations.

The Aurora S3 gateway does not support CreateBucket or DeleteBucket via
access-key auth. These operations are only available through the Aurora
Dashboard (Portal) REST API using a Bearer token.

This module provides thin wrappers that return responses shaped like
their boto3/S3 equivalents so ``lib.backend-aurora.patch`` can swap them in
transparently.

Env vars
--------
AURORA_PORTAL_ORIGIN  - e.g. https://api.portal.dev.aur.lu
AURORA_TENANT_ID      - UUID of the tenant whose buckets we manage
AURORA_NO_VERIFY_SSL  - set to "true" to skip TLS cert verification

Token
-----
Reuses the cached Bearer token at ~/.aurora_token written by
``python tools/aurora_key_management.py login``.
"""
import json
import logging
import os
import time
from pathlib import Path

import requests
import urllib3

log = logging.getLogger("backend-aurora.portal_api")

TOKEN_CACHE = Path.home() / ".aurora_token"
API_BASE = "/api/v1"


# ── configuration ────────────────────────────────────────────────────────

def _origin() -> str:
    origin = os.environ.get("AURORA_PORTAL_ORIGIN", "")
    if not origin:
        raise RuntimeError("AURORA_PORTAL_ORIGIN is not set")
    return origin.rstrip("/")


def _tenant_id() -> str:
    tid = os.environ.get("AURORA_TENANT_ID", "")
    if not tid:
        raise RuntimeError("AURORA_TENANT_ID is not set")
    return tid


def _verify_ssl() -> bool:
    return os.environ.get("AURORA_NO_VERIFY_SSL", "").lower() not in ("true", "1", "yes")


def _suppress_insecure_warnings():
    if not _verify_ssl():
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# ── token ────────────────────────────────────────────────────────────────

def _load_token() -> str:
    """Load and validate the cached Bearer token."""
    if not TOKEN_CACHE.exists():
        raise RuntimeError(
            f"No Aurora token found at {TOKEN_CACHE}. "
            "Run: python tools/aurora_key_management.py login"
        )
    data = json.loads(TOKEN_CACHE.read_text())
    if "expires_at" in data and time.time() > data["expires_at"]:
        raise RuntimeError(
            "Aurora Bearer token has expired. "
            "Run: python tools/aurora_key_management.py login"
        )
    token = data.get("access_token", "")
    if not token:
        raise RuntimeError("Aurora token file exists but contains no access_token")
    return token


def _headers() -> dict:
    return {
        "X-Api-Key": _load_token(),
        "Content-Type": "application/json",
    }


def _req_kwargs() -> dict:
    return {"verify": _verify_ssl()}


def _url(path: str) -> str:
    return f"{_origin()}{API_BASE}{path}"


# ── Portal API wrappers ─────────────────────────────────────────────────

def portal_create_bucket(bucket_name: str, **kwargs) -> dict:
    """POST /tenants/{tenantId}/buckets → create a bucket via Portal API.

    Body shape is buckets.BucketCreateRequest:
        {name, lock, encrypted, versioning, defaultRetention}

    Returns an S3-shaped CreateBucket response.
    """
    _suppress_insecure_warnings()
    tenant = _tenant_id()
    url = _url(f"/tenants/{tenant}/buckets")
    body: dict = {"name": bucket_name}

    if kwargs.get("ObjectLockEnabledForBucket"):
        body["lock"] = True

    log.debug("Portal create_bucket: POST %s  body=%s", url, body)

    resp = requests.post(url, headers=_headers(), json=body, **_req_kwargs())

    if resp.status_code == 409:
        # Bucket already exists — map to botocore ClientError shape
        from botocore.exceptions import ClientError
        error_response = {
            "Error": {
                "Code": "BucketAlreadyOwnedByYou",
                "Message": "Your previous request to create the named bucket succeeded and you already own it.",
                "BucketName": bucket_name,
            },
            "ResponseMetadata": {
                "RequestId": "aurora-portal-bridge",
                "HTTPStatusCode": 409,
                "HTTPHeaders": {},
                "RetryAttempts": 0,
            },
        }
        raise ClientError(error_response, "CreateBucket")

    resp.raise_for_status()

    result = {
        "Location": f"/{bucket_name}",
        "ResponseMetadata": {
            "RequestId": "aurora-portal-bridge",
            "HTTPStatusCode": resp.status_code,
            "HTTPHeaders": {"location": f"/{bucket_name}"},
            "RetryAttempts": 0,
        },
    }
    log.info("Portal create_bucket: created %r (HTTP %d)", bucket_name, resp.status_code)
    return result


def portal_delete_bucket(bucket_name: str) -> dict:
    """DELETE /tenants/{tenantId}/buckets/{bucketName} → delete bucket via Portal API.

    204 on success; 404 not found; 409 if bucket still has objects/versions.
    Best-effort on transport errors so cleanup doesn't block test runs.
    """
    _suppress_insecure_warnings()
    tenant = _tenant_id()
    url = _url(f"/tenants/{tenant}/buckets/{bucket_name}")
    log.debug("Portal delete_bucket: DELETE %s", url)

    status = 204
    try:
        resp = requests.delete(url, headers=_headers(), **_req_kwargs())
        status = resp.status_code
        if status in (200, 204):
            log.info("Portal delete_bucket: deleted %r", bucket_name)
        elif status == 404:
            log.warning("Portal delete_bucket: %r not found", bucket_name)
        elif status == 409:
            log.warning(
                "Portal delete_bucket: %r has remaining objects/versions (HTTP 409)",
                bucket_name,
            )
        else:
            resp.raise_for_status()
    except requests.RequestException as exc:
        log.warning("Portal delete_bucket: failed for %r: %s", bucket_name, exc)

    return {
        "ResponseMetadata": {
            "RequestId": "aurora-portal-bridge",
            "HTTPStatusCode": status,
            "HTTPHeaders": {},
            "RetryAttempts": 0,
        },
    }


def validate_connection():
    """Validate the cached Portal Bearer token exists and is unexpired.

    Raises RuntimeError with a clear message on failure.
    """
    _load_token()
