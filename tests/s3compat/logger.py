import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import report as _report


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append(path: Path, entry: dict):
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")


def _extract_boto_error(exc: Exception) -> dict:
    if hasattr(exc, "response"):
        resp = exc.response
        meta = resp.get("ResponseMetadata", {})
        err = resp.get("Error", {})
        return {
            "status_code": meta.get("HTTPStatusCode"),
            "error_code": err.get("Code"),
            "error_message": err.get("Message"),
            "request_id": meta.get("RequestId"),
            "host_id": meta.get("HostId"),
            "response_body": resp,
        }
    return {
        "error_type": type(exc).__name__,
        "error": str(exc),
    }


class Logger:
    def __init__(self, script_name: str, provider_dir: Path):
        self.ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.script = script_name

        logs_dir = provider_dir / "logs"
        reports_dir = provider_dir / "reports"
        logs_dir.mkdir(exist_ok=True)
        reports_dir.mkdir(exist_ok=True)

        self.success_log = logs_dir / f"{self.ts}_{script_name}_success.jsonl"
        self.error_log = logs_dir / f"{self.ts}_{script_name}_errors.jsonl"
        self.report_file = reports_dir / f"{self.ts}_{script_name}_report.txt"

        self._entries: list = []

    def success(self, op: str, **kwargs):
        entry = {"ts": _now(), "op": op, "status": "ok", **kwargs}
        self._entries.append(entry)
        _append(self.success_log, entry)
        print(f"  OK  [{op}] {kwargs}")

    def error(self, op: str, exc: Exception, **kwargs):
        entry = {"ts": _now(), "op": op, "status": "err", **kwargs, **_extract_boto_error(exc)}
        self._entries.append(entry)
        _append(self.error_log, entry)
        code = entry.get("error_code") or entry.get("error_type", "unknown")
        msg = entry.get("error_message") or entry.get("error", "")
        print(f" ERR  [{op}] {code}: {msg}", file=sys.stderr)

    def error_raw(self, op: str, **kwargs):
        """Log an error from pre-extracted details (e.g. from a worker thread)."""
        entry = {"ts": _now(), "op": op, "status": "err", **kwargs}
        self._entries.append(entry)
        _append(self.error_log, entry)
        code = kwargs.get("error_code", "unknown")
        msg = kwargs.get("error_message") or kwargs.get("error_msg", "")
        print(f" ERR  [{op}] {code}: {msg}", file=sys.stderr)

    def write_report(self, title: str, extra_lines: list = None):
        text = _report.write_report(
            title=title,
            script_name=self.script,
            ts=self.ts,
            entries=self._entries,
            report_file=self.report_file,
            success_log=self.success_log,
            error_log=self.error_log,
            extra_lines=extra_lines,
        )
        print(f"\n{text}")
        print(f"Report written to: {self.report_file}")
