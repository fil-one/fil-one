"""
S3 Compatibility Test: runs the ceph/s3-tests suite against an S3-compatible provider.

Generates s3tests.conf from the provider's .env, runs pytest with --json-report,
parses the results, and writes a unified report in the same format
as the other test scripts.

Prerequisites:
  uv sync                                    # installs deps from pyproject.toml
  uv pip install -r ceph-s3-tests/requirements.txt

Usage:
  python compatibility_test.py --provider aurora
  python compatibility_test.py --provider aurora --marks 'not fails_on_aws'
  python compatibility_test.py --provider aurora --test-file s3tests/functional/test_s3.py::test_bucket_list_empty
  python compatibility_test.py --provider aurora --marks 'versioning and not fails_on_aws'
  python compatibility_test.py --provider aurora -k 'test_bucket_policy or test_versioning'

Notes:
  - [s3 alt] tests (cross-user) require S3_ALT_* credentials in the provider's .env.
    Without them, alt credentials fall back to main and those tests will fail.
  - IAM/STS tests require the provider to support those APIs.
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

import report as _report
from client import get_s3_client, resolve_provider

_SCRIPTS_DIR = Path(__file__).parent
S3TESTS_DIR = _SCRIPTS_DIR / "ceph-s3-tests"

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

# Pytest marks whose tests run in a separate "quarantine" pass AFTER all other
# tests.  Object-lock tests create retention-locked objects that can't be
# deleted, poisoning the per-test bucket cleanup for every subsequent test.
# Running them last prevents them from cascading into unrelated tests.
_QUARANTINE_MARKS = ["object_lock"]


def _check_prereqs():
    if not S3TESTS_DIR.exists():
        print(
            f"ERROR: s3-tests directory not found at {S3TESTS_DIR}\n"
            "Clone it with:\n"
            "  git submodule update --init tests/s3compat/ceph-s3-tests"
        )
        sys.exit(1)

    try:
        import pytest_jsonreport  # noqa: F401
    except ImportError:
        print(
            "ERROR: pytest-json-report is not installed.\n"
            "Run 'uv sync' to install all dependencies from pyproject.toml."
        )
        sys.exit(1)


def _generate_conf(tmp_dir: Path, provider: str) -> Path:
    """Write an s3tests.conf file from environment variables."""
    endpoint = os.environ.get("S3_ENDPOINT", "https://s3.example.com")
    parsed = urlparse(endpoint)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    is_secure = parsed.scheme == "https"

    main_access = os.environ["S3_ACCESS_KEY_ID"]
    main_secret = os.environ["S3_SECRET_ACCESS_KEY"]

    # Alt credentials: fall back to main if not set (cross-user tests will fail)
    alt_access = os.environ.get("S3_ALT_ACCESS_KEY_ID", main_access)
    alt_secret = os.environ.get("S3_ALT_SECRET_ACCESS_KEY", main_secret)

    main = {
        "display_name": os.environ.get("S3_DISPLAY_NAME", f"{provider}-main"),
        "user_id": os.environ.get("S3_USER_ID", f"{provider}-main-user"),
        "email": os.environ.get("S3_EMAIL", f"main@{provider}.test"),
        "access_key": main_access,
        "secret_key": main_secret,
    }
    alt = {
        "display_name": os.environ.get("S3_ALT_DISPLAY_NAME", f"{provider}-alt"),
        "user_id": os.environ.get("S3_ALT_USER_ID", f"{provider}-alt-user"),
        "email": os.environ.get("S3_ALT_EMAIL", f"alt@{provider}.test"),
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
        "bucket prefix": f"{provider}-compat-{{random}}-",
    }
    cfg["s3 main"] = main
    cfg["s3 alt"] = alt
    cfg["s3 tenant"] = {**alt, "tenant": f"{provider}-tenant"}
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


def _run_pytest(conf_path: Path, marks: str, test_target: str, json_out: Path,
                 provider: str = "", filter_expr: str = "") -> int:
    cmd = [
        sys.executable, "-m", "pytest",
        f"--json-report",
        f"--json-report-file={json_out}",
        "--tb=short",
        "-q",
    ]

    # Aurora: load the S3 bridge plugin to redirect bucket ops to Portal API
    if provider == "aurora" and os.environ.get("AURORA_PORTAL_ORIGIN"):
        cmd += ["-p", "aurora_s3_bridge"]

    if marks:
        cmd += ["-m", marks]
    if filter_expr:
        cmd += ["-k", filter_expr]
    cmd.append(test_target)

    env = {**os.environ, "S3TEST_CONF": str(conf_path)}

    # Aurora: ensure the plugin is importable and Portal env vars are forwarded
    if provider == "aurora":
        testing_dir = str(_SCRIPTS_DIR)
        env["PYTHONPATH"] = testing_dir + os.pathsep + env.get("PYTHONPATH", "")
        # Forward Portal API env vars (already in os.environ from .env load)
        for var in ("AURORA_PORTAL_ORIGIN", "AURORA_TENANT_ID", "AURORA_NO_VERIFY_SSL"):
            if var in os.environ:
                env[var] = os.environ[var]

    print(f"Command : {' '.join(str(c) for c in cmd)}")
    print(f"CWD     : {S3TESTS_DIR}")
    print(f"Marks   : {marks or '(none)'}")
    if provider == "aurora" and os.environ.get("AURORA_PORTAL_ORIGIN"):
        print(f"Plugin  : aurora_s3_bridge (Portal API bridge)")
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


def _combine_filters(user_filter: str, pass_filter: str) -> str:
    """AND two pytest -k expressions together."""
    if user_filter and pass_filter:
        return f"({user_filter}) and ({pass_filter})"
    return user_filter or pass_filter


def _cleanup_buckets(provider: str):
    """Best-effort removal of all test buckets for a provider.

    Runs between pytest passes to prevent poisoned buckets from one pass
    cascading into the next.  Logs failures but never raises.
    """
    client = get_s3_client()
    static_prefix = f"{provider}-compat-"

    try:
        buckets = client.list_buckets().get("Buckets", [])
    except Exception as e:
        print(f"  cleanup: could not list buckets: {e}")
        return

    matched = [b["Name"] for b in buckets if static_prefix in b["Name"]]
    if not matched:
        print("  cleanup: no leftover buckets found")
        return

    print(f"  cleanup: found {len(matched)} bucket(s) to remove")
    for name in matched:
        try:
            # Delete all object versions
            kwargs = {"Bucket": name, "MaxKeys": 128}
            truncated = True
            while truncated:
                listing = client.list_object_versions(**kwargs)
                objs = listing.get("Versions", []) + listing.get("DeleteMarkers", [])
                if objs:
                    client.delete_objects(
                        Bucket=name,
                        Delete={
                            "Objects": [{"Key": o["Key"], "VersionId": o["VersionId"]} for o in objs],
                            "Quiet": True,
                        },
                        BypassGovernanceRetention=True,
                    )
                truncated = listing.get("IsTruncated", False)
                kwargs["KeyMarker"] = listing.get("NextKeyMarker", "")
                kwargs["VersionIdMarker"] = listing.get("NextVersionIdMarker", "")

            client.delete_bucket(Bucket=name)
            print(f"  cleanup: deleted {name}")
        except Exception as e:
            print(f"  cleanup: could not delete {name}: {e}")


def _merge_results(json_paths: list) -> tuple:
    """Merge pytest JSON reports from multiple passes into (entries, meta)."""
    all_entries = []
    total_meta = {
        "collected": 0, "passed": 0, "failed": 0,
        "error": 0, "skipped": 0, "duration_s": 0.0,
    }

    for jp in json_paths:
        entries, meta = _parse_results(jp)
        all_entries.extend(entries)
        # 'collected' is the total in the test file — same for every pass
        if total_meta["collected"] == 0:
            total_meta["collected"] = meta["collected"]
        total_meta["passed"] += meta["passed"]
        total_meta["failed"] += meta["failed"]
        total_meta["error"] += meta["error"]
        total_meta["skipped"] += meta["skipped"]
        total_meta["duration_s"] += meta["duration_s"]

    total_meta["duration_s"] = round(total_meta["duration_s"], 1)
    return all_entries, total_meta


def main():
    parser = argparse.ArgumentParser(description="S3 compatibility tests against a provider")
    parser.add_argument("--provider", required=True, help="Provider name (e.g. aurora, fth)")
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
    parser.add_argument(
        "-k", "--filter",
        default="",
        help="Pytest -k expression to select tests by name (e.g. 'test_bucket_policy or test_versioning')",
    )
    args = parser.parse_args()

    _check_prereqs()

    provider_dir = resolve_provider(args.provider)

    logs_dir = provider_dir / "logs"
    reports_dir = provider_dir / "reports"
    logs_dir.mkdir(exist_ok=True)
    reports_dir.mkdir(exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_file = reports_dir / f"{ts}_compatibility_report.txt"

    # Build pass list: main (everything except quarantined) then quarantine.
    quarantine_expr = " or ".join(_QUARANTINE_MARKS)
    passes = [
        ("main", f"not ({quarantine_expr})"),
        ("quarantine", quarantine_expr),
    ]

    json_outs = []
    worst_exit = 0

    with tempfile.TemporaryDirectory() as tmp:
        conf_path = _generate_conf(Path(tmp), args.provider)

        for i, (pass_name, pass_filter) in enumerate(passes):
            combined = _combine_filters(args.filter, pass_filter)
            json_out = logs_dir / f"{ts}_compatibility_pytest_{pass_name}.json"

            print(f"\n{'=' * 60}")
            print(f"  Pass {i + 1}/{len(passes)}: {pass_name}")
            print(f"  Filter: {combined}")
            print(f"{'=' * 60}\n")

            exit_code = _run_pytest(
                conf_path, args.marks, args.test_file, json_out,
                provider=args.provider, filter_expr=combined,
            )
            if json_out.exists():
                json_outs.append(json_out)
            worst_exit = max(worst_exit, exit_code)

            # Best-effort cleanup between passes (not after the last one)
            if i < len(passes) - 1:
                print("\nCleaning up test buckets between passes...")
                _cleanup_buckets(args.provider)

    if not json_outs:
        print(
            "ERROR: No JSON reports produced. "
            "Make sure pytest-json-report is installed and s3-tests deps are available."
        )
        sys.exit(1)

    entries, meta = _merge_results(json_outs)

    pass_desc = ", ".join(
        f"{name} ({filt})" for name, filt in passes
    )
    json_refs = ", ".join(
        os.path.relpath(jp, reports_dir) for jp in json_outs
    )
    extra = [
        "TEST RUN",
        f"  Provider  : {args.provider}",
        f"  Collected : {meta['collected']}",
        f"  Passed    : {meta['passed']}",
        f"  Failed    : {meta['failed']}",
        f"  Error     : {meta['error']}",
        f"  Skipped   : {meta['skipped']}",
        f"  Duration  : {meta['duration_s']}s",
        f"  Marks     : {args.marks or '(none)'}",
        f"  Filter    : {args.filter or '(none)'}",
        f"  Passes    : {pass_desc}",
        f"  Target    : {args.test_file}",
        f"  Raw JSON  : {json_refs}",
    ]

    text = _report.write_report(
        title=f"S3 Compatibility Test — {args.provider}",
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

    sys.exit(0 if worst_exit == 0 else 1)


if __name__ == "__main__":
    main()
