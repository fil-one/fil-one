"""Pytest plugin that activates the on-ramp backend named by S3COMPAT_BACKEND.

Loaded unconditionally by `compatibility_test.py` via `pytest -p lib.backend_loader`.
No-ops when `S3COMPAT_BACKEND` is unset, set to `boto3`, or names a provider
for which `lib/backend-<name>/` does not exist, so it's safe to load for
providers that don't ship per-method patches.

Each on-ramp's backend code lives under `lib/backend-<provider>/`, separate
from the provider's runtime data:

    tests/s3compat/
      lib/
        backend-aurora/                  # imported by this plugin as `lib.backend-aurora`
          __init__.py                    # exposes activate(), SKIP_TESTS, SKIP_REASON
          patch.py                       # boto3 monkey-patches
          portal_api.py                  # HTTP wire layer
      aurora/                            # runtime data: .env, logs/, reports/

Adding a new backend:
  1. Create `lib/backend-<provider>/__init__.py` exposing `def activate(): ...`.
  2. Optionally export module-level `SKIP_TESTS` (set of test names) and
     `SKIP_REASON` (string) — this loader will apply skip markers.
  3. Run `python compatibility_test.py --provider <provider>`. No edits to
     this loader or compatibility_test.py are required.
"""
import importlib
import logging
import os
from pathlib import Path

import pytest

log = logging.getLogger("backend_loader")

_BACKEND_NAME = os.environ.get("S3COMPAT_BACKEND", "")
_BACKEND_MODULE = None


def _load_backend(name):
    """Import `lib.backend-<name>` and call its activate() entry point."""
    if not name or name == "boto3":
        return None
    backend_dir = Path(__file__).parent / f"backend-{name}"
    if not backend_dir.is_dir():
        log.info(
            "backend_loader: no lib/backend-%s/ package; running plain boto3",
            name,
        )
        return None
    module_name = f"lib.backend-{name}"
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise RuntimeError(
            f"backend {name!r} requested but `lib/backend-{name}/` could not "
            f"be imported: {exc}"
        ) from exc
    activate = getattr(module, "activate", None)
    if activate is None:
        raise RuntimeError(
            f"lib/backend-{name}/__init__.py does not expose an `activate()` function"
        )
    activate()
    return module


def pytest_configure(config):
    global _BACKEND_MODULE
    if not _BACKEND_NAME or _BACKEND_NAME == "boto3":
        return
    log.info("backend_loader: activating %r", _BACKEND_NAME)
    try:
        _BACKEND_MODULE = _load_backend(_BACKEND_NAME)
    except RuntimeError as exc:
        log.error("backend_loader: activation failed: %s", exc)
        raise pytest.UsageError(str(exc)) from exc


def pytest_collection_modifyitems(config, items):
    if _BACKEND_MODULE is None:
        return
    skip_tests = getattr(_BACKEND_MODULE, "SKIP_TESTS", set())
    if not skip_tests:
        return
    skip_reason = getattr(
        _BACKEND_MODULE,
        "SKIP_REASON",
        f"Skipped by backend {_BACKEND_NAME}",
    )
    marker = pytest.mark.skip(reason=skip_reason)
    for item in items:
        if item.name in skip_tests:
            item.add_marker(marker)
            log.debug("backend_loader: auto-skipping %s", item.nodeid)
