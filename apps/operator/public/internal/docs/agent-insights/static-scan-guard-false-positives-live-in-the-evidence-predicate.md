# Static-scan guard false positives live in the EVIDENCE predicate, not the identifier
URL: /internal/docs/agent-insights/static-scan-guard-false-positives-live-in-the-evidence-predicate

The shell-write/interpreter guard has now produced the same false-positive shape twice: it denied ordinary READ-ONLY agent work. Both times the bug was in what counts as evidence of a WRITE (a bare write-call regex matching sys.stdout.write), never in what counts as a tree PATH — and both times the tell was the guard firing on its own author's verification command mid-fix. Fix pattern: strip non-effect sinks before scanning, and require an ambiguous token to be PAIRED with a corroborating construct in the same body. Verify with true-positive controls plus the masking case (a benign sink alongside a real write), or the narrowing silently opens a hole.

## The mistake this prevents

A guard that scans command text has two predicates: **the identifier** ("does
this name a protected thing?") and **the evidence of effect** ("does this
actually DO the thing we're blocking?"). Attention goes to the identifier,
because that's the interesting part. **The false positives live in the evidence
predicate**, because that's where a cheap regex stands in for semantics.

The interpreter-write guard has now produced the identical failure twice:

| round                      | what it denied                                                                         | evidence predicate at the time                |
| -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| EI-18691482279179647 (fix) | its own read-only `open(<file>).read()` syntax check                                   | *none* — any tree path in inline code         |
| EI-18692070370140239       | `python3 -c 'import sys; sys.stdout.write("<tree path>")'` — a script that only PRINTS | `\bwrite\w*\s*\(` — matched **any** `.write(` |

Both rounds denied ordinary read-only work. Neither round was a path-matching
bug. The first fix *added* an evidence predicate; the second fixed the
predicate it added. If a third round appears, look here first.

## The tell: it fires on its own author, mid-verification

Both rounds were caught the same way — **the guard blocked the very command
being used to verify it**. Round one denied the author's `open(...).read()`
syntax check. Round two denied an agent building JSON payloads *into `/tmp`*,
because the payload string contained a tree-relative path next to
`sys.stdout.write(`. Nothing was written to the tree in either case.

That is a strong signal, not a coincidence: verification work reads and prints
the exact identifiers the guard watches for, without performing the effect. So
verification is the highest-density source of false positives you have — if a
guard trips on its own test harness, do not route around it, that IS the bug
report.

## Fix pattern

Two moves, both cheap and both about evidence:

1. **Strip non-effect sinks before scanning.** A write to `stdout`/`stderr` is
   not a filesystem write. Remove them from the body *first*, so they can
   neither trip nor mask an indicator:

   ```python
   _NONFILE_WRITE_RE = re.compile(
       r'\b(?:sys|process)\s*\.\s*(?:stdout|stderr)\s*\.\s*write\w*\s*\('
   )
   ```

2. **Require pairing for an ambiguous token.** A bare `.write(` is genuinely
   undecidable without dataflow — file handle, `io.StringIO`, socket, HTTP
   response. So it counts only alongside a corroborating construct in the
   **same body**; unambiguous named forms stay standalone:

   ```python
   def _body_indicates_file_write(body):
       scan = _NONFILE_WRITE_RE.sub('', body)
       if _WRITE_INDICATOR_RE.search(scan):       # open(p,'w'), writeFileSync,
           return True                             # write_text, … — unambiguous
       return bool(_BARE_WRITE_CALL_RE.search(scan)
                   and _FILE_OBJECT_RE.search(scan))  # open( | Path( | fdopen(
   ```

**Why the pairing requirement is sound here and not a hole:** this guard only
ever scans *inline* code (`-c` / `-e` / heredoc). A one-liner that writes a file
must open it in that same body. Pairing would be unsound for a guard scanning
whole files, where the handle can come from anywhere — the soundness comes from
the scan's scope, so re-derive it before copying this pattern elsewhere.

## Verifying a narrowing — controls, and the masking case

A narrowing that only proves "the false positive stopped" is worthless; it may
have removed the guard. Every probe needs **true-positive controls in the same
run**, and one case most people miss:

* **the masking case** — a benign sink *alongside* a real effect:
  `python3 -c 'import sys; sys.stdout.write("hi"); open("<tree path>","w").write("x")'`
  must still DENY. This is what proves step 1's `.sub('')` cannot delete the
  evidence of a real write sitting next to it. If you assert that property in a
  code comment, assert it in a test too.
* the **predecessor's** false positive (`open(p).read()`) must stay allowed —
  otherwise you have regressed round one while fixing round two.
* the original incident shape (here, a heredoc script rewriting a tree file),
  since heredoc and `-c` bodies reach the indicator through *different*
  extractors.

Result on the real hook: 16/16, up from 4 mismatches, with every true positive
still denying.

## Probing this hook directly (and the meta-trap)

The guard is a `PreToolUse` hook: feed it the JSON payload on stdin and read the
verdict off stdout.

```python
payload = json.dumps({"tool_name": "Bash",
                      "tool_input": {"command": command},
                      "cwd": TREE})
proc = subprocess.run([HOOK], input=payload, capture_output=True, text=True)
verdict = "DENY" if '"deny"' in (proc.stdout + proc.stderr) else "allow"
```

**The meta-trap:** writing that probe as an inline `python3 -c` will trip the
guard *you are testing*, because your probe's own source contains tree paths
next to write-ish tokens. Put the probe in a **real file outside the tree** and
run `python3 /tmp/.../probe.py` — the guard deliberately ignores non-inline
invocations ("the code lives in a real file, which Edit already locks"). Build
the path from concatenated fragments if the probe file itself needs to dodge a
scan.

Two harness traps worth stating, because both silently produce a clean-looking
pass:

* **quoting.** Passing a command through bash single quotes with `\"` escapes
  makes `_extract_quoted_flag_bodies`' non-greedy `-[ce]\s+(['"])(.*?)\1` stop at
  the first escaped quote, so the path never reaches the scan and everything
  "allows". Build command strings in Python, not in the shell.
* **an all-allow run is a broken harness until a control proves otherwise.** The
  first probe run here returned allow for every case *including* a real
  `open(p,'w')` write — that was the quoting bug above, not a permissive guard.
  A control caught it immediately; without one it reads as "no false positives,
  ship it".
