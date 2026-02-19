"""
S3 Compatibility Test: runs the ceph/s3-tests suite against Aurora.

Generates s3tests.conf from .env, runs pytest with --json-report,
parses the results, and writes a unified report in the same format
as the other test scripts.

Prerequisites:
  pip install pytest pytest-json-report
  pip install -r ../s3-tests/requirements.txt

Usage:
  python compatibility_test.py
  python compatibility_test.py --marks 'not fails_on_aws'
  python compatibility_test.py --test-file s3tests/functional/test_s3.py::test_bucket_list_empty
  python compatibility_test.py --marks 'versioning and not fails_on_aws'

Notes:
  - [s3 alt] tests (cross-user) require AURORA_ALT_* credentials in .env.
    Without them, alt credentials fall back to main and those tests will fail.
  - IAM/STS tests require Aurora to support those APIs.
  - Default marks filter ('not fails_on_aws') excludes tests known to fail
    on real AWS S3, giving the most meaningful compatibility signal.
"""
import argparse
import configparser
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv()

import report as _report

_BASE = Path(__file__).parent
S3TESTS_DIR = _BASE.parent / "s3-tests"

# Marks defined in s3-tests pytest.ini that represent test categories.
# Checked in priority order — first match wins for grouping.
_FEATURE_MARKS = [
    "versioning",
    "lifecycle_expiration",
    "lifecycle_transition",
    "lifecycle",
    "encryption",
    "bucket_encryption",
    "sse_s3",
    "object_lock",
    "tagging",
    "copy",
    "bucket_policy",
    "bucket_logging",
    "checksum",
    "conditional_write",
    "appendobject",
    "s3website",
    "s3select",
    "list_objects_v2",
    "storage_class",
    "cloud_transition",
    "cloud_restore",
    "auth_aws4",
    "auth_aws2",
    "auth_common",
    "delete_marker",
    "iam_user",
    "iam_tenant",
    "iam_account",
    "iam_role",
    "iam_cross_account",
    "user_policy",
    "role_policy",
    "group_policy",
    "test_of_sts",
    "webidentity_test",
    "abac_test",
]
_FEATURE_MARKS_SET = set(_FEATURE_MARKS)


def _check_prereqs():
    if not S3TESTS_DIR.exists():
        print(
            f"ERROR: s3-tests directory not found at {S3TESTS_DIR}\n"
            "Clone it with:\n"
            "  git clone https://github.com/ceph/s3-tests ../s3-tests"
        )
        sys.exit(1)

    try:
        subprocess.run(
            [sys.executable, "-m", "pytest_json_report", "--version"],
            capture_output=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Try importing directly — the version check above is best-effort
        try:
            import pytest_jsonreport  # noqa: F401
        except ImportError:
            print(
                "ERROR: pytest-json-report is not installed.\n"
                "Install it with:  pip install pytest-json-report"
            )
            sys.exit(1)


def _generate_conf(tmp_dir: Path) -> Path:
    """Write an s3tests.conf file from environment variables."""
    endpoint = os.environ.get("AURORA_ENDPOINT", "https://a-s3.aur.lu")
    parsed = urlparse(endpoint)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    is_secure = parsed.scheme == "https"

    main_access = os.environ["AURORA_ACCESS_KEY_ID"]
    main_secret = os.environ["AURORA_SECRET_ACCESS_KEY"]

    # Alt credentials: fall back to main if not set (cross-user tests will fail)
    alt_access = os.environ.get("AURORA_ALT_ACCESS_KEY_ID", main_access)
    alt_secret = os.environ.get("AURORA_ALT_SECRET_ACCESS_KEY", main_secret)

    main = {
        "display_name": os.environ.get("AURORA_DISPLAY_NAME", "aurora-main"),
        "user_id": os.environ.get("AURORA_USER_ID", "aurora-main-user"),
        "email": os.environ.get("AURORA_EMAIL", "main@aurora.test"),
        "access_key": main_access,
        "secret_key": main_secret,
    }
    alt = {
        "display_name": os.environ.get("AURORA_ALT_DISPLAY_NAME", "aurora-alt"),
        "user_id": os.environ.get("AURORA_ALT_USER_ID", "aurora-alt-user"),
        "email": os.environ.get("AURORA_ALT_EMAIL", "alt@aurora.test"),
        "access_key": alt_access,
        "secret_key": alt_secret,
    }

    cfg = configparser.RawConfigParser()

    cfg["DEFAULT"] = {
        "host": host,
        "port": str(port),
        "is_secure": str(is_secure),
        "ssl_verify": "True",
    }
    cfg["fixtures"] = {
        "bucket prefix": "aurora-compat-{random}-",
    }
    cfg["s3 main"] = main
    cfg["s3 alt"] = alt
    cfg["s3 tenant"] = {**alt, "tenant": "aurora-tenant"}
    cfg["iam"] = main
    cfg["iam root"] = {
        "access_key": main_access,
        "secret_key": main_secret,
        "user_id": main["user_id"],
        "email": main["email"],
    }
    cfg["iam alt root"] = {
        "access_key": alt_access,
        "secret_key": alt_secret,
        "user_id": alt["user_id"],
        "email": alt["email"],
    }

    conf_path = tmp_dir / "s3tests.conf"
    with open(conf_path, "w") as f:
        cfg.write(f)
    return conf_path


def _run_pytest(conf_path: Path, marks: str, test_target: str, json_out: Path) -> int:
    cmd = [
        sys.executable, "-m", "pytest",
        f"--json-report",
        f"--json-report-file={json_out}",
        "--tb=short",
        "-q",
    ]
    if marks:
        cmd += ["-m", marks]
    cmd.append(test_target)

    env = {**os.environ, "S3TEST_CONF": str(conf_path)}

    print(f"Command : {' '.join(str(c) for c in cmd)}")
    print(f"CWD     : {S3TESTS_DIR}")
    print(f"Marks   : {marks or '(none)'}")
    print()

    result = subprocess.run(cmd, cwd=S3TESTS_DIR, env=env)
    return result.returncode


def _test_category(test: dict) -> str:
    """Map a test to a category using its pytest marks (keywords)."""
    raw = test.get("keywords", [])
    keywords = set(raw.keys() if isinstance(raw, dict) else raw)
    for mark in _FEATURE_MARKS:
        if mark in keywords:
            return mark
    # Fall back to module
    node = test.get("nodeid", "")
    for fragment, label in [
        ("test_s3.py", "s3_core"),
        ("test_iam.py", "iam"),
        ("test_sts.py", "sts"),
        ("test_headers.py", "headers"),
        ("test_s3select.py", "s3select"),
        ("test_sns.py", "sns"),
    ]:
        if fragment in node:
            return label
    return "other"


def _parse_results(json_out: Path) -> tuple:
    """Returns (entries, meta) from the pytest JSON report."""
    with open(json_out) as f:
        data = json.load(f)

    summary = data.get("summary", {})
    entries = []

    for test in data.get("tests", []):
        outcome = test.get("outcome", "unknown")
        if outcome == "skipped":
            continue  # Tracked in meta, not in entries

        # Sum all phase durations for total wall time
        elapsed = sum(
            test.get(phase, {}).get("duration", 0.0)
            for phase in ("setup", "call", "teardown")
        )

        entry = {
            "op": _test_category(test),
            "status": "ok" if outcome == "passed" else "err",
            "outcome": outcome,
            "test": test.get("nodeid", ""),
            "elapsed_s": round(elapsed, 3),
        }

        if outcome in ("failed", "error"):
            # Prefer call phase, fall back to setup/teardown
            for phase in ("call", "setup", "teardown"):
                phase_data = test.get(phase)
                if phase_data and phase_data.get("longrepr"):
                    # Trim long tracebacks — full detail is in the raw JSON log
                    entry["longrepr"] = phase_data["longrepr"][:600]
                    break

        entries.append(entry)

    meta = {
        "collected": summary.get("collected", 0),
        "passed": summary.get("passed", 0),
        "failed": summary.get("failed", 0),
        "error": summary.get("error", 0),
        "skipped": summary.get("skipped", 0),
        "duration_s": round(data.get("duration", 0.0), 1),
    }
    return entries, meta


def main():
    parser = argparse.ArgumentParser(description="S3 compatibility tests against Aurora")
    parser.add_argument(
        "--marks",
        default="not fails_on_aws",
        help="Pytest mark expression (default: 'not fails_on_aws')",
    )
    parser.add_argument(
        "--test-file",
        default="s3tests/functional/test_s3.py",
        help="Test file or nodeid (default: s3tests/functional/test_s3.py)",
    )
    args = parser.parse_args()

    _check_prereqs()

    logs_dir = _BASE / "logs"
    reports_dir = _BASE / "reports"
    logs_dir.mkdir(exist_ok=True)
    reports_dir.mkdir(exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_out = logs_dir / f"{ts}_compatibility_pytest_raw.json"
    report_file = reports_dir / f"{ts}_compatibility_report.txt"

    with tempfile.TemporaryDirectory() as tmp:
        conf_path = _generate_conf(Path(tmp))
        exit_code = _run_pytest(conf_path, args.marks, args.test_file, json_out)

    if not json_out.exists():
        print(
            "ERROR: No JSON report produced. "
            "Make sure pytest-json-report is installed and s3-tests deps are available."
        )
        sys.exit(1)

    entries, meta = _parse_results(json_out)

    extra = [
        "TEST RUN",
        f"  Collected : {meta['collected']}",
        f"  Passed    : {meta['passed']}",
        f"  Failed    : {meta['failed']}",
        f"  Error     : {meta['error']}",
        f"  Skipped   : {meta['skipped']}",
        f"  Duration  : {meta['duration_s']}s",
        f"  Marks     : {args.marks or '(none)'}",
        f"  Target    : {args.test_file}",
        f"  Raw JSON  : {json_out}",
    ]

    text = _report.write_report(
        title="S3 Compatibility Test",
        script_name="compatibility_test",
        ts=ts,
        entries=entries,
        report_file=report_file,
        extra_lines=extra,
        group_label="BY CATEGORY",
        show_successes=False,  # Hundreds of passing tests — errors are what matter
    )

    print(f"\n{text}")
    print(f"Report written to: {report_file}")

    sys.exit(0 if exit_code == 0 else 1)


if __name__ == "__main__":
    main()
