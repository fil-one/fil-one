"""Optional per-test descriptions for s3-tests compatibility reports.

Descriptions live in a YAML file outside the ceph/s3-tests submodule. The
loader is best-effort: missing file, parse errors, and unmatched tests all
silently produce no description. Behavior when no YAML file is present is
byte-identical to a run without this module.

YAML schema: a top-level mapping where each key is either a bare test
function name (preferred) or a full pytest nodeid, and each value is either
a description string or a mapping with a ``description`` field (extra keys
like ``notes`` / ``spec_url`` are tolerated for forward compatibility).
"""
from pathlib import Path
from typing import Optional

try:
    import yaml  # pyyaml
except ImportError:
    yaml = None


def load(path: Optional[Path]) -> dict:
    """Return {test_key: description_str} from a YAML file, or {} on any failure."""
    if not path or yaml is None:
        return {}
    p = Path(path)
    if not p.is_file():
        return {}
    try:
        with open(p) as f:
            raw = yaml.safe_load(f) or {}
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}

    out: dict = {}
    for k, v in raw.items():
        if not isinstance(k, str):
            continue
        if isinstance(v, str):
            text = v.strip()
            if text:
                out[k] = text
        elif isinstance(v, dict):
            desc = v.get("description")
            if isinstance(desc, str) and desc.strip():
                out[k] = desc.strip()
    return out


def _bare_name(nodeid: str) -> str:
    """'pkg/mod.py::test_x[param]' -> 'test_x' (strip params and module)."""
    if not nodeid:
        return ""
    tail = nodeid.rsplit("::", 1)[-1]
    bracket = tail.find("[")
    return tail[:bracket] if bracket != -1 else tail


def describe(entries: list, descriptions: dict) -> None:
    """Add a 'description' key to each entry whose test matches a YAML key.

    Lookup order: full nodeid (entry['test']) first, then the bare function
    name parsed from the nodeid. One YAML key covers all parametrize variants.
    """
    if not descriptions:
        return
    for e in entries:
        test = e.get("test", "")
        desc = descriptions.get(test) or descriptions.get(_bare_name(test))
        if desc:
            e["description"] = desc
