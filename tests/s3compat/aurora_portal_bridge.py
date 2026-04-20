"""
Aurora Portal API Bridge — HTTP client for bucket operations.

The Aurora S3 gateway does not support ListBuckets, CreateBucket, or
DeleteBucket via access-key auth.  These operations are only available
through the Aurora Dashboard (Portal) REST API using a Bearer token.

This module provides three thin wrappers that return responses shaped
like their boto3/S3 equivalents so the pytest bridge plugin can swap
them in transparently.

Env vars
--------
AURORA_PORTAL_ORIGIN  – e.g. https://dashboard.dev.aur.lu
AURORA_TENANT_ID      – UUID of the tenant whose buckets we manage
AURORA_NO_VERIFY_SSL  – set to "true" to skip TLS cert verification

Token
-----
Reuses the cached Bearer token at ~/.aurora_token written by
aurora_key_management.py (``aurora_key_management.py login``).
"""
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import urllib3

log = logging.getLogger("aurora_portal_bridge")

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
            "Run: python aurora_key_management.py login"
        )
    data = json.loads(TOKEN_CACHE.read_text())
    if "expires_at" in data and time.time() > data["expires_at"]:
        raise RuntimeError(
            "Aurora Bearer token has expired. "
            "Run: python aurora_key_management.py login"
        )
    token = data.get("access_token", "")
    if not token:
        raise RuntimeError("Aurora token file exists but contains no access_token")
    return token


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_load_token()}",
        "Content-Type": "application/json",
    }


def _req_kwargs() -> dict:
    return {"verify": _verify_ssl()}


def _url(path: str) -> str:
    return f"{_origin()}{API_BASE}{path}"


# ── Portal API wrappers ─────────────────────────────────────────────────

def portal_list_buckets() -> dict:
    """GET /tenants/{tenantId}/bucket → S3-shaped ListBuckets response."""
    _suppress_insecure_warnings()
    tenant = _tenant_id()
    url = _url(f"/tenants/{tenant}/bucket")
    log.debug("Portal list_buckets: GET %s", url)

    resp = requests.get(url, headers=_headers(), **_req_kwargs())
    resp.raise_for_status()
    data = resp.json()

    # The Portal API returns something like {"buckets": [{"name": "...", ...}, ...]}
    # Normalise to boto3 shape: {"Buckets": [{"Name": "...", "CreationDate": ...}]}
    raw_buckets = data if isinstance(data, list) else data.get("buckets", data.get("Buckets", []))
    if isinstance(raw_buckets, dict):
        # Fallback: maybe the entire response is a single-bucket dict
        raw_buckets = [raw_buckets]

    buckets = []
    for b in raw_buckets:
        name = b.get("name") or b.get("Name") or b.get("bucketName", "")
        created = b.get("creationDate") or b.get("CreationDate") or b.get("createdAt")
        if created and isinstance(created, str):
            try:
                created = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                created = datetime.now(timezone.utc)
        elif not created:
            created = datetime.now(timezone.utc)
        buckets.append({"Name": name, "CreationDate": created})

    result = {
        "Buckets": buckets,
        "Owner": {"DisplayName": "", "ID": ""},
        "ResponseMetadata": {
            "RequestId": "aurora-portal-bridge",
            "HTTPStatusCode": 200,
            "HTTPHeaders": {},
            "RetryAttempts": 0,
        },
    }
    log.debug("Portal list_buckets: %d buckets", len(buckets))
    return result


def portal_create_bucket(bucket_name: str, **kwargs) -> dict:
    """POST /tenants/{tenantId}/bucket → create a bucket via Portal API.

    Returns an S3-shaped CreateBucket response.
    """
    _suppress_insecure_warnings()
    tenant = _tenant_id()
    url = _url(f"/tenants/{tenant}/bucket")
    body = {"name": bucket_name}

    # Pass through ObjectLockEnabledForBucket if set
    if kwargs.get("ObjectLockEnabledForBucket"):
        body["objectLockEnabled"] = True

    log.debug("Portal create_bucket: POST %s  body=%s", url, body)

    resp = requests.post(url, headers=_headers(), json=body, **_req_kwargs())

    if resp.status_code == 409:
        # Bucket already exists — map to botocore ClientError shape
        from botocore.exceptions import ClientError
        error_response = {
            "Error": {
                "Code": "BucketAlreadyOwnedByYou",
                "Message": f"Your previous request to create the named bucket succeeded and you already own it.",
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
            "HTTPStatusCode": 200,
            "HTTPHeaders": {"location": f"/{bucket_name}"},
            "RetryAttempts": 0,
        },
    }
    log.info("Portal create_bucket: created %r", bucket_name)
    return result


def portal_delete_bucket(bucket_name: str) -> dict:
    """DELETE /tenants/{tenantId}/bucket/{name} → delete bucket via Portal API.

    Best-effort: if the endpoint doesn't exist (404/405), logs a warning
    and returns success so cleanup doesn't block test runs.
    """
    _suppress_insecure_warnings()
    tenant = _tenant_id()
    url = _url(f"/tenants/{tenant}/bucket/{bucket_name}")
    log.debug("Portal delete_bucket: DELETE %s", url)

    try:
        resp = requests.delete(url, headers=_headers(), **_req_kwargs())
        if resp.status_code in (200, 204):
            log.info("Portal delete_bucket: deleted %r", bucket_name)
        elif resp.status_code in (404, 405):
            log.warning(
                "Portal delete_bucket: endpoint returned %d for %r — "
                "DELETE bucket may not be supported via Portal API. "
                "Bucket will need manual cleanup.",
                resp.status_code, bucket_name,
            )
        else:
            resp.raise_for_status()
    except requests.RequestException as exc:
        log.warning("Portal delete_bucket: failed for %r: %s", bucket_name, exc)

    return {
        "ResponseMetadata": {
            "RequestId": "aurora-portal-bridge",
            "HTTPStatusCode": 204,
            "HTTPHeaders": {},
            "RetryAttempts": 0,
        },
    }


def validate_connection():
    """Quick sanity check: load token and hit list_buckets.

    Raises RuntimeError with a clear message on failure.
    """
    _suppress_insecure_warnings()
    _load_token()  # validates token exists and isn't expired
    try:
        portal_list_buckets()
    except requests.HTTPError as exc:
        raise RuntimeError(
            f"Aurora Portal API check failed ({exc.response.status_code}): "
            f"{exc.response.text[:200]}"
        ) from exc
    except requests.ConnectionError as exc:
        raise RuntimeError(
            f"Cannot reach Aurora Portal at {_origin()}: {exc}"
        ) from exc
