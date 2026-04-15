"""
Delete objects from an S3-compatible provider.

By default deletes all keys in manifest.json with status=done.
Updates the manifest entry to status=deleted on success.

Usage:
  python delete.py --provider aurora                        # delete all manifest done entries
  python delete.py --provider aurora --key gov-data/f.csv  # delete a specific key
  python delete.py --provider aurora --key gov-data/f.csv --version-id <vid>
  python delete.py --provider aurora --dry-run             # print what would be deleted
"""
import argparse
import os
import sys
import time

import manifest as mf
from client import resolve_provider, get_s3_client
from logger import Logger


def delete_object(s3, bucket: str, key: str, version_id: str = None) -> dict:
    kwargs = {"Bucket": bucket, "Key": key}
    if version_id:
        kwargs["VersionId"] = version_id
    resp = s3.delete_object(**kwargs)
    return {
        "delete_marker": resp.get("DeleteMarker"),
        "resp_version_id": resp.get("VersionId"),
    }


def main():
    parser = argparse.ArgumentParser(description="Delete objects from an S3-compatible provider")
    parser.add_argument("--provider", required=True, help="Provider name (e.g. aurora, fth)")
    parser.add_argument("--key", help="Specific key to delete")
    parser.add_argument("--version-id", help="Specific version ID to delete")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be deleted without actually deleting")
    args = parser.parse_args()

    provider_dir = resolve_provider(args.provider)
    log = Logger("delete", provider_dir)
    s3 = get_s3_client()
    bucket = os.environ["S3_BUCKET"]
    manifest = mf.load(provider_dir)

    if args.key:
        # Pull version_id from manifest if not specified explicitly
        stored = manifest["files"].get(args.key, {})
        version_id = args.version_id or stored.get("version_id")
        targets = [(args.key, version_id)]
    else:
        targets = [
            (k, v.get("version_id"))
            for k, v in manifest["files"].items()
            if v.get("status") == "done"
        ]

    if not targets:
        print("Nothing to delete.")
        sys.exit(0)

    prefix = "[DRY RUN] " if args.dry_run else ""
    print(f"{prefix}Deleting {len(targets)} object(s)...\n")

    for key, version_id in targets:
        label = key + (f" [version={version_id}]" if version_id else "")

        if args.dry_run:
            print(f"  would delete: {label}")
            continue

        t0 = time.monotonic()
        try:
            result = delete_object(s3, bucket, key, version_id)
            elapsed = round(time.monotonic() - t0, 3)
            manifest["files"].setdefault(key, {})["status"] = "deleted"
            mf.save(manifest, provider_dir)
            log.success("delete_object", key=key, version_id=version_id, bucket=bucket,
                        elapsed_s=elapsed, **result)
        except Exception as e:
            log.error("delete_object", e, key=key, version_id=version_id, bucket=bucket,
                      elapsed_s=round(time.monotonic() - t0, 3))

    if not args.dry_run:
        log.write_report("Delete")


if __name__ == "__main__":
    main()
