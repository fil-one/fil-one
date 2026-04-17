"""
Fetch objects from an S3-compatible provider — metadata, content preview, and version listing.

By default operates on all keys in manifest.json with status=done.
Pass --key to target a specific key, optionally with --version-id.

Usage:
  python fetch.py --provider aurora
  python fetch.py --provider aurora --key gov-data/somefile.csv
  python fetch.py --provider aurora --key gov-data/somefile.csv --version-id <vid>
"""
import argparse
import os
import sys
import time

import manifest as mf
from client import resolve_provider, get_s3_client
from logger import Logger

PREVIEW_BYTES = 1024  # bytes to read for content preview


def head_object(s3, bucket: str, key: str, version_id: str = None) -> dict:
    kwargs = {"Bucket": bucket, "Key": key}
    if version_id:
        kwargs["VersionId"] = version_id
    resp = s3.head_object(**kwargs)
    return {
        "content_length": resp.get("ContentLength"),
        "content_type": resp.get("ContentType"),
        "last_modified": str(resp.get("LastModified")),
        "etag": resp.get("ETag", "").strip('"'),
        "version_id": resp.get("VersionId"),
        "metadata": resp.get("Metadata", {}),
    }


def get_object_preview(s3, bucket: str, key: str, version_id: str = None) -> dict:
    kwargs = {
        "Bucket": bucket,
        "Key": key,
        "Range": f"bytes=0-{PREVIEW_BYTES - 1}",
    }
    if version_id:
        kwargs["VersionId"] = version_id
    resp = s3.get_object(**kwargs)
    preview = resp["Body"].read(PREVIEW_BYTES)
    return {
        "content_length": resp.get("ContentLength"),
        "content_type": resp.get("ContentType"),
        "etag": resp.get("ETag", "").strip('"'),
        "version_id": resp.get("VersionId"),
        "preview_bytes_read": len(preview),
        "preview_hex_sample": preview[:64].hex(),
    }


def list_versions(s3, bucket: str, key: str) -> list:
    resp = s3.list_object_versions(Bucket=bucket, Prefix=key)
    return [
        {
            "version_id": v.get("VersionId"),
            "last_modified": str(v.get("LastModified")),
            "etag": v.get("ETag", "").strip('"'),
            "size": v.get("Size"),
            "is_latest": v.get("IsLatest"),
        }
        for v in resp.get("Versions", [])
        if v.get("Key") == key  # Prefix match may return sibling keys
    ]


def fetch_key(s3, log: Logger, bucket: str, key: str, version_id: str = None):
    label = f"{key}" + (f" [version={version_id}]" if version_id else "")
    print(f"\nFetching: {label}")

    # HeadObject
    t0 = time.monotonic()
    try:
        meta = head_object(s3, bucket, key, version_id)
        log.success("head_object", key=key, elapsed_s=round(time.monotonic() - t0, 3), **meta)
    except Exception as e:
        log.error("head_object", e, key=key, version_id=version_id, bucket=bucket,
                  elapsed_s=round(time.monotonic() - t0, 3))

    # GetObject (preview only — no full download)
    t0 = time.monotonic()
    try:
        preview = get_object_preview(s3, bucket, key, version_id)
        log.success("get_object_preview", key=key, elapsed_s=round(time.monotonic() - t0, 3), **preview)
    except Exception as e:
        log.error("get_object_preview", e, key=key, version_id=version_id, bucket=bucket,
                  elapsed_s=round(time.monotonic() - t0, 3))

    # ListObjectVersions
    t0 = time.monotonic()
    try:
        versions = list_versions(s3, bucket, key)
        log.success("list_versions", key=key, version_count=len(versions), versions=versions,
                    elapsed_s=round(time.monotonic() - t0, 3))
    except Exception as e:
        log.error("list_versions", e, key=key, bucket=bucket,
                  elapsed_s=round(time.monotonic() - t0, 3))


def main():
    parser = argparse.ArgumentParser(description="Fetch objects from an S3-compatible provider")
    parser.add_argument("--provider", required=True, help="Provider name (e.g. aurora, fth)")
    parser.add_argument("--key", help="Specific key to fetch (skips manifest)")
    parser.add_argument("--version-id", help="Version ID for --key")
    args = parser.parse_args()

    provider_dir = resolve_provider(args.provider)
    log = Logger("fetch", provider_dir)
    s3 = get_s3_client()
    bucket = os.environ["S3_BUCKET"]

    if args.key:
        fetch_key(s3, log, bucket, args.key, args.version_id)
    else:
        manifest = mf.load(provider_dir)
        done_keys = [k for k, v in manifest["files"].items() if v.get("status") == "done"]
        if not done_keys:
            print("No done entries in manifest.json. Run upload.py first.")
            sys.exit(1)
        print(f"Fetching {len(done_keys)} key(s) from manifest...")
        for key in done_keys:
            version_id = manifest["files"][key].get("version_id")
            fetch_key(s3, log, bucket, key, version_id)

    log.write_report("Fetch")


if __name__ == "__main__":
    main()
