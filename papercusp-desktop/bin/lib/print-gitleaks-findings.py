#!/usr/bin/env python3
"""Print safe gitleaks finding locators without printing matched values.

Gitleaks reports are written with --redact=100. This formatter deliberately
does not deserialize or print Match/Secret, so a release refusal can carry the
rule, file, line range, and rule description without putting the finding value
in the release log.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _single_line(value: object, fallback: str) -> str:
    text = " ".join(str(value or fallback).split())
    return text or fallback


def _safe_locator(raw_file: object, scan_root: str) -> str:
    """Return a scan-relative locator, never an absolute build-box path."""

    value = _single_line(raw_file, "<unknown-file>").replace("\\", "/")
    root = scan_root.strip("/").replace("\\", "/")
    root_prefix = f"{root.rstrip('/')}/" if root else ""
    if value.startswith(root_prefix):
        return value[len(root_prefix) :]
    if value.startswith("/"):
        absolute_marker = f"/{root_prefix}" if root_prefix else ""
        if absolute_marker and absolute_marker in value:
            return value.split(absolute_marker, 1)[1]
        # An unexpected path outside the scan root is still useful as a
        # basename, but must never disclose the build machine's directories.
        return Path(value).name or "<unknown-file>"
    return value.lstrip("./") or "<unknown-file>"


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: print-gitleaks-findings.py REPORT_JSON SCAN_ROOT", file=sys.stderr)
        return 2

    report_path = Path(argv[1])
    scan_root = argv[2]
    try:
        findings = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        # Do not echo the path or parser exception: either could carry a host
        # path or scanner output into a release log.
        print("       Redacted gitleaks report could not be read.", file=sys.stderr)
        return 2

    if not isinstance(findings, list):
        print("       Redacted gitleaks report had an unexpected shape.", file=sys.stderr)
        return 2

    if not findings:
        print("       No structured finding details were recorded.", file=sys.stderr)
        return 0

    for finding in findings:
        if not isinstance(finding, dict):
            print("       - malformed finding record (value omitted)", file=sys.stderr)
            continue
        rule_id = _single_line(finding.get("RuleID"), "<unknown-rule>")
        locator = _safe_locator(finding.get("File"), scan_root)
        start_line = _single_line(finding.get("StartLine"), "?")
        end_line = _single_line(finding.get("EndLine"), start_line)
        description = _single_line(finding.get("Description"), "<no-description>")
        print(
            f"       - RuleID={rule_id} File={locator} "
            f"Lines={start_line}-{end_line} Description={description}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
