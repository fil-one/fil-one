"""Aurora backend patches — boto3 monkey-patches that redirect bucket
management to the Aurora Dashboard (Portal) REST API.

The `lib.backend_loader` pytest plugin imports `lib.backend-aurora` (when
`--provider aurora` is active) and calls `activate()`. Runtime data for the
Aurora on-ramp (`.env`, `logs/`, `reports/`, `manifest.json`) lives in
`aurora/` at the repo root; provider CLIs live in the top-level `tools/`.

Required env vars (loaded from aurora/.env):
  AURORA_PORTAL_ORIGIN   Portal base URL, e.g. https://dashboard.dev.aur.lu
  AURORA_TENANT_ID       Tenant UUID
  AURORA_NO_VERIFY_SSL   Optional — set to "true" to skip TLS cert verification

The Bearer token is loaded from ~/.aurora_token, written by
`python tools/aurora_key_management.py login`.
"""
from .patch import activate

__all__ = ["activate"]
