"""
Create a bucket on an S3-compatible provider with optional versioning, object lock, and encryption.

Object lock must be enabled at creation time and cannot be added later.
Versioning, encryption, and the default retention policy are applied immediately after creation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BASIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Create bucket using S3_BUCKET from .env
  python create_bucket.py --provider fth

  # Override bucket name
  python create_bucket.py --provider fth --bucket my-other-bucket

  # Specify a region/location constraint
  python create_bucket.py --provider fth --region us-west-2

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VERSIONING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Enable versioning
  python create_bucket.py --provider fth --versioning

  # Versioning + encryption
  python create_bucket.py --provider fth --versioning --encryption

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENCRYPTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Enable AES256 server-side encryption (SSE-S3)
  python create_bucket.py --provider fth --encryption

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OBJECT LOCK (governance — privileged users can override)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Object lock only (no default retention policy)
  python create_bucket.py --provider fth --object-lock

  # Object lock with 90-day governance retention
  python create_bucket.py --provider fth --object-lock --retention-days 90

  # Object lock with 365-day governance retention
  python create_bucket.py --provider fth --object-lock --retention-days 365

  # Object lock + encryption
  python create_bucket.py --provider fth --object-lock --retention-days 365 --encryption

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OBJECT LOCK (compliance — no overrides, even for root)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Compliance mode with 90-day retention
  python create_bucket.py --provider fth --object-lock --retention-mode COMPLIANCE --retention-days 90

  # Compliance mode with 365-day retention
  python create_bucket.py --provider fth --object-lock --retention-mode COMPLIANCE --retention-days 365

  # Compliance + encryption
  python create_bucket.py --provider fth --object-lock --retention-mode COMPLIANCE --retention-days 365 --encryption

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FULL SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Governance + encryption (versioning implied by object lock)
  python create_bucket.py --provider fth --object-lock --retention-days 365 --encryption

  # Compliance + encryption (versioning implied by object lock)
  python create_bucket.py --provider fth --object-lock --retention-mode COMPLIANCE --retention-days 365 --encryption

  # Versioning + encryption, no lock
  python create_bucket.py --provider fth --versioning --encryption

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RETENTION MODES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GOVERNANCE  Privileged users with s3:BypassGovernanceRetention can delete or
              shorten the retention period. Good for internal policy enforcement
              where escape hatches are needed.

  COMPLIANCE  No one — including root — can shorten retention or remove the
              policy before it expires. Use for regulatory requirements (SEC 17a-4,
              FINRA, HIPAA, etc.) where immutability must be provable.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - --object-lock must be set at creation; it cannot be added to an existing bucket
  - --object-lock implicitly enables versioning (S3 requirement); --versioning is redundant but harmless
  - --retention-days requires --object-lock
  - --retention-mode defaults to GOVERNANCE; only meaningful with --object-lock
  - --encryption applies AES256 (SSE-S3); no KMS key required
  - Each step (create, versioning, retention, encryption) is logged independently
    so partial failures are visible in the report
"""
import argparse
import os
import sys
import time

from client import resolve_provider, get_s3_client
from logger import Logger


def _create_bucket(s3, log: Logger, bucket: str, region: str, object_lock: bool):
    kwargs = {"Bucket": bucket}
    if region:
        kwargs["CreateBucketConfiguration"] = {"LocationConstraint": region}
    if object_lock:
        kwargs["ObjectLockEnabledForBucket"] = True

    print(f"Creating bucket: {bucket}" + (" (object lock enabled)" if object_lock else ""))
    t0 = time.monotonic()
    try:
        resp = s3.create_bucket(**kwargs)
        elapsed = round(time.monotonic() - t0, 3)
        log.success("create_bucket", bucket=bucket, location=resp.get("Location", ""),
                    object_lock_enabled=object_lock, elapsed_s=elapsed)
        return True
    except Exception as e:
        log.error("create_bucket", e, bucket=bucket, elapsed_s=round(time.monotonic() - t0, 3))
        return False


def _put_retention(s3, log: Logger, bucket: str, mode: str, days: int):
    print(f"Setting default retention: {mode}, {days} day(s)")
    t0 = time.monotonic()
    try:
        s3.put_object_lock_configuration(
            Bucket=bucket,
            ObjectLockConfiguration={
                "ObjectLockEnabled": "Enabled",
                "Rule": {
                    "DefaultRetention": {
                        "Mode": mode,
                        "Days": days,
                    }
                },
            },
        )
        log.success("put_object_lock_configuration", bucket=bucket,
                    retention_mode=mode, retention_days=days,
                    elapsed_s=round(time.monotonic() - t0, 3))
    except Exception as e:
        log.error("put_object_lock_configuration", e, bucket=bucket,
                  retention_mode=mode, retention_days=days,
                  elapsed_s=round(time.monotonic() - t0, 3))


def _put_versioning(s3, log: Logger, bucket: str):
    print("Enabling versioning")
    t0 = time.monotonic()
    try:
        s3.put_bucket_versioning(
            Bucket=bucket,
            VersioningConfiguration={"Status": "Enabled"},
        )
        log.success("put_bucket_versioning", bucket=bucket, status="Enabled",
                    elapsed_s=round(time.monotonic() - t0, 3))
    except Exception as e:
        log.error("put_bucket_versioning", e, bucket=bucket,
                  elapsed_s=round(time.monotonic() - t0, 3))


def _put_encryption(s3, log: Logger, bucket: str):
    print("Setting encryption: AES256 (SSE-S3)")
    t0 = time.monotonic()
    try:
        s3.put_bucket_encryption(
            Bucket=bucket,
            ServerSideEncryptionConfiguration={
                "Rules": [
                    {
                        "ApplyServerSideEncryptionByDefault": {
                            "SSEAlgorithm": "AES256",
                        },
                        "BucketKeyEnabled": False,
                    }
                ]
            },
        )
        log.success("put_bucket_encryption", bucket=bucket, algorithm="AES256",
                    elapsed_s=round(time.monotonic() - t0, 3))
    except Exception as e:
        log.error("put_bucket_encryption", e, bucket=bucket,
                  elapsed_s=round(time.monotonic() - t0, 3))


def main():
    parser = argparse.ArgumentParser(description="Create a bucket on an S3-compatible provider")
    parser.add_argument("--provider", required=True, help="Provider name (e.g. aurora, fth)")
    parser.add_argument("--bucket", help="Bucket name (default: S3_BUCKET from .env)")
    parser.add_argument("--region", help="Location constraint for bucket creation (omit for us-east-1 equivalent)")
    parser.add_argument("--object-lock", action="store_true",
                        help="Enable object lock (must be set at creation time)")
    parser.add_argument("--retention-mode", choices=["GOVERNANCE", "COMPLIANCE"],
                        default="GOVERNANCE",
                        help="Default retention mode (default: GOVERNANCE; requires --object-lock)")
    parser.add_argument("--retention-days", type=int,
                        help="Default retention period in days (requires --object-lock)")
    parser.add_argument("--versioning", action="store_true",
                        help="Enable versioning (automatically enabled by --object-lock)")
    parser.add_argument("--encryption", action="store_true",
                        help="Enable AES256 server-side encryption (SSE-S3)")
    args = parser.parse_args()

    if args.retention_days and not args.object_lock:
        print("ERROR: --retention-days requires --object-lock", file=sys.stderr)
        sys.exit(1)

    provider_dir = resolve_provider(args.provider)
    log = Logger("create_bucket", provider_dir)
    s3 = get_s3_client()
    bucket = args.bucket or os.environ["S3_BUCKET"]

    created = _create_bucket(s3, log, bucket, args.region, args.object_lock)

    if not created:
        log.write_report("Create Bucket")
        sys.exit(1)

    if args.versioning and not args.object_lock:
        # object-lock enables versioning implicitly; avoid a redundant call
        _put_versioning(s3, log, bucket)

    if args.object_lock and args.retention_days:
        _put_retention(s3, log, bucket, args.retention_mode, args.retention_days)

    if args.encryption:
        _put_encryption(s3, log, bucket)

    log.write_report("Create Bucket")


if __name__ == "__main__":
    main()
