"""
Upload a small number of files from source.coop to an S3-compatible provider.

Streams each file directly (source → provider) without writing to disk.
Uses multipart upload for files over MULTIPART_THRESHOLD.
Tracks state in manifest.json — re-running skips already-done keys.

Usage:
  python upload.py --provider aurora [--count N] [--max-size-mb M] [--prefix PREFIX]
  python upload.py --provider aurora --force   # ignore manifest, re-upload everything

Resume:
  Just re-run the same command. Done entries in manifest.json are skipped.
"""
import argparse
import os
import sys
import time

import manifest as mf
from client import resolve_provider, get_s3_client, get_source_client
from logger import Logger

MULTIPART_THRESHOLD = 50 * 1024 * 1024  # 50 MB — use multipart above this
PART_SIZE = 50 * 1024 * 1024            # 50 MB parts


def list_source_files(source, bucket: str, prefix: str, max_count: int, max_size_bytes: int) -> list:
    paginator = source.get_paginator("list_objects_v2")
    results = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            if obj["Size"] <= max_size_bytes:
                results.append(obj)
            if len(results) >= max_count:
                return results
    return results


def upload_small(s3, source, source_bucket: str, source_key: str,
                 target_bucket: str, target_key: str) -> dict:
    """Read full object into memory and put_object to the provider."""
    resp = source.get_object(Bucket=source_bucket, Key=source_key)
    body = resp["Body"].read()
    put_resp = s3.put_object(
        Bucket=target_bucket,
        Key=target_key,
        Body=body,
        ContentLength=len(body),
    )
    return {
        "etag": put_resp.get("ETag", "").strip('"'),
        "version_id": put_resp.get("VersionId"),
    }


def upload_multipart(s3, source, source_bucket: str, source_key: str,
                     target_bucket: str, target_key: str) -> dict:
    """Stream object in PART_SIZE chunks via multipart upload."""
    mpu = s3.create_multipart_upload(Bucket=target_bucket, Key=target_key)
    upload_id = mpu["UploadId"]
    parts = []
    part_number = 1

    try:
        resp = source.get_object(Bucket=source_bucket, Key=source_key)
        stream = resp["Body"]

        while True:
            chunk = stream.read(PART_SIZE)
            if not chunk:
                break
            part_resp = s3.upload_part(
                Bucket=target_bucket,
                Key=target_key,
                UploadId=upload_id,
                PartNumber=part_number,
                Body=chunk,
            )
            parts.append({"PartNumber": part_number, "ETag": part_resp["ETag"]})
            print(f"    part {part_number} ({len(chunk) / 1024 / 1024:.1f} MB)")
            part_number += 1

        complete_resp = s3.complete_multipart_upload(
            Bucket=target_bucket,
            Key=target_key,
            UploadId=upload_id,
            MultipartUpload={"Parts": parts},
        )
        return {
            "etag": complete_resp.get("ETag", "").strip('"'),
            "version_id": complete_resp.get("VersionId"),
            "parts": len(parts),
        }
    except Exception:
        # Abort so incomplete parts don't linger
        s3.abort_multipart_upload(
            Bucket=target_bucket, Key=target_key, UploadId=upload_id
        )
        raise


def main():
    parser = argparse.ArgumentParser(description="Upload files from source.coop to an S3-compatible provider")
    parser.add_argument("--provider", required=True, help="Provider name (e.g. aurora, fth)")
    parser.add_argument("--count", type=int, default=5,
                        help="Number of files to upload (default: 5)")
    parser.add_argument("--max-size-mb", type=float, default=200.0,
                        help="Skip files larger than this in MB (default: 200)")
    parser.add_argument("--prefix", default=None,
                        help="Source object prefix (default: SOURCE_PREFIX from .env)")
    parser.add_argument("--force", action="store_true",
                        help="Ignore manifest state and re-upload all files")
    args = parser.parse_args()

    provider_dir = resolve_provider(args.provider)
    log = Logger("upload", provider_dir)
    manifest = mf.load(provider_dir)

    if args.force:
        manifest["files"] = {}
        mf.save(manifest, provider_dir)
        print("--force: manifest cleared, re-uploading all files\n")

    s3 = get_s3_client()
    source = get_source_client()

    source_bucket = os.environ.get("SOURCE_BUCKET", "harvard-lil")
    target_bucket = os.environ["S3_BUCKET"]
    prefix = args.prefix or os.environ.get("SOURCE_PREFIX", "gov-data/")
    max_size_bytes = int(args.max_size_mb * 1024 * 1024)

    print(f"Listing files from source.coop: s3://{source_bucket}/{prefix}")
    try:
        objects = list_source_files(source, source_bucket, prefix, args.count, max_size_bytes)
    except Exception as e:
        log.error("list_source_files", e, bucket=source_bucket, prefix=prefix)
        log.write_report("Upload")
        sys.exit(1)

    if not objects:
        print("No files found matching criteria.")
        sys.exit(0)

    print(f"Found {len(objects)} file(s). Uploading...\n")

    for obj in objects:
        key = obj["Key"]
        size = obj["Size"]

        if mf.is_done(manifest, key):
            print(f" SKIP [{key}] already done in manifest")
            continue

        size_mb = size / 1024 / 1024
        print(f"Uploading: {key} ({size_mb:.2f} MB)")

        t0 = time.monotonic()
        try:
            if size <= MULTIPART_THRESHOLD:
                result = upload_small(s3, source, source_bucket, key, target_bucket, key)
            else:
                result = upload_multipart(s3, source, source_bucket, key, target_bucket, key)

            elapsed = round(time.monotonic() - t0, 3)
            mf.mark_done(manifest, provider_dir, key, size=size, target_bucket=target_bucket, **result)
            log.success("upload", key=key, size=size, elapsed_s=elapsed,
                        target_bucket=target_bucket, **result)

        except Exception as e:
            elapsed = round(time.monotonic() - t0, 3)
            mf.mark_failed(manifest, provider_dir, key, reason=str(e))
            log.error("upload", e, key=key, size=size, elapsed_s=elapsed,
                      source_bucket=source_bucket, target_bucket=target_bucket)

    log.write_report("Upload")


if __name__ == "__main__":
    main()
