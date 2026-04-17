"""Generate s3tests.conf from a provider's .env file.

Usage:
  python generate_ceph_conf.py akave
  python generate_ceph_conf.py aurora

Writes ceph-s3-tests/s3tests.conf, ready for use with pytest:
  cd ceph-s3-tests
  S3TEST_CONF=s3tests.conf uv run python -m pytest s3tests/functional/test_s3.py
"""
import sys
from pathlib import Path

from client import resolve_provider
from compatibility_test import _generate_conf

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <provider>", file=sys.stderr)
    sys.exit(1)

provider = sys.argv[1]
resolve_provider(provider)
conf_path = _generate_conf(Path("ceph-s3-tests"), provider)
print(conf_path.relative_to(Path.cwd()))
