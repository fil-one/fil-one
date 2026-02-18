"""
Shared report formatting used by all test scripts.

Callers build a list of entry dicts with at minimum:
  {"op": str, "status": "ok" | "err", "elapsed_s": float, ...}

and call write_report() to produce the unified output.
"""
import json
import statistics
from pathlib import Path


def _timing_stats(times: list) -> str:
    if not times:
        return "(no timing)"
    avg = statistics.mean(times)
    std = statistics.pstdev(times)
    return f"avg {avg:.3f}s  stddev {std:.3f}s  min {min(times):.3f}s  max {max(times):.3f}s"


def write_report(
    title: str,
    script_name: str,
    ts: str,
    entries: list,
    report_file: Path,
    success_log: Path = None,
    error_log: Path = None,
    extra_lines: list = None,
    group_label: str = "BY OPERATION",
    show_successes: bool = True,
) -> str:
    """Format a unified report, write it to disk, and return the text."""
    successes = [e for e in entries if e.get("status") == "ok"]
    errors = [e for e in entries if e.get("status") != "ok"]

    # Per-op counts and timing
    ops: dict = {}
    for e in entries:
        op = e.get("op", "unknown")
        rec = ops.setdefault(op, {"ok": 0, "err": 0, "times": []})
        if e.get("status") == "ok":
            rec["ok"] += 1
        else:
            rec["err"] += 1
        if "elapsed_s" in e:
            rec["times"].append(e["elapsed_s"])

    op_lines = []
    for op, rec in sorted(ops.items()):
        total = rec["ok"] + rec["err"]
        counts = f"{rec['ok']:>4} ok  {rec['err']:>4} failed  ({total:>4} total)"
        timing = _timing_stats(rec["times"])
        op_lines.append(f"  {op:<30}  {counts}  {timing}")

    lines = [
        "=" * 70,
        f"  {title}",
        f"  Script : {script_name}",
        f"  Run    : {ts}",
        "=" * 70,
        "",
        "SUMMARY",
        f"  Total  : {len(entries)}",
        f"  OK     : {len(successes)}",
        f"  Failed : {len(errors)}",
        "",
        group_label,
        *op_lines,
        "",
    ]

    if extra_lines:
        lines += extra_lines + [""]

    if show_successes and successes:
        lines.append("SUCCESSES")
        for s in successes:
            lines.append(f"  {json.dumps(s)}")
        lines.append("")

    if errors:
        lines.append("ERRORS")
        for e in errors:
            lines.append(f"  {json.dumps(e)}")
        lines.append("")

    if success_log or error_log:
        lines.append("Log files:")
        if success_log:
            lines.append(f"  Success : {success_log}")
        if error_log:
            lines.append(f"  Errors  : {error_log}")
        lines.append("")

    text = "\n".join(lines)
    with open(report_file, "w") as f:
        f.write(text)

    return text
