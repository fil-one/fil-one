# Aurora S3 Testing

Two test suites against the Aurora S3-compatible API:

1. **Upload, fetch, delete, and load tests** — targeted upload, fetch, delete, and load tests using the `harvard-lil/gov-data` dataset on source.coop. Files are streamed directly (source → Aurora) without writing to disk.
2. **Compatibility Test** — runs the [ceph/s3-tests](https://github.com/ceph/s3-tests) suite (~750 tests) against Aurora to measure full S3 API compatibility.

All scripts share a unified report format: timestamped files in `aurora/logs/` and `aurora/reports/`.

---

## Setup

**Install dependencies:**
```bash
cd testing
pip install -r requirements.txt
pip install -r s3-tests/requirements.txt   # needed for compatibility_test.py
```

**Configure credentials:**
```bash
cp aurora/.env.example aurora/.env
# Edit aurora/.env — at minimum set S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET
```

All scripts must be run from the `testing/` directory:
```bash
cd testing
```

---

## Basic Operations

### Upload

Streams files directly from source.coop → Aurora without local download. State saved to `manifest.json` after each file — re-running skips already-done keys.

```bash
# Upload 5 files up to 200 MB each (defaults)
python upload.py --provider aurora

# Upload 10 files, skip anything over 50 MB
python upload.py --provider aurora --count 10 --max-size-mb 50

# Different source prefix
python upload.py --provider aurora --prefix gov-data/collections/
```

**Resume after failure:** re-run the same command. Done entries in `manifest.json` are skipped.

**Force re-upload** (ignore manifest, re-upload everything):
```bash
python upload.py --provider aurora --force
python upload.py --provider aurora --force --count 10
```

State files: `aurora/manifest.json`

### Fetch

Runs `HeadObject`, `GetObject` (first 1 KB preview), and `ListObjectVersions` on each uploaded key.

```bash
# Fetch all keys from manifest.json
python fetch.py --provider aurora

# Fetch a specific key
python fetch.py --provider aurora --key gov-data/README.md

# Fetch a specific version
python fetch.py --provider aurora --key gov-data/README.md --version-id <version-id>
```

### Delete

```bash
# Preview what would be deleted (no changes made)
python delete.py --provider aurora --dry-run

# Delete all done entries in manifest.json
python delete.py --provider aurora

# Delete a specific key or version
python delete.py --provider aurora --key gov-data/README.md
python delete.py --provider aurora --key gov-data/README.md --version-id <version-id>
```

---

## Load Test

Concurrent uploads tracked in `load_test_state.db` (SQLite). Any interrupted run can be resumed exactly where it left off.

```bash
# Upload 50 files with 8 concurrent threads (defaults)
python load_test.py --provider aurora

# Upload 200 files with 16 threads
python load_test.py --provider aurora --count 200 --workers 16

# Resume after failure (retries pending/failed/interrupted entries)
python load_test.py --provider aurora --resume
python load_test.py --provider aurora --resume --workers 4

# Force re-run from scratch (deletes load_test_state.db and re-queues everything)
python load_test.py --provider aurora --force
python load_test.py --provider aurora --force --count 200 --workers 16
```

State files: `aurora/load_test_state.db`

**Failure handling:**
| Scenario | Behavior |
|---|---|
| Network timeout mid-upload | Multipart upload aborted; entry marked `failed`; retried on `--resume` |
| Process killed mid-run | `in_progress` entries retried on `--resume` |
| Rate limit / HTTP error | Logged with status code and error body; retried on `--resume` |
| Source file unavailable | Logged as source error; retried on `--resume` |

---

## Compatibility Test

Runs the full [ceph/s3-tests](https://github.com/ceph/s3-tests) suite against Aurora. Auto-generates `s3tests.conf` from `.env`, runs pytest, and produces a unified report grouped by S3 feature category.

```bash
# Run core S3 tests, excluding tests known to fail on real AWS
python compatibility_test.py --provider aurora

# Custom mark expression
python compatibility_test.py --provider aurora --marks 'not fails_on_aws'
python compatibility_test.py --provider aurora --marks 'versioning and not fails_on_aws'
python compatibility_test.py --provider aurora --marks 'encryption'

# Run a single test
python compatibility_test.py --provider aurora --test-file 's3tests/functional/test_s3.py::test_bucket_list_empty'

# Run IAM tests
python compatibility_test.py --provider aurora --test-file s3tests/functional/test_iam.py
```

**`not fails_on_aws` (default marks):** The s3-tests suite tags some tests `fails_on_aws` — these are tests for Ceph-specific behavior that even real AWS S3 fails. Excluding them gives a cleaner compatibility signal.

**Cross-user tests:** Tests in the `[s3 alt]` category require a genuinely separate Aurora account (different user identity, not just a second API key on the same account). Add `S3_ALT_ACCESS_KEY_ID` and `S3_ALT_SECRET_ACCESS_KEY` to `aurora/.env`. Without a separate account, cross-user ACL tests will fail — single-user tests are unaffected.

**Report:** The BY CATEGORY section breaks results down by S3 feature (versioning, lifecycle, encryption, etc.) with pass/fail counts and timing stats per category. Only failures are shown in detail — passing test names are omitted to keep the report readable.

---

## Running s3-tests Directly

The `compatibility_test.py` script auto-generates the config and wraps everything in a report. If you want to run `s3-tests` directly with tox or pytest — for faster iteration, specific test selection, or to get raw pytest output — follow these steps.

### Preconditions

Before any tests will pass, verify these requirements:

**1. Bucket creation must be allowed via API**

The s3-tests suite creates a fresh bucket for each test and deletes it in teardown. If your Aurora API key does not have `CreateBucket` / `DeleteBucket` permission, every test will fail immediately with `AccessDenied`. Confirm in the Aurora UI that your API key has full bucket management permissions, or contact Aurora support to enable it.

> This is the most likely reason tests fail out of the box. We observed `AccessDenied` on `CreateBucket` in initial testing.

**2. Two credential pairs for cross-user tests**

Any test that checks cross-account behavior (ACLs, cross-user bucket access, etc.) requires a second Aurora API key in `[s3 alt]`. Without it, those tests fail but single-user tests are unaffected. Create a second API key in the Aurora UI and populate `AURORA_ALT_*` in `.env`.

**3. Python 3.8+**

The s3-tests suite requires Python 3.8 or newer. Verify:
```bash
python --version
```

**4. s3-tests repo is cloned**

```bash
# From the testing/ directory
ls s3-tests/   # should exist
# If not:
git clone https://github.com/ceph/s3-tests
```

**5. Dependencies installed**

```bash
# s3-tests dependencies (munch, gevent, isodate, etc.)
pip install -r s3-tests/requirements.txt

# Our reporting wrapper (only needed for compatibility_test.py)
pip install -r requirements.txt
```

**6. STS / IAM tests require additional Aurora configuration**

The STS and IAM test files (`test_sts.py`, `test_iam.py`) require Aurora to support those APIs. If Aurora does not expose an IAM/STS endpoint, skip those files entirely:
```bash
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py  # core S3 only
```

The `webidentity_test` mark additionally requires a running Keycloak instance — skip it unless you have one configured.

---

### 1. Create the config file

The suite requires an INI config file. Copy and fill in this template, saving it as `s3-tests/aurora.conf`:

```ini
[DEFAULT]
host = a-s3.aur.lu
port = 443
is_secure = True
ssl_verify = True

[fixtures]
bucket prefix = aurora-s3test-{random}-

[s3 main]
display_name = Your Name
user_id      = your-user-id
email        = you@example.com
access_key   = <S3_ACCESS_KEY_ID>
secret_key   = <S3_SECRET_ACCESS_KEY>

[s3 alt]
display_name = Alt User
user_id      = your-alt-user-id
email        = alt@example.com
access_key   = <S3_ALT_ACCESS_KEY_ID>   # must be a separate Aurora account for cross-user tests
secret_key   = <S3_ALT_SECRET_ACCESS_KEY>

[s3 tenant]
display_name = Tenant User
user_id      = aurora-tenant-user
email        = tenant@aurora.test
access_key   = <S3_ALT_ACCESS_KEY_ID>
secret_key   = <S3_ALT_SECRET_ACCESS_KEY>
tenant       = aurora-tenant

[iam]
display_name = IAM User
user_id      = aurora-iam-user
email        = iam@aurora.test
access_key   = <S3_ACCESS_KEY_ID>
secret_key   = <S3_SECRET_ACCESS_KEY>

[iam root]
access_key = <S3_ACCESS_KEY_ID>
secret_key = <S3_SECRET_ACCESS_KEY>
user_id    = aurora-main-user
email      = you@example.com

[iam alt root]
access_key = <S3_ALT_ACCESS_KEY_ID>
secret_key = <S3_ALT_SECRET_ACCESS_KEY>
user_id    = aurora-alt-user
email      = alt@example.com
```

### 2. Run with tox

Tox installs the suite's dependencies into an isolated virtualenv automatically:

```bash
cd s3-tests

# Run all tests
S3TEST_CONF=aurora.conf tox

# Run only the core S3 tests
S3TEST_CONF=aurora.conf tox -- s3tests/functional/test_s3.py

# Run a specific test
S3TEST_CONF=aurora.conf tox -- s3tests/functional/test_s3.py::test_bucket_list_empty
```

### 3. Run with pytest directly

If dependencies are already installed (`pip install -r s3-tests/requirements.txt`), use pytest directly from the `s3-tests` directory for faster startup:

```bash
cd s3-tests

# All core S3 tests
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py

# A single test
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py::test_bucket_list_empty

# STS tests
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_sts.py

# IAM tests
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_iam.py
```

### 4. Filter by marks

Tests are tagged with marks describing their feature area or known failure conditions. Combine them with standard boolean expressions:

```bash
# Skip tests known to fail on real AWS (good baseline for any S3-compatible service)
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py -m 'not fails_on_aws'

# Only versioning tests
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py -m versioning

# Versioning tests that aren't expected to fail on AWS
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py -m 'versioning and not fails_on_aws'

# Encryption tests
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py -m encryption

# Object lock tests
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py -m object_lock

# Lifecycle tests
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py -m lifecycle

# STS: AssumeRole and GetSessionToken only
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_sts.py -m test_of_sts

# STS: AssumeRoleWithWebIdentity (requires Keycloak)
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_sts.py -m webidentity_test

# Bucket logging (with Ceph rollover extension)
S3TEST_CONF=aurora.conf pytest s3tests/functional/test_s3.py -m bucket_logging
```

Key marks to know:

| Mark | Meaning |
|---|---|
| `fails_on_aws` | Known to fail on real AWS S3 — likely fails on Aurora too |
| `fails_on_rgw` | Ceph-specific failure — may pass on Aurora |
| `versioning` | Object versioning tests |
| `lifecycle` | Lifecycle policy tests |
| `encryption` / `sse_s3` | Server-side encryption |
| `object_lock` | Object lock / retention |
| `tagging` | Object and bucket tagging |
| `bucket_policy` | Bucket policy tests |
| `checksum` | Checksum validation |
| `test_of_sts` | STS AssumeRole / GetSessionToken |
| `webidentity_test` | STS AssumeRoleWithWebIdentity (needs Keycloak) |

### Tox vs. compatibility_test.py

| | `tox` / `pytest` directly | `compatibility_test.py` |
|---|---|---|
| Config | Manual (`aurora.conf`) | Auto-generated from `.env` |
| Output | Raw pytest terminal output | Unified timestamped report |
| Timing stats | No | Yes (avg, stddev, min, max per category) |
| Resume | No | N/A (tests are fast enough to re-run) |
| Best for | Quick iteration, debugging single tests | Full compatibility runs with reportable results |

---

## Reports & Logs

Every run produces timestamped files — nothing is overwritten.

```
aurora/
  logs/
    20260218_142301_upload_success.jsonl
    20260218_142301_upload_errors.jsonl
    20260218_142301_compatibility_pytest_raw.json   ← full pytest output
  reports/
    20260218_142301_upload_report.txt
    20260218_142301_compatibility_report.txt
```

**Report format** (same across all scripts):
```
======================================================================
  <Title>
  Script : <script_name>
  Run    : <timestamp>
======================================================================

SUMMARY
  Total  : N
  OK     : N
  Failed : N

BY OPERATION / BY CATEGORY
  <operation>    N ok    N failed  (N total)  avg Xs  stddev Xs  min Xs  max Xs
  ...

<extra metadata>

ERRORS
  { full JSON entry with error_code, status_code, request_id, response_body, ... }
  ...
```

---

## File Reference

| File | Purpose |
|---|---|
| `client.py` | boto3 client factory for Aurora and source.coop |
| `report.py` | Shared report formatting used by all scripts |
| `logger.py` | Per-operation JSONL logging + report generation for phase scripts |
| `manifest.py` | Upload resume state (`manifest.json`) |
| `upload.py` | Upload files from source.coop to Aurora |
| `fetch.py` | Head, get preview, and list versions |
| `delete.py` | Delete objects by key or version |
| `load_test.py` | Concurrent load test with SQLite-backed resume |
| `compatibility_test.py` | Full S3 compatibility test via ceph/s3-tests |
| `manifest.json` | Created at runtime — upload state |
| `load_test_state.db` | Created at runtime — load test state |
