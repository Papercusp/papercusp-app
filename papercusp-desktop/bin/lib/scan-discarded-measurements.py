#!/usr/bin/env python3
"""
scan-discarded-measurements.py — find the "computed here, reported there" defect.

THE CLASS (3 independent sightings in one night: D-038's recheck caveat,
WI-40534, WI-40542):

    local absent; absent="$(rig_assert_absent b "$FPOST" 30)"   # L124 — 30s PAID
    ...
    [ "$crypto_ok" = 1 ] || return 1                            # early return
    ...
    echo "behavioral: $absent"                                  # L233 — NEVER REACHED

On any path taking that early return the measurement is computed and silently
discarded. In a log it looks like a FAIL for one leg and NOTHING for its
sibling — which reads as "no problem found" and actually means "never
reported". Absence of evidence rendered as evidence of absence.

This is a CANDIDATE GENERATOR, not a verdict. Some intervening returns are
legitimately unreachable before the use. Every hit needs a human read.

--------------------------------------------------------------------------
WHY --self-test EXISTS, AND WHY IT RUNS BY DEFAULT
--------------------------------------------------------------------------
The first version of this scanner was start-anchored (`^\\s*(?:local\\s+)?...`)
and therefore could not see `local X; X=$(...)` — the exact idiom of the
canonical WI-40542 line. It scanned the whole library, reported 4 candidates,
and MISSED the one defect we already knew was there.

A detector blind to the shape it was built to find is itself an instance of
this class. So the control is embedded here permanently and runs before every
scan: if it ever stops firing, "0 candidates" means the instrument is broken,
not that the library is clean.

Exit 0 = control passed, no candidates.
Exit 1 = control passed, candidates found (advisory).
Exit 2 = CONTROL FAILED — the scan result is meaningless, fix the scanner.
"""

import re
import sys
import tempfile
from pathlib import Path

# Matches an assignment ANYWHERE in the line, not just at its start, so the
# common `local X; X=$(...)` compound statement is visible. See the module
# docstring: an anchored version of this regex is what made the scanner blind.
ASSIGN = re.compile(
    r"""(?:^|;|&&|\|\||\bthen\b|\bdo\b|\s)              # statement boundary
         (?:local\s+|declare\s+|export\s+|readonly\s+)?  # optional declarator
         ([A-Za-z_][A-Za-z0-9_]*)                        # 1: variable name
         =("?\$\(.*)                                     # 2: RHS w/ command substitution
    """,
    re.VERBOSE,
)
FUNC_START = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_:.-]*)\s*\(\)\s*\{")

# Also NOT line-anchored, and for the same reason as ASSIGN above — this is the
# second half of the same blindness. In the real scenarios essentially every
# early return is mid-line:
#
#     echo "revocation: K-CUT FAILED — ..."; return 1
#     ''|*[!0-9]*) echo "... not a pass"; return 1 ;;
#     [ "$ok" = 1 ] || return 1
#
# A `^\\s*return` regex sees NONE of those. Both regexes in this file were
# start-anchored initially, and both silently reported the library clean.
RETURN_OR_EXIT = re.compile(
    r"(?:^|;|&&|\|\||\bthen\b|\bdo\b|\belse\b|\)\s)\s*(?:return|exit)\b"
)

# Bookkeeping rather than measurement — a discarded `rc` or loop counter is not
# the defect this hunts.
BORING = {"rc", "now", "ts", "i", "n", "tmp", "tmpdir", "d", "dir", "pid"}

# A heredoc BODY is not local control flow. `rig_pcusp_run "$inst" <<EOS ... EOS`
# ships those lines to a shell on ANOTHER MACHINE, so an `exit 1` inside one can
# never return from the calling bash function. Counting it as an intervening
# return is a parse error, and it produced 2 of the 13 candidates in the first
# triage (_att_mcp_call L58, _fdir_mcp_call L43 — both `if [ -z "$TOK" ]; then
# ...; exit 1; fi` inside a heredoc).
#
# Parameter expansion is the opposite case: for an UNQUOTED delimiter the local
# shell expands `${ws}` before shipping, so a use inside the body is a genuine
# local use. For a quoted delimiter (<<'EOS') nothing expands, so it is not.
HEREDOC_START = re.compile(r"<<-?\s*(?P<q>[\"']?)(?P<tag>[A-Za-z_][A-Za-z0-9_]*)(?P=q)")

# An assignment written as its own guard cannot strand its measurement: on the
# guard's failure branch the command substitution FAILED, so there is no measured
# value to discard. Recognises the multi-line form
#     if ! ws="$(rig_resolve_ws "$inst")"; then ... return 1; fi
# The single-line `X="$(...)" || { echo ...; return 1; }` form needs no rule —
# its return sits on the assignment line, which is already outside the scanned
# range.
SELF_GUARD_START = re.compile(r"^\s*if\s+!\s")

# The equivalent multiline assignment guard:
#
#     value="$(probe)" || {
#       echo "probe failed"
#       return 1
#     }
#
# A return in that block fires only when the command substitution failed, so no
# measured value exists to strand. The scanner already handled the one-line
# `value="$(probe)" || { ...; return 1; }` form accidentally (the return shares
# the assignment line and is outside the scanned range); without this explicit
# model, merely formatting the same guard over several lines creates a false
# positive.
ASSIGN_FAILURE_BLOCK_START = re.compile(r"\|\|\s*\{\s*(?:#.*)?$")

# RANKING signal, never a filter. What the RHS is measuring decides how likely a
# discarded value is to matter: a psql count is a measurement whose loss destroys
# a verdict; a workspace-id lookup is plumbing whose loss strands nothing.
#
# ⚠ This RANKS and never SUPPRESSES, because the file's own docstring is right:
# this is a candidate generator. Suppression here would be a verdict, and the
# triage that motivated these tiers found the tiers are ~85% predictive, not
# 100% — good enough to sort by, nowhere near good enough to hide by.
RHS_MEASUREMENT = re.compile(
    r"\b(drv_psql|psql|rig_read_content|rig_assert_absent|_row_present|curl|count\s*\(|SELECT)\b",
    re.IGNORECASE,
)
RHS_LOOKUP = re.compile(r"\b(rig_resolve_ws|rig_github_id|[A-Za-z_]*resolve[A-Za-z_]*)\b")
RHS_TRANSFORM = re.compile(r"\b(printf|tr|date|seq|basename|dirname|echo)\b")


def is_counter_increment(var: str, rhs: str) -> bool:
    """True for `x=$((x + 1))` — a SELF-REFERENTIAL arithmetic update.

    Such a variable is an accumulator, not a reading: nothing was measured at this
    line, so an early `return` below it strands nothing. Suppressing it is not
    leniency, it is accuracy — and it matters because the canonical example is
    rig_assert_absent()'s `measured=$((measured + 1))`, which counts probes that
    actually ran and is the EXEMPLAR of the three-state discipline this scanner
    exists to enforce. Flagging it told a reader the model implementation was an
    instance of the defect (it did, once, to a peer — hence this function).

    An over-firing detector is worse than a missing one: it gets ignored, and then
    it is not a guard at all.
    """
    return re.search(r"\$\(\(\s*" + re.escape(var) + r"\b", rhs) is not None


def classify_rhs(rhs: str) -> str:
    """measurement > lookup > transform. Order matters: a lookup helper may wrap
    psql internally, but at THIS call site it is a lookup, so the specific
    helper names are tested before the generic measurement verbs."""
    if RHS_LOOKUP.search(rhs):
        return "lookup"
    if RHS_MEASUREMENT.search(rhs):
        return "measurement"
    if RHS_TRANSFORM.search(rhs):
        return "transform"
    return "unknown"


TIER_ORDER = {"measurement": 0, "unknown": 1, "lookup": 2, "transform": 3}

# The canonical WI-40542 shape, kept as a permanent control. Copied faithfully
# from the real pre-fix b3-revocation.sh, INCLUDING the two details that each
# independently blinded an earlier version of this scanner:
#   1. `local X; X="$(...)"` — a compound statement, so the assignment is not
#      at the start of the line;
#   2. `echo "..."; return 1` and `case) ...; return 1 ;;` — mid-line returns,
#      so the early return is not at the start of the line either.
# A control that omits either detail passes while the scanner is blind, which
# is exactly how the first version reported "0 candidates" on a file whose
# defect we already knew by line number.
CONTROL = '''#!/usr/bin/env bash
scn_control_defect() {
  local crypto_ok="$1"
  local absent; absent="$(rig_assert_absent b "$FPOST" 30)"
  case "${maxep:-}" in
    ''|*[!0-9]*) echo "K-CUT UNMEASURED — could not read max epoch"; return 1 ;;
  esac
  if [ "$crypto_ok" != 1 ]; then
    echo "K-CUT FAILED — banned member still holds a key"; return 1
  fi
  echo "  behavioral leg: $absent"
  return 0
}
'''

# Must NOT fire. VERBATIM shape of rig_assert_absent()'s probe counter — the real
# code this scanner over-fired on, reported to a peer as an instance of the defect,
# and retracted. `measured` is an ACCUMULATOR: nothing is read at that line, so the
# `return 1` below it strands nothing. The function it comes from is in fact the
# EXEMPLAR of the three-state discipline (it scores UNMEASURED when measured==0),
# which is what made the false positive actively harmful rather than merely noisy.
COUNTER_CALIBRATION = '''#!/usr/bin/env bash
rig_assert_absent() {
  local inst="$1" fid="$2" tries="${3:-20}" i row rc measured=0
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$inst" "SELECT 1 FROM t WHERE feature_id='$fid' LIMIT 1;" 2>/dev/null)"; rc=$?
    if [ "$rc" -eq 0 ]; then
      measured=$((measured + 1))
      if [ "$row" = "1" ]; then echo 0; return 1; fi
    fi
    sleep 3
  done
  if [ "$measured" -eq 0 ]; then
    echo "  ✗ ALL $tries probes failed to run — UNMEASURED; scoring FAIL" >&2
    echo 0; return 1
  fi
}
'''

# A near-miss that must NOT fire: measured, then consumed BEFORE any return.
CALIBRATION = '''#!/usr/bin/env bash
scn_control_clean() {
  local absent; absent="$(rig_assert_absent b "$FPOST" 30)"
  echo "  behavioral leg: $absent"
  if [ "$1" != 1 ]; then
    return 1
  fi
  return 0
}
'''

# Must NOT fire. Verbatim shape of _att_mcp_call / _fdir_mcp_call / _freap_rest_call,
# which together produced 4 of the 13 first-triage candidates and are ALL benign for
# two independent reasons this scanner now models:
#   1. the `exit 1` sits in a HEREDOC BODY — it runs on the remote frame and can
#      never return from this function;
#   2. the `return 1` is the assignment's OWN guard — it fires precisely when the
#      command substitution failed, so there is no measured value to strand.
# `${ws}` inside the unquoted heredoc IS a real local expansion, so this control
# also pins that a heredoc body stays eligible as a first USE.
HEREDOC_CALIBRATION = '''#!/usr/bin/env bash
_ctl_heredoc_call() {
  local inst="$1" ws
  if ! ws="$(rig_resolve_ws "$inst")"; then
    echo '{"isError":true,"error":"could not resolve workspace"}'
    return 1
  fi
  rig_pcusp_run "$inst" <<EOS
TOK="\\$(cat "\\$f" 2>/dev/null)"
if [ -z "\\$TOK" ]; then echo "NO_TOKEN"; exit 1; fi
curl -s "http://127.0.0.1/api/mcp?workspace=${ws}"
EOS
}
'''

# Must NOT fire. This is the multiline spelling of an assignment's own failure
# guard. The return is reachable only when `readlink` failed, so `raw_target`
# was never measured. Kept verbatim-shaped after claim-target-dir.sh exposed
# the scanner's previous formatting-dependent false positive.
MULTILINE_ASSIGNMENT_GUARD_CALIBRATION = '''#!/usr/bin/env bash
restore_missing_referent() {
  local root="$1" raw_target target
  raw_target="$(readlink "$root")" || {
    echo "cannot read symlink"
    return 1
  }
  [[ -n "$raw_target" ]] || return 1
  target="$raw_target"
  echo "$target"
}
'''

# MUST FIRE — and it is the most important control in this file, because it pins
# the WRONG fix shut.
#
# While triaging, the tempting precision rule was "an intervening return that
# ECHOES its own message is reporting, not silently discarding, so suppress it."
# That rule is false, and this is the counter-example that proves it: the return
# below does echo a scoped FAIL, yet `$probe` — measured before it, and named in
# the LATER message as the rig-vs-feature discriminator — is destroyed on that
# path. Adopting the echo rule would have suppressed b9-attestation.sh's
# `$wrong_on_b`, the single confirmed true positive in the whole library.
#
# The real question is never "did it print something" but "did it print the value
# it was HOLDING", which is semantic and belongs to a human reading the site.
REPORTING_RETURN_CONTROL = '''#!/usr/bin/env bash
_ctl_reporting_return() {
  local probe measured
  probe="$(drv_psql b "SELECT count(*) FROM harness_shared.p2p_receipts;")"
  measured="$(drv_psql a "SELECT 1;")"
  [ -n "$measured" ] || { echo "FAIL — post-probe UNMEASURED (the probe never ran)"; return 1; }
  echo "FAIL — refused-op across the boundary (probe-on-b=${probe:-<unmeasured>})"
  return 1
}
'''


def leading_ws(line: str) -> int:
    return len(line) - len(line.lstrip())


def find_functions(lines):
    """(name, start_idx, end_idx) for each function, by brace depth."""
    funcs = []
    for idx, line in enumerate(lines):
        m = FUNC_START.match(line)
        if not m:
            continue
        depth = 0
        for j in range(idx, len(lines)):
            depth += lines[j].count("{") - lines[j].count("}")
            if depth <= 0 and j > idx:
                funcs.append((m.group(1), idx, j))
                break
    return funcs


def heredoc_regions(lines):
    """(body_lines, nonexpanding_lines) as sets of 0-based indices.

    body_lines        — shipped to another shell; never local control flow.
    nonexpanding_lines — body of a QUOTED delimiter (<<'EOS'), where the local
                         shell expands nothing, so `$var` there is not a use.
    """
    body, nonexpanding = set(), set()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = None
        for cand in HEREDOC_START.finditer(line):
            # `<<<word` is a here-STRING, not a here-doc: it has no body and no
            # terminator, so treating it as one would swallow the rest of the file.
            if cand.start() > 0 and line[cand.start() - 1] == "<":
                continue
            m = cand
            break
        if not m:
            i += 1
            continue
        tag, quoted = m.group("tag"), bool(m.group("q"))
        j = i + 1
        while j < len(lines) and lines[j].strip() != tag:
            body.add(j)
            if quoted:
                nonexpanding.add(j)
            j += 1
        i = j + 1
    return body, nonexpanding


def self_guard_span(lines, n, fend):
    """Return the body of an assignment's own failure guard.

    Returns inside either `if ! VAR=$(...)` or multiline `VAR=$(...) || { ... }`
    fire only when the command substitution failed, so there is no measured
    value for them to strand.
    """
    indent = leading_ws(lines[n])
    if SELF_GUARD_START.match(lines[n]):
        for k in range(n + 1, fend + 1):
            stripped = lines[k].strip()
            if stripped in ("fi", "fi;") and leading_ws(lines[k]) <= indent:
                return range(n + 1, k)
        return range(0, 0)

    if ASSIGN_FAILURE_BLOCK_START.search(lines[n]):
        for k in range(n + 1, fend + 1):
            stripped = lines[k].strip()
            if stripped in ("}", "};") and leading_ws(lines[k]) <= indent:
                return range(n + 1, k)
    return range(0, 0)


def scan_text(text: str):
    lines = text.splitlines()
    heredoc_body, heredoc_nonexpanding = heredoc_regions(lines)
    hits = []
    for fname, fstart, fend in find_functions(lines):
        for n in range(fstart, fend + 1):
            line = lines[n]
            if line.lstrip().startswith("#"):
                continue
            for m in ASSIGN.finditer(line):
                var, rhs = m.group(1), m.group(2)
                if var.lower() in BORING:
                    continue

                use_re = re.compile(r"\$\{?" + re.escape(var) + r"\b")
                first_use = None
                for k in range(n + 1, fend + 1):
                    if lines[k].lstrip().startswith("#"):
                        continue
                    # A quoted-delimiter heredoc expands nothing, so `$var`
                    # inside one is literal text, not a use of the measurement.
                    if k in heredoc_nonexpanding:
                        continue
                    if use_re.search(lines[k]):
                        first_use = k
                        break
                if first_use is None:
                    continue

                # A return between assignment and first use, at a nesting level
                # at or shallower than the assignment, is reachable without the
                # measured value ever being consumed.
                assign_indent = leading_ws(line)
                guarded = set(self_guard_span(lines, n, fend))
                blockers = [
                    k
                    for k in range(n + 1, first_use)
                    # .search(), NOT .match() — .match() anchors at position 0
                    # and would re-introduce the start-anchored blindness a
                    # third time, at the call site rather than in the pattern.
                    if RETURN_OR_EXIT.search(lines[k])
                    and not lines[k].lstrip().startswith("#")
                    and leading_ws(lines[k]) <= assign_indent + 2
                    # Runs on another machine — cannot return from this function.
                    and k not in heredoc_body
                    # Fires only when this very assignment failed, so there is no
                    # measured value for it to strand.
                    and k not in guarded
                ]
                if blockers and not is_counter_increment(var, rhs):
                    kind = classify_rhs(rhs)
                    hits.append(
                        {
                            "func": fname,
                            "var": var,
                            "assigned": n + 1,
                            "first_use": first_use + 1,
                            "gap": first_use - n,
                            "returns": [k + 1 for k in blockers],
                            "rhs": rhs.strip()[:90],
                            "kind": kind,
                        }
                    )
    # Measurements first: a discarded psql count destroys a verdict, a discarded
    # workspace-id strands nothing. Stable within tier so line order is kept.
    hits.sort(key=lambda h: TIER_ORDER.get(h["kind"], 1))
    return hits


def self_test(verbose=True):
    """Controls MUST fire; calibrations MUST NOT.

    Two of these guard against BLINDNESS (a scanner that reports a library clean
    because it cannot see) and two against OVER-FIRING (a scanner nobody reads
    because 85% of its output is noise). Both failure modes end the same way:
    the tool stops being believed.
    """
    cases = [
        ("control — WI-40542 canonical shape", CONTROL, 1, "SCANNER IS BLIND"),
        ("calibration — consumed before return", CALIBRATION, 0, "SCANNER OVER-FIRES"),
        ("calibration — heredoc body + self-guard", HEREDOC_CALIBRATION, 0, "SCANNER OVER-FIRES"),
        ("calibration — multiline assignment guard", MULTILINE_ASSIGNMENT_GUARD_CALIBRATION, 0, "SCANNER OVER-FIRES"),
        ("control — reporting return still strands", REPORTING_RETURN_CONTROL, 1, "SCANNER IS BLIND"),
        ("calibration — counter increment is not a reading", COUNTER_CALIBRATION, 0, "SCANNER OVER-FIRES"),
    ]
    results = [(label, len(scan_text(src)), want, err) for label, src, want, err in cases]
    ok = all(got == want for _, got, want, _ in results)
    if verbose or not ok:
        print("── self-test ──")
        for label, got, want, err in results:
            verdict = "✓" if got == want else f"✗ {err}"
            print(f"  {label:<44} {got} hit(s), want {want}  {verdict}")
    return ok


BASELINE_PATH = Path(__file__).resolve().parent / "scan-discarded-measurements.baseline.txt"


LIB_ROOT = Path(__file__).resolve().parent


def _identity(path, hit):
    """Line-INDEPENDENT identity for a candidate site.

    Deliberately NOT keyed on line number: the WI-40549 fix moved one site from L394
    to L443 by inserting lines ABOVE it, and a line-keyed baseline would have gone
    stale on that unrelated edit. A baseline that goes stale on every edit trains
    people to re-seed it blindly, which is how an allowlist stops being a guard.

    Path-qualified (relative to bin/lib) rather than bare basename, so two files with
    the same name in different directories cannot collide into one baseline entry —
    a collision would let a NEW strand inherit an existing entry's amnesty silently.
    """
    p = Path(path).resolve()
    try:
        name = str(p.relative_to(LIB_ROOT))
    except ValueError:
        name = p.name
    return f"{name}::{hit['func']}::{hit['var']}"


def _load_baseline():
    if not BASELINE_PATH.exists():
        return None
    return {
        line.strip()
        for line in BASELINE_PATH.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    }


def main(argv):
    flags = {"--self-test", "--guard", "--seed-baseline"}
    args = [a for a in argv[1:] if a not in flags]
    only_self_test = "--self-test" in argv
    guard_mode = "--guard" in argv
    seed_mode = "--seed-baseline" in argv

    if not self_test(verbose=only_self_test):
        print(
            "\nCONTROL FAILED — this scanner cannot see the defect it exists to find.\n"
            "Any '0 candidates' result from it is meaningless. Fix the scanner first.",
            file=sys.stderr,
        )
        return 2
    if only_self_test:
        return 0

    # Default population is ALL of bin/lib, not just scenarios/. The class is not
    # scenario-specific: deb-hetzner-rig.sh — which DEFINES rig_reading, the very
    # mechanism scenarios use to report at the measurement point — carries the same
    # shape, and a guard covering 15 of 58 comparable files reports GUARD OK while
    # the class walks in through the other 43.
    roots = args or [str(LIB_ROOT)]
    files = []
    for r in roots:
        p = Path(r)
        files.extend(sorted(p.rglob("*.sh")) if p.is_dir() else [p])

    total = 0
    found = []
    for f in files:
        hits = scan_text(Path(f).read_text(errors="replace"))
        if not hits:
            continue
        if not (guard_mode or seed_mode):
            print(f"\n=== {f} ===")
        for h in hits:
            total += 1
            found.append((f, h))
            if guard_mode or seed_mode:
                continue
            print(
                f"  [{h['kind']}] {h['func']}(): ${h['var']} measured at L{h['assigned']}, "
                f"first used at L{h['first_use']} (gap {h['gap']} lines)"
            )
            print(f"      intervening return/exit at: {h['returns']}")
            print(f"      rhs: {h['rhs']}")

    if seed_mode:
        idents = sorted({_identity(f, h) for f, h in found})
        BASELINE_PATH.write_text(
            "\n".join(
                [
                    "# scan-discarded-measurements baseline — GENERATED by --seed-baseline.",
                    "# NEVER hand-author or hand-extend this file: it is the measured population,",
                    "# and a hand-added line is an unmeasured claim wearing a measurement's clothes.",
                    "#",
                    "# SHRINK-ONLY. A NEW identity not listed here is a regression the guard REJECTS.",
                    "# These entries are ACCEPTED-FOR-NOW candidates, NOT verdicts that they are safe —",
                    "# each still deserves the three-state treatment; being here only means it predates",
                    "# the guard. Removing one (by fixing the site) is the intended direction of travel.",
                    "#",
                    "# Identity is file::function::var, deliberately line-INDEPENDENT.",
                ]
                + idents
            )
            + "\n"
        )
        print(f"seeded baseline from a MEASURING run: {BASELINE_PATH} ({len(idents)} entries)")
        return 0

    if guard_mode:
        baseline = _load_baseline()
        if baseline is None:
            print(
                f"GUARD UNMEASURED — no baseline at {BASELINE_PATH}.\n"
                "This is NOT a pass: seed it with --seed-baseline first.",
                file=sys.stderr,
            )
            return 2
        current = {_identity(f, h) for f, h in found}
        new = sorted(current - baseline)
        stale = sorted(baseline - current)
        for ident in stale:
            print(f"  · baseline entry no longer present — prune it (re-seed): {ident}")
        if new:
            print(f"\nGUARD FAILED — {len(new)} NEW discarded-measurement site(s):", file=sys.stderr)
            for ident in new:
                h = next(h for f, h in found if _identity(f, h) == ident)
                print(
                    f"  {ident}  (measured L{h['assigned']}, first used L{h['first_use']}, "
                    f"intervening return/exit at {h['returns']})",
                    file=sys.stderr,
                )
            print(
                "\nEmit the verdict AT the point of measurement, in THREE states "
                "(no / yes / UNMEASURED).\nIf the site is genuinely fine, re-seed the baseline "
                "and say why — do not hand-edit the baseline file.",
                file=sys.stderr,
            )
            return 1
        print(
            f"GUARD OK — {len(current)} candidate(s), all baselined, 0 new"
            + (f"; {len(stale)} stale baseline entr{'y' if len(stale) == 1 else 'ies'} to prune." if stale else ".")
        )
        return 0

    print(f"\nscanned {len(files)} file(s) — {total} candidate(s)")
    if total:
        print(
            "\nCANDIDATES ARE NOT VERDICTS. For each, ask: can that return execute\n"
            "on a run where the measurement mattered? If yes, emit the verdict AT\n"
            "the point of measurement, in THREE states (no / yes / UNMEASURED) —\n"
            "never two, because the missing third is what reads as a clean result."
        )
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
