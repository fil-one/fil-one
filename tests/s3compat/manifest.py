"""
Persistent manifest tracking upload state for upload.py.

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


def _path(provider_dir: Path) -> Path:
    return provider_dir / "manifest.json"


def load(provider_dir: Path) -> dict:
    path = _path(provider_dir)
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return {"files": {}}


def save(manifest: dict, provider_dir: Path):
    with open(_path(provider_dir), "w") as f:
        json.dump(manifest, f, indent=2)


def mark_done(manifest: dict, provider_dir: Path, key: str, **kwargs):
    manifest["files"].setdefault(key, {})
    manifest["files"][key].update({"status": "done", **kwargs})
    save(manifest, provider_dir)


def mark_failed(manifest: dict, provider_dir: Path, key: str, reason: str):
    manifest["files"].setdefault(key, {})
    manifest["files"][key].update({"status": "failed", "reason": reason})
    save(manifest, provider_dir)


def is_done(manifest: dict, key: str) -> bool:
    return manifest["files"].get(key, {}).get("status") == "done"
