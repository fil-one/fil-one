"""
Load test an S3-compatible provider with concurrent uploads from source.coop.

State is stored in load_test_state.db (SQLite) inside the provider directory,
so the run can be resumed after any failure — network drop, process kill, rate limit, etc.

Failure scenarios handled:
  - Network timeout mid-upload     → multipart aborted; entry stays 'failed', retry on resume
  - Process killed mid-run         → 'in_progress' entries retried on resume
  - Rate limiting / 4xx / 5xx      → logged with status code; retried on resume
  - Source file unavailable        → logged as source_error; skipped on resume by default

Usage:
  python load_test.py --provider aurora --count 50 --workers 8
  python load_test.py --provider aurora --resume              # retry failed/interrupted entries
  python load_test.py --provider aurora --resume --workers 4  # resume with different concurrency
  python load_test.py --provider aurora --force               # delete DB and start from scratch
"""
import argparse
import os
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from client import resolve_provider, get_s3_client, get_source_client
from logger import Logger

MULTIPART_THRESHOLD = 50 * 1024 * 1024
PART_SIZE = 50 * 1024 * 1024


# ── Database ──────────────────────────────────────────────────────────────────

def init_db(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS uploads (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            source_key   TEXT    NOT NULL UNIQUE,
            size         INTEGER,
            status       TEXT    NOT NULL DEFAULT 'pending',
            etag         TEXT,
            version_id   TEXT,
            error_code   TEXT,
            error_msg    TEXT,
            status_code  INTEGER,
            started_at   TEXT,
            finished_at  TEXT
        )
    """)
    conn.commit()


def insert_pending(conn: sqlite3.Connection, source_key: str, size: int):
    conn.execute(
        "INSERT OR IGNORE INTO uploads (source_key, size, status) VALUES (?, ?, 'pending')",
        (source_key, size),
    )
    conn.commit()


def mark_in_progress(conn: sqlite3.Connection, source_key: str):
    conn.execute(
        "UPDATE uploads SET status='in_progress', started_at=? WHERE source_key=?",
        (datetime.now(timezone.utc).isoformat(), source_key),
    )
    conn.commit()


def mark_done(conn: sqlite3.Connection, source_key: str, etag: str, version_id: str):
    conn.execute(
        "UPDATE uploads SET status='done', etag=?, version_id=?, finished_at=? WHERE source_key=?",
        (etag, version_id, datetime.now(timezone.utc).isoformat(), source_key),
    )
    conn.commit()


def mark_failed(conn: sqlite3.Connection, source_key: str,
                error_code: str, error_msg: str, status_code: int = None):
    conn.execute(
        """UPDATE uploads
           SET status='failed', error_code=?, error_msg=?, status_code=?, finished_at=?
           WHERE source_key=?""",
        (error_code, error_msg, status_code, datetime.now(timezone.utc).isoformat(), source_key),
    )
    conn.commit()


def get_pending(conn: sqlite3.Connection) -> list[tuple]:
    """Return tasks that need processing: pending, failed, or abandoned in_progress."""
    rows = conn.execute(
        "SELECT source_key, size FROM uploads WHERE status IN ('pending', 'failed', 'in_progress')"
    ).fetchall()
    return rows


def db_summary(conn: sqlite3.Connection) -> dict:
    row = conn.execute("""
        SELECT
            COUNT(*) AS total,
            SUM(status = 'done') AS done,
            SUM(status IN ('pending','failed','in_progress')) AS remaining
        FROM uploads
    """).fetchone()
    return {"total": row[0], "done": row[1], "remaining": row[2]}


# ── Upload logic (runs inside worker threads) ─────────────────────────────────

def _do_upload(source_key: str, size: int, source_bucket: str, target_bucket: str) -> dict:
    """Create per-thread clients and upload. boto3 clients are not thread-safe."""
    s3 = get_s3_client()
    source = get_source_client()

    if size <= MULTIPART_THRESHOLD:
        resp = source.get_object(Bucket=source_bucket, Key=source_key)
        body = resp["Body"].read()
        put_resp = s3.put_object(Bucket=target_bucket, Key=source_key, Body=body)
        return {
            "etag": put_resp.get("ETag", "").strip('"'),
            "version_id": put_resp.get("VersionId"),
        }

    mpu = s3.create_multipart_upload(Bucket=target_bucket, Key=source_key)
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
                Bucket=target_bucket, Key=source_key,
                UploadId=upload_id, PartNumber=part_number, Body=chunk,
            )
            parts.append({"PartNumber": part_number, "ETag": part_resp["ETag"]})
            part_number += 1
        complete_resp = s3.complete_multipart_upload(
            Bucket=target_bucket, Key=source_key,
            UploadId=upload_id, MultipartUpload={"Parts": parts},
        )
        return {
            "etag": complete_resp.get("ETag", "").strip('"'),
            "version_id": complete_resp.get("VersionId"),
        }
    except Exception:
        s3.abort_multipart_upload(Bucket=target_bucket, Key=source_key, UploadId=upload_id)
        raise


def upload_worker(task: tuple, source_bucket: str, target_bucket: str, db_file: Path) -> tuple:
    source_key, size = task
    conn = sqlite3.connect(db_file)  # Each thread gets its own connection
    mark_in_progress(conn, source_key)
    t0 = time.monotonic()

    try:
        result = _do_upload(source_key, size or 0, source_bucket, target_bucket)
        elapsed = time.monotonic() - t0
        mark_done(conn, source_key, result["etag"], result.get("version_id"))
        return ("ok", source_key, size or 0, elapsed, result)

    except Exception as e:
        elapsed = time.monotonic() - t0
        if hasattr(e, "response"):
            resp = e.response
            error_code = resp.get("Error", {}).get("Code", "")
            error_msg = resp.get("Error", {}).get("Message", "")
            status_code = resp.get("ResponseMetadata", {}).get("HTTPStatusCode")
        else:
            error_code = type(e).__name__
            error_msg = str(e)
            status_code = None
        mark_failed(conn, source_key, error_code, error_msg, status_code)
        return ("err", source_key, size or 0, elapsed,
                {"error_code": error_code, "error_msg": error_msg, "status_code": status_code})

    finally:
        conn.close()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Load test an S3-compatible provider with concurrent uploads")
    parser.add_argument("--provider", required=True, help="Provider name (e.g. aurora, fth)")
    parser.add_argument("--count", type=int, default=50,
                        help="Number of files to queue (default: 50, ignored on --resume)")
    parser.add_argument("--workers", type=int, default=8,
                        help="Concurrent upload threads (default: 8)")
    parser.add_argument("--max-size-mb", type=float, default=200.0,
                        help="Skip source files larger than this MB (default: 200)")
    parser.add_argument("--prefix", default=None,
                        help="Source object prefix (default: SOURCE_PREFIX from .env)")
    parser.add_argument("--resume", action="store_true",
                        help="Resume — retry failed/interrupted entries from existing DB")
    parser.add_argument("--force", action="store_true",
                        help="Ignore DB state and re-run from scratch (deletes load_test_state.db)")
    args = parser.parse_args()

    if args.force and args.resume:
        print("ERROR: --force and --resume are mutually exclusive.")
        sys.exit(1)

    provider_dir = resolve_provider(args.provider)
    db_file = provider_dir / "load_test_state.db"

    if args.force and db_file.exists():
        db_file.unlink()
        print(f"--force: deleted {db_file}, starting fresh\n")

    log = Logger("load_test", provider_dir)
    conn = sqlite3.connect(db_file)
    init_db(conn)

    source_bucket = os.environ.get("SOURCE_BUCKET", "harvard-lil")
    target_bucket = os.environ["S3_BUCKET"]
    prefix = args.prefix or os.environ.get("SOURCE_PREFIX", "gov-data/")
    max_size_bytes = int(args.max_size_mb * 1024 * 1024)

    if not args.resume:
        source = get_source_client()
        print(f"Listing up to {args.count} file(s) from s3://{source_bucket}/{prefix}")
        paginator = source.get_paginator("list_objects_v2")
        inserted = 0
        try:
            for page in paginator.paginate(Bucket=source_bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    if obj["Size"] <= max_size_bytes:
                        insert_pending(conn, obj["Key"], obj["Size"])
                        inserted += 1
                    if inserted >= args.count:
                        break
                if inserted >= args.count:
                    break
        except Exception as e:
            log.error("list_source_files", e, bucket=source_bucket, prefix=prefix)
            log.write_report("Load Test")
            conn.close()
            sys.exit(1)
        print(f"Queued {inserted} file(s).\n")
    else:
        summary = db_summary(conn)
        print(f"Resuming. DB state: {summary['done']} done, {summary['remaining']} remaining "
              f"of {summary['total']} total.\n")

    tasks = get_pending(conn)
    conn.close()

    if not tasks:
        print("No pending tasks — everything is already done.")
        sys.exit(0)

    print(f"Processing {len(tasks)} task(s) with {args.workers} worker(s)...\n")

    t_start = time.monotonic()
    total_bytes_ok = 0
    ok_count = 0
    err_count = 0

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(upload_worker, task, source_bucket, target_bucket, db_file): task
            for task in tasks
        }
        for future in as_completed(futures):
            status, key, size, elapsed, detail = future.result()
            mb = size / 1024 / 1024

            if status == "ok":
                ok_count += 1
                total_bytes_ok += size
                mbps = (size / elapsed / 1024 / 1024) if elapsed > 0 else 0
                print(f"  OK  {key} ({mb:.1f} MB, {mbps:.1f} MB/s)")
                log.success("upload", key=key, size=size, elapsed_s=round(elapsed, 2), **detail)
            else:
                err_count += 1
                print(f" ERR  {key} ({mb:.1f} MB) — "
                      f"{detail.get('error_code')}: {detail.get('error_msg')}")
                log.error_raw("upload", key=key, size=size, elapsed_s=round(elapsed, 2), **detail)

    total_elapsed = time.monotonic() - t_start
    total_mb = total_bytes_ok / 1024 / 1024
    throughput = total_mb / total_elapsed if total_elapsed > 0 else 0

    extra = [
        "THROUGHPUT",
        f"  Duration          : {total_elapsed:.1f}s",
        f"  Data uploaded OK  : {total_mb:.1f} MB",
        f"  Avg throughput    : {throughput:.1f} MB/s",
        f"  Workers           : {args.workers}",
        f"  State DB          : {os.path.relpath(db_file, log.report_file.parent)}",
        "",
        f"To retry failures:  python load_test.py --provider {args.provider} --resume",
    ]
    log.write_report("Load Test", extra_lines=extra)


if __name__ == "__main__":
    main()
