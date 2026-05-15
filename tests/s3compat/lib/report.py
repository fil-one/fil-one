"""
Shared report formatting used by all test scripts.

Callers build a list of entry dicts with at minimum:
  {"op": str, "status": "ok" | "skipped" | "err", "elapsed_s": float, ...}

``skipped`` is for operations that could not be run for an expected reason
(e.g. the provider refused GetBucketCors with AccessDenied). Skipped entries
are reported separately and do not count as failures.

Callers call write_report() to produce three artefacts side-by-side:
  - <ts>_<script>_report.txt  — plain text (legacy format, byte-stable)
  - <ts>_<script>_report.md   — Markdown (canonical, agent-friendly, GitHub-renderable)
  - <ts>_<script>_report.html — Styled HTML (human-friendly, collapsible details)

Markdown is rendered from a Jinja2 template (templates/report.md.j2). HTML is
the rendered Markdown wrapped in a small CSS shell. Inline HTML in the Markdown
(e.g. <details>, the progress-bar div) survives both via md_in_html.
"""
import json
import os
import statistics
from dataclasses import dataclass 
from pathlib import Path
from typing import Optional

import bleach
import markdown as _markdown
from bleach.css_sanitizer import CSSSanitizer
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pygments.formatters import HtmlFormatter


NON_FAILURE_STATUSES = frozenset({"ok", "skipped"})

_HTML_ALLOWED_TAGS = frozenset({
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr", "strong", "em", "b", "i", "u", "s", "sub", "sup",
    "code", "pre", "blockquote",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td",
    "a", "span", "div",
    "details", "summary",
})

_HTML_ALLOWED_ATTRS = {
    "*": ["id", "class"],
    "a": ["href", "title"],
    "div": ["style"],
    "th": ["align"],
    "td": ["align"],
}

_HTML_ALLOWED_PROTOCOLS = ["http", "https", "mailto"]

_HTML_CSS_SANITIZER = CSSSanitizer(allowed_css_properties=["--pct"])

_PYGMENTS_CSS_LIGHT = HtmlFormatter(
    style="default", nobackground=True
).get_style_defs(".highlight")
_PYGMENTS_CSS_DARK = HtmlFormatter(
    style="github-dark", nobackground=True
).get_style_defs(".highlight")

_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

_jinja_env = Environment(
    loader=FileSystemLoader(_TEMPLATES_DIR),
    autoescape=select_autoescape(disabled_extensions=("md", "j2"), default=False),
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)


@dataclass
class Section:
    """Caller-supplied rich content rendered between the ops table and Skipped/Successes."""
    title: str
    markdown: str


@dataclass
class _OpRow:
    op: str
    ok: int
    err: int
    total: int
    avg: str
    stddev: str
    min: str
    max: str
    timing: str  # combined string for legacy text format
    pct: int | None = None


@dataclass
class _ReportModel:
    title: str
    script_name: str
    ts: str
    summary: dict
    group_label: str
    group_field: str
    op_rows: list
    has_pass_rate: bool
    sections: list
    successes: list  # list of pre-serialized JSON strings
    skipped: list
    errors_raw: list  # original error entry dicts (for legacy .txt)
    errors: list  # list of {"summary", "body"} dicts (for .md/.html)
    extra_lines: list
    log_paths: dict
    show_successes: bool
    interrupted: bool


def _timing_stats(times: list) -> tuple:
    """Returns (avg, stddev, min, max, combined_str)."""
    if not times:
        return ("—", "—", "—", "—", "(no timing)")
    avg = statistics.mean(times)
    std = statistics.pstdev(times)
    mn = min(times)
    mx = max(times)
    combined = f"avg {avg:.3f}s  stddev {std:.3f}s  min {mn:.3f}s  max {mx:.3f}s"
    return (f"{avg:.3f}s", f"{std:.3f}s", f"{mn:.3f}s", f"{mx:.3f}s", combined)


def _group_field_label(group_label: str) -> str:
    """'BY OPERATION' -> 'Operation', 'BY CATEGORY' -> 'Category'."""
    if group_label.upper().startswith("BY "):
        return group_label[3:].title()
    return group_label.title()


def _description_section(entry: dict) -> str:
    """Render the 'Test description' section as a labeled blockquote, or empty."""
    desc = entry.get("description")
    if not desc:
        return ""
    safe = " ".join(desc.split())
    return f"**Test description**\n\n> {safe}\n\n"


def _render_error(entry: dict) -> dict:
    """Produce {"summary", "body"} for an error entry.

    If the entry carries a pytest-style ``longrepr``/``test`` (compatibility_test
    output), render the full traceback in a fenced ``pytb`` block. Otherwise,
    fall back to a JSON dump of the entry.
    """
    op = entry.get("op", "unknown")
    test = entry.get("test")
    longrepr = entry.get("longrepr")

    description = _description_section(entry)

    if test and longrepr:
        outcome = entry.get("outcome", "failed")
        elapsed = entry.get("elapsed_s")
        heading = f"**Error stack trace** — `{op}` — `{outcome}`"
        if elapsed is not None:
            heading += f" — {elapsed}s"
        body = f"{description}{heading}\n\n```pytb\n{longrepr}\n```"
        return {"summary": test, "body": body}

    code = entry.get("error_code") or entry.get("error_type")
    msg = entry.get("error_message") or entry.get("error_msg") or entry.get("error")
    summary = f"{op}"
    if code:
        summary += f" — {code}"
    if msg:
        summary += f": {msg}"
    body = (
        f"{description}**Error details**\n\n"
        f"```json\n{json.dumps(entry, indent=2, default=str)}\n```"
    )
    return {"summary": summary, "body": body}


def _build_model(
    title: str,
    script_name: str,
    ts: str,
    entries: list,
    success_log: Optional[Path] = None,
    error_log: Optional[Path] = None,
    extra_lines: Optional[list] = None,
    group_label: str = "BY OPERATION",
    show_successes: bool = True,
    sections: Optional[list] = None,
    op_decorations: Optional[dict] = None,
    report_file: Optional[Path] = None,
    interrupted: bool = False,
) -> _ReportModel:
    successes = [e for e in entries if e.get("status") == "ok"]
    skipped = [e for e in entries if e.get("status") == "skipped"]
    error_entries = [e for e in entries if e.get("status") not in NON_FAILURE_STATUSES]

    # Per-op aggregation. Skipped entries fold into the "ok" column so a skipped
    # op does not look like a failure; the SUMMARY/SKIPPED section show separately.
    ops: dict = {}
    for e in entries:
        op = e.get("op", "unknown")
        rec = ops.setdefault(op, {"ok": 0, "err": 0, "times": []})
        if e.get("status") in NON_FAILURE_STATUSES:
            rec["ok"] += 1
        else:
            rec["err"] += 1
        if "elapsed_s" in e:
            rec["times"].append(e["elapsed_s"])

    op_decorations = op_decorations or {}
    has_pass_rate = bool(op_decorations) and any(
        d.get("pct") is not None for d in op_decorations.values()
    )

    op_rows = []
    for op, rec in sorted(ops.items()):
        total = rec["ok"] + rec["err"]
        avg, stddev, mn, mx, combined = _timing_stats(rec["times"])
        deco = op_decorations.get(op, {})
        op_rows.append(_OpRow(
            op=op,
            ok=rec["ok"],
            err=rec["err"],
            total=total,
            avg=avg,
            stddev=stddev,
            min=mn,
            max=mx,
            timing=combined,
            pct=deco.get("pct"),
        ))

    summary = {
        "total": len(entries),
        "ok": len(successes),
        "skipped": len(skipped),
        "failed": len(error_entries),
    }

    log_paths: dict = {"success": None, "error": None}
    if report_file is not None:
        report_parent = report_file.parent
        if success_log:
            log_paths["success"] = os.path.relpath(success_log, report_parent)
        if error_log:
            log_paths["error"] = os.path.relpath(error_log, report_parent)
    else:
        if success_log:
            log_paths["success"] = success_log
        if error_log:
            log_paths["error"] = error_log

    return _ReportModel(
        title=title,
        script_name=script_name,
        ts=ts,
        summary=summary,
        group_label=group_label,
        group_field=_group_field_label(group_label),
        op_rows=op_rows,
        has_pass_rate=has_pass_rate,
        sections=sections or [],
        successes=[json.dumps(s, default=str) for s in successes],
        skipped=[json.dumps(s, default=str) for s in skipped],
        errors_raw=error_entries,
        errors=[_render_error(e) for e in error_entries],
        extra_lines=extra_lines or [],
        log_paths=log_paths,
        show_successes=show_successes,
        interrupted=interrupted,
    )


def _render_text(m: _ReportModel) -> str:
    """Legacy plain-text format. Output kept byte-stable for back-compat."""
    op_lines = []
    for r in m.op_rows:
        counts = f"{r.ok:>4} ok  {r.err:>4} failed  ({r.total:>4} total)"
        op_lines.append(f"  {r.op:<30}  {counts}  {r.timing}")

    summary_lines = [
        "SUMMARY",
        f"  Total  : {m.summary['total']}",
        f"  OK     : {m.summary['ok']}",
    ]
    if m.summary["skipped"]:
        summary_lines.append(f"  Skipped: {m.summary['skipped']}")
    summary_lines.append(f"  Failed : {m.summary['failed']}")

    lines = [
        "=" * 70,
        f"  {m.title}",
        f"  Script : {m.script_name}",
        f"  Run    : {m.ts}",
        "=" * 70,
        "",
    ]
    if m.interrupted:
        lines += [
            "!" * 70,
            "  INCOMPLETE RESULTS — test run was interrupted (Ctrl+C).",
            "  Numbers below reflect only the tests that finished running.",
            "!" * 70,
            "",
        ]
    lines += [
        *summary_lines,
        "",
        m.group_label,
        *op_lines,
        "",
    ]

    if m.extra_lines:
        lines += list(m.extra_lines) + [""]

    if m.show_successes and m.successes:
        lines.append("SUCCESSES")
        for s in m.successes:
            lines.append(f"  {s}")
        lines.append("")

    if m.skipped:
        lines.append("SKIPPED")
        for s in m.skipped:
            lines.append(f"  {s}")
        lines.append("")

    if m.errors_raw:
        lines.append("ERRORS")
        for e in m.errors_raw:
            lines.append(f"  {json.dumps(e, default=str)}")
        lines.append("")

    if m.log_paths.get("success") or m.log_paths.get("error"):
        lines.append("Log files:")
        if m.log_paths.get("success"):
            lines.append(f"  Success : {m.log_paths['success']}")
        if m.log_paths.get("error"):
            lines.append(f"  Errors  : {m.log_paths['error']}")
        lines.append("")

    return "\n".join(lines)


def _render_markdown(m: _ReportModel) -> str:
    template = _jinja_env.get_template("report.md.j2")
    return template.render(
        title=m.title,
        script_name=m.script_name,
        ts=m.ts,
        summary=m.summary,
        group_label=m.group_label,
        group_field=m.group_field,
        op_rows=[
            {
                "op": r.op,
                "ok": r.ok,
                "err": r.err,
                "total": r.total,
                "avg": r.avg,
                "stddev": r.stddev,
                "min": r.min,
                "max": r.max,
                "pct": (
                    r.pct
                    if r.pct is not None
                    else (int(round((100.0 * r.ok) / r.total)) if r.total else None)
                ),
            }
            for r in m.op_rows
        ],
        has_pass_rate=m.has_pass_rate,
        sections=m.sections,
        successes=m.successes,
        skipped=m.skipped,
        errors=m.errors,
        extra_lines=m.extra_lines,
        log_paths=m.log_paths,
        show_successes=m.show_successes,
        interrupted=m.interrupted,
    )

def _render_html(title: str, md_text: str) -> str:
    body = _markdown.markdown(
        md_text,
        extensions=[
            "tables",
            "fenced_code",
            "toc",
            "attr_list",
            "md_in_html",
            "sane_lists",
            "codehilite",
        ],
        extension_configs={
            "codehilite": {"css_class": "highlight", "guess_lang": False},
            "toc": {"permalink": False},
        },
        output_format="html",
    )
    # Python-Markdown does NOT XSS-sanitize: raw HTML (and md_in_html blocks)
    # pass through unchanged. Run the output through a strict bleach allowlist
    # so attacker-controlled error messages / op names / tracebacks can't
    # inject script or unexpected markup. The allowlist preserves the
    # template's load-bearing <details>/<summary> blocks and the progress-bar
    # <div class="bar" style="--pct:N%">.
    body = bleach.clean(
        body,
        tags=_HTML_ALLOWED_TAGS,
        attributes=_HTML_ALLOWED_ATTRS,
        protocols=_HTML_ALLOWED_PROTOCOLS,
        css_sanitizer=_HTML_CSS_SANITIZER,
        strip=True,
        strip_comments=True,
    )
    safe_title = (
        title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    template = _jinja_env.get_template("report.html.j2")
    return template.render(
        safe_title=safe_title,
        body=body,
        pygments_css_light=_PYGMENTS_CSS_LIGHT,
        pygments_css_dark=_PYGMENTS_CSS_DARK,
    )


def _sibling_path(report_file: Path, suffix: str) -> Path:
    return report_file.with_suffix(suffix)


def write_report(
    title: str,
    script_name: str,
    ts: str,
    entries: list,
    report_file: Path,
    success_log: Optional[Path] = None,
    error_log: Optional[Path] = None,
    extra_lines: Optional[list] = None,
    group_label: str = "BY OPERATION",
    show_successes: bool = True,
    sections: Optional[list] = None,
    op_decorations: Optional[dict] = None,
    interrupted: bool = False,
) -> str:
    """Format a unified report, write .txt/.md/.html to disk, and return the text form.

    Optional kwargs:
      - sections: list of Section(title, markdown) — extra rich content rendered
        between the ops table and the Skipped/Success/Errors blocks. Used by
        compatibility_test.py to inject Failure-clusters etc. without coupling
        report.py to pytest specifics.
      - op_decorations: dict[op_name -> {"pct": int}] — overlays per-op pass-rate
        percentages onto the ops table.
    """
    model = _build_model(
        title=title,
        script_name=script_name,
        ts=ts,
        entries=entries,
        success_log=success_log,
        error_log=error_log,
        extra_lines=extra_lines,
        group_label=group_label,
        show_successes=show_successes,
        sections=sections,
        op_decorations=op_decorations,
        report_file=report_file,
        interrupted=interrupted,
    )

    text = _render_text(model)
    md = _render_markdown(model)
    html = _render_html(title, md)

    md_path = _sibling_path(report_file, ".md")
    html_path = _sibling_path(report_file, ".html")

    with open(report_file, "w") as f:
        f.write(text)
    with open(md_path, "w") as f:
        f.write(md)
    with open(html_path, "w") as f:
        f.write(html)

    return text
