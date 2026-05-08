"""Aurora backend patches — boto3 monkey-patches that redirect bucket
management to the Aurora Dashboard (Portal) REST API.

The top-level `backend_loader` pytest plugin imports `aurora.backend` (when
`--provider aurora` is active) and calls `activate()`. Runtime data for the
Aurora on-ramp (`.env`, `logs/`, `reports/`, `manifest.json`) lives one
level up in `aurora/`, alongside this package and `aurora/tools/`.

Required env vars (loaded from aurora/.env):
  AURORA_PORTAL_ORIGIN   Portal base URL, e.g. https://dashboard.dev.aur.lu
  AURORA_TENANT_ID       Tenant UUID
  AURORA_NO_VERIFY_SSL   Optional — set to "true" to skip TLS cert verification

The Bearer token is loaded from ~/.aurora_token, written by
`python aurora/tools/aurora_key_management.py login`.
"""
from .patch import activate, SKIP_REASON, SKIP_TESTS

__all__ = ["activate", "SKIP_TESTS", "SKIP_REASON"]
