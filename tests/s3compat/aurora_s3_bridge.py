"""
aurora_s3_bridge — Pytest plugin that redirects S3 bucket-management
calls to the Aurora Portal API.

Aurora access keys cannot ListBuckets, CreateBucket, or DeleteBucket.
Those operations are portal-only (Bearer-token REST API).  This plugin
monkey-patches every boto3 S3 client so the ceph/s3-tests suite works
without any modifications to the submodule.

Activation
----------
Only activates when the ``AURORA_PORTAL_ORIGIN`` env var is set.
Load it with ``pytest -p aurora_s3_bridge ...`` (requires ``tests/s3compat/``
on PYTHONPATH).

What gets patched
-----------------
- ``boto3.client()`` and ``boto3.session.Session.client()``
  → every returned S3 client has its ``.list_buckets``, ``.create_bucket``,
    and ``.delete_bucket`` methods replaced with Portal API wrappers.

- ``boto3.resource()`` and ``boto3.session.Session.resource()``
  → the ``Bucket.create()`` method on every S3 resource is wrapped so
    ``get_new_bucket_resource()`` works.

- Tests that explicitly test ListBuckets behaviour are auto-skipped.
"""
import functools
import logging
import os

import boto3
import pytest

log = logging.getLogger("aurora_s3_bridge")

# ── Guard: only activate for Aurora ─────────────────────────────────────

_ACTIVE = bool(os.environ.get("AURORA_PORTAL_ORIGIN"))

if _ACTIVE:
    from aurora_portal_bridge import (
        portal_create_bucket,
        portal_delete_bucket,
        portal_list_buckets,
        validate_connection,
    )


# ── S3 Client patching ──────────────────────────────────────────────────

_EMPTY_LIST_BUCKETS = {
    "Buckets": [],
    "Owner": {"DisplayName": "", "ID": ""},
    "ResponseMetadata": {
        "RequestId": "aurora-portal-bridge",
        "HTTPStatusCode": 200,
        "HTTPHeaders": {},
        "RetryAttempts": 0,
    },
}


def _is_main_client(client) -> bool:
    """Check if this client uses the main S3 credentials.

    The Portal API returns ALL tenant buckets regardless of caller.
    Alt/tenant clients can't actually operate on those buckets via S3,
    so we return empty for non-main clients to avoid teardown errors.
    """
    main_key = os.environ.get("S3_ACCESS_KEY_ID", "")
    try:
        client_key = client._request_signer._credentials.access_key
        return client_key == main_key
    except AttributeError:
        return True  # assume main if we can't determine


def _wrap_list_buckets(original_method, is_main: bool):
    """Replace client.list_buckets() with a Portal API call.

    Only the main client gets the real portal list; alt/tenant clients
    get an empty list since they share the same portal identity but
    can't do S3 operations on those buckets.
    """
    @functools.wraps(original_method)
    def wrapper(**kwargs):
        if not is_main:
            log.debug("Intercepted list_buckets() on non-main client → empty list")
            return _EMPTY_LIST_BUCKETS
        log.debug("Intercepted list_buckets() → Portal API")
        return portal_list_buckets()
    return wrapper


def _wrap_create_bucket(original_method, real_client):
    """Replace client.create_bucket() with Portal + optional ACL passthrough."""
    @functools.wraps(original_method)
    def wrapper(**kwargs):
        bucket_name = kwargs.get("Bucket", "")
        log.debug("Intercepted create_bucket(Bucket=%r) → Portal API", bucket_name)

        # Extract params the Portal doesn't handle
        acl = kwargs.get("ACL")
        object_lock = kwargs.get("ObjectLockEnabledForBucket", False)

        # Create via Portal
        result = portal_create_bucket(bucket_name, ObjectLockEnabledForBucket=object_lock)

        # If an ACL was requested, apply it via the real S3 API after creation
        if acl:
            try:
                log.debug("Applying ACL %r to %r via S3 API", acl, bucket_name)
                real_client.put_bucket_acl(Bucket=bucket_name, ACL=acl)
            except Exception as exc:
                log.warning("Failed to set ACL %r on %r: %s", acl, bucket_name, exc)

        return result
    return wrapper


def _wrap_delete_bucket(original_method):
    """Replace client.delete_bucket() with a Portal API call."""
    @functools.wraps(original_method)
    def wrapper(**kwargs):
        bucket_name = kwargs.get("Bucket", "")
        log.debug("Intercepted delete_bucket(Bucket=%r) → Portal API", bucket_name)
        return portal_delete_bucket(bucket_name)
    return wrapper


def _patch_s3_client(client):
    """Patch list_buckets/create_bucket/delete_bucket on an S3 client instance."""
    # Guard: only patch once
    if getattr(client, "_aurora_patched", False):
        return client

    is_main = _is_main_client(client)
    client.list_buckets = _wrap_list_buckets(client.list_buckets, is_main)
    client.create_bucket = _wrap_create_bucket(client.create_bucket, client)
    client.delete_bucket = _wrap_delete_bucket(client.delete_bucket)
    client._aurora_patched = True
    log.debug("Patched S3 client %s (main=%s)", id(client), is_main)
    return client


# ── boto3.client / Session.client wrapping ───────────────────────────────

_original_boto3_client = boto3.client
_original_session_client = boto3.session.Session.client


@functools.wraps(_original_boto3_client)
def _patched_boto3_client(*args, **kwargs):
    client = _original_boto3_client(*args, **kwargs)
    service = args[0] if args else kwargs.get("service_name", "")
    if service == "s3":
        _patch_s3_client(client)
    return client


@functools.wraps(_original_session_client)
def _patched_session_client(self, *args, **kwargs):
    client = _original_session_client(self, *args, **kwargs)
    service = args[0] if args else kwargs.get("service_name", "")
    if service == "s3":
        _patch_s3_client(client)
    return client


# ── boto3.resource / Session.resource wrapping ───────────────────────────

_original_boto3_resource = boto3.resource
_original_session_resource = boto3.session.Session.resource


def _patch_bucket_create(resource_obj):
    """Wrap Bucket.create() on an S3 ServiceResource so
    ``get_new_bucket_resource()`` goes through the Portal."""
    original_bucket_cls_create = None

    # We need to intercept Bucket(...).create(). The cleanest way is to
    # wrap the ServiceResource.Bucket factory so each Bucket instance
    # gets a patched .create().
    original_Bucket = resource_obj.Bucket

    @functools.wraps(original_Bucket)
    def _patched_Bucket(*args, **kwargs):
        bucket = original_Bucket(*args, **kwargs)
        if getattr(bucket, "_aurora_patched", False):
            return bucket

        original_create = bucket.create

        @functools.wraps(original_create)
        def _create_wrapper(**kw):
            log.debug("Intercepted Bucket(%r).create() → Portal API", bucket.name)
            portal_create_bucket(bucket.name)
            # Call the original to set the local resource state, but catch
            # errors since the bucket already exists on the server
            try:
                return original_create(**kw)
            except Exception:
                # Bucket was already created via Portal; the S3 call may
                # fail with AccessDenied or BucketAlreadyExists — that's OK
                log.debug("Original Bucket.create() failed (expected), Portal already created it")
                return {"Location": f"/{bucket.name}"}

        bucket.create = _create_wrapper
        bucket._aurora_patched = True
        return bucket

    resource_obj.Bucket = _patched_Bucket


@functools.wraps(_original_boto3_resource)
def _patched_boto3_resource(*args, **kwargs):
    resource = _original_boto3_resource(*args, **kwargs)
    service = args[0] if args else kwargs.get("service_name", "")
    if service == "s3":
        _patch_bucket_create(resource)
    return resource


@functools.wraps(_original_session_resource)
def _patched_session_resource(self, *args, **kwargs):
    resource = _original_session_resource(self, *args, **kwargs)
    service = args[0] if args else kwargs.get("service_name", "")
    if service == "s3":
        _patch_bucket_create(resource)
    return resource


# ── Install patches ──────────────────────────────────────────────────────

def _install_patches():
    boto3.client = _patched_boto3_client
    boto3.session.Session.client = _patched_session_client
    boto3.resource = _patched_boto3_resource
    boto3.session.Session.resource = _patched_session_resource
    log.info("Aurora S3 bridge patches installed")


# ── Tests to auto-skip ───────────────────────────────────────────────────

_SKIP_TESTS = {
    "test_list_buckets_anonymous",
    "test_list_buckets_invalid_auth",
    "test_list_buckets_bad_auth",
    "test_list_buckets_paginated",
}

_SKIP_REASON = (
    "Aurora: ListBuckets is handled by the Portal API bridge; "
    "this test exercises raw S3 ListBuckets behaviour which is not applicable."
)


# ── Pytest hooks ─────────────────────────────────────────────────────────

def pytest_configure(config):
    """Called early in pytest startup — install monkey-patches."""
    if not _ACTIVE:
        return
    log.info("Aurora S3 bridge plugin activating (AURORA_PORTAL_ORIGIN is set)")
    try:
        validate_connection()
        log.info("Aurora Portal API connection validated")
    except RuntimeError as exc:
        log.error("Aurora Portal API validation failed: %s", exc)
        raise pytest.UsageError(str(exc)) from exc
    _install_patches()


def pytest_collection_modifyitems(config, items):
    """Auto-skip tests that explicitly test ListBuckets behaviour."""
    if not _ACTIVE:
        return
    skip_marker = pytest.mark.skip(reason=_SKIP_REASON)
    for item in items:
        # Match on the test function name (last part of the nodeid)
        test_name = item.name
        if test_name in _SKIP_TESTS:
            item.add_marker(skip_marker)
            log.debug("Auto-skipping %s", item.nodeid)
