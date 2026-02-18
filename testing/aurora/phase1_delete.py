"""
Phase 1: Delete objects from Aurora.

By default deletes all keys in manifest.json with status=done.
Updates the manifest entry to status=deleted on success.

Usage:
  python phase1_delete.py                        # delete all manifest done entries
  python phase1_delete.py --key gov-data/f.csv   # delete a specific key
  python phase1_delete.py --key gov-data/f.csv --version-id <vid>
  python phase1_delete.py --dry-run              # print what would be deleted
"""
import argparse
import os
import sys
import time

from dotenv import load_dotenv

load_dotenv()

import manifest as mf
from client import get_aurora_client
from logger import Logger


def delete_object(aurora, bucket: str, key: str, version_id: str = None) -> dict:
    kwargs = {"Bucket": bucket, "Key": key}
    if version_id:
        kwargs["VersionId"] = version_id
    resp = aurora.delete_object(**kwargs)
    return {
        "delete_marker": resp.get("DeleteMarker"),
        "version_id": resp.get("VersionId"),
    }


def main():
    parser = argparse.ArgumentParser(description="Phase 1: Delete objects from Aurora")
    parser.add_argument("--key", help="Specific key to delete")
    parser.add_argument("--version-id", help="Specific version ID to delete")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be deleted without actually deleting")
    args = parser.parse_args()

    log = Logger("phase1_delete")
    aurora = get_aurora_client()
    bucket = os.environ["AURORA_BUCKET"]
    manifest = mf.load()

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
            result = delete_object(aurora, bucket, key, version_id)
            elapsed = round(time.monotonic() - t0, 3)
            manifest["files"].setdefault(key, {})["status"] = "deleted"
            mf.save(manifest)
            log.success("delete_object", key=key, version_id=version_id, bucket=bucket,
                        elapsed_s=elapsed, **result)
        except Exception as e:
            log.error("delete_object", e, key=key, version_id=version_id, bucket=bucket,
                      elapsed_s=round(time.monotonic() - t0, 3))

    if not args.dry_run:
        log.write_report("Phase 1: Delete")


if __name__ == "__main__":
    main()
