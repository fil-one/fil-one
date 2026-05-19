"""Aurora portal patch layer — redirects S3 bucket management to the Portal API.

Aurora access keys cannot CreateBucket or DeleteBucket via S3. Those
operations are portal-only (Bearer-token REST API). This module monkey-patches
every boto3 S3 client so the ceph/s3-tests suite works without modifications
to the submodule.

What gets patched
-----------------
- ``boto3.client()`` and ``boto3.session.Session.client()``
  → every returned S3 client has its ``.create_bucket`` and ``.delete_bucket``
    methods replaced with Portal API wrappers.

- ``boto3.resource()`` and ``boto3.session.Session.resource()``
  → the ``Bucket.create()`` method on every S3 resource is wrapped so
    ``get_new_bucket_resource()`` works.

Activation is owned by ``backend_loader`` (top-level pytest plugin); this
module's ``activate()`` is invoked when ``S3COMPAT_BACKEND=aurora``.
"""
import functools
import logging

import boto3

from .portal_api import (
    portal_create_bucket,
    portal_delete_bucket,
    validate_connection,
)

log = logging.getLogger("backend-aurora.patch")


# ── S3 Client patching ──────────────────────────────────────────────────


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
    """Patch create_bucket/delete_bucket on an S3 client instance."""
    if getattr(client, "_aurora_patched", False):
        return client

    client.create_bucket = _wrap_create_bucket(client.create_bucket, client)
    client.delete_bucket = _wrap_delete_bucket(client.delete_bucket)
    client._aurora_patched = True
    log.debug("Patched S3 client %s", id(client))
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

_INSTALLED = False


def _install_patches():
    global _INSTALLED
    if _INSTALLED:
        return
    boto3.client = _patched_boto3_client
    boto3.session.Session.client = _patched_session_client
    boto3.resource = _patched_boto3_resource
    boto3.session.Session.resource = _patched_session_resource
    _INSTALLED = True
    log.info("backend-aurora.patch: boto3 patches installed")


# ── Activation entry point ───────────────────────────────────────────────

def activate():
    """Entry point invoked by `backend_loader._load_backend('aurora')`."""
    validate_connection()
    log.info("backend-aurora.patch: portal API connection validated")
    _install_patches()
