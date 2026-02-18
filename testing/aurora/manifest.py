"""
Persistent manifest tracking upload state for Phase 1.

Schema (manifest.json):
  {
    "files": {
      "<source_key>": {
        "status":     "done" | "failed" | "deleted",
        "size":       <int>,
        "etag":       "<str>",
        "version_id": "<str | null>",
        "target_bucket": "<str>",
        ...
      }
    }
  }
"""
import json
from pathlib import Path

MANIFEST_FILE = Path(__file__).parent / "manifest.json"


def load() -> dict:
    if MANIFEST_FILE.exists():
        with open(MANIFEST_FILE) as f:
            return json.load(f)
    return {"files": {}}


def save(manifest: dict):
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest, f, indent=2)


def mark_done(manifest: dict, key: str, **kwargs):
    manifest["files"].setdefault(key, {})
    manifest["files"][key].update({"status": "done", **kwargs})
    save(manifest)


def mark_failed(manifest: dict, key: str, reason: str):
    manifest["files"].setdefault(key, {})
    manifest["files"][key].update({"status": "failed", "reason": reason})
    save(manifest)


def is_done(manifest: dict, key: str) -> bool:
    return manifest["files"].get(key, {}).get("status") == "done"
