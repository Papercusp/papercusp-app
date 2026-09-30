#!/usr/bin/env node
/**
 * check-assert-integrity.mjs — mechanical guard for the CAN-FALSELY-PASS assert
 * class in the live-federation rig scenarios (WI-5788, generalizing WI-5715 /
 * WI-5768 / plan item P-411).
 *
 * WHY THIS EXISTS
 * WI-5715 held the shared-hive release gate RED for its entire history via an
 * assert that could never pass. P-411 then audited every scenario for the two
 * mirror-image failure modes and WI-5768 fixed what it found. But an audit is an
 * ACT, not a GUARD: it buys one clean snapshot and no ratchet. Within the hour,
 * b9-attestation.sh landed carrying the very class the audit had just swept for
 * (its mtime post-dates WI-5768's completion). This lint is that missing ratchet
 * — P-411's rule made executable:
 *
 *     EVERY "COULDN'T MEASURE" MUST BE A FAIL, NEVER A PASS.
 *
 * R6 adds that rule's mirror image (WI-7000):
 *
 *     AN ASSERT NOBODY CALLS IS NOT EVIDENCE.
 *
 * R1–R5 catch an assert that runs and cannot fail. R6 catches an assert that
 * never runs at all — which is strictly worse, because it reds nothing and
 * looks fine in review. `bin/lib/federation-asserts.sh` shipped all five LIVE-1
 * parity asserts (fed_assert_wake_bridge / _delivery_receipts /
 * _federated_events / _presence_gossip / _claim_spec_federation) correct and
 * complete; the caller the runbook named, deb-hetzner-federation.sh, was the
 * RETIRED Hetzner scenario. So the helpers were unreachable for a month while
 * four of five LIVE-1 surfaces stayed "unproven cross-machine, manual PG
 * inspection". Nothing failed. That is the point: a function nobody calls
 * fails silently forever — it just quietly stops being evidence.
 *
 * (Retiring a surface should include grepping what ONLY it called. R6 is that
 * grep, made standing.)
 *
 * A negative/threshold assert over a REMOTE probe (ssh + psql) cannot tell
 * "confirmed zero" from "the query never ran" — both are an empty string. Coercing
 * that empty to 0 sets the baseline to the most permissive value for a
 * strictly-increasing assert, so a single transient blip scores PASS. That is not
 * hypothetical: it is live in b9-attestation.sh LEG3/LEG4 today, where an earlier
 * leg guarantees the counter is already nonzero.
 *
 *   node scripts/check-assert-integrity.mjs
 *
 * THE FALSE-POSITIVE DISCRIMINATOR (why this is not noise): a finding requires the
 * variable to be COMMAND-SUBSTITUTION-DERIVED *and* permissively coerced *and* used
 * in an assert. That is what separates a real unmeasured-probe baseline from an
 * honest local counter like rig_assert_absent's `measured=0`, and it is why the
 * correctly fail-closed sites (rig_assert_absent / rig_assert_row_absent, and
 * deb-hetzner-coord-controlplane.sh's `[ "$n_x" = 1 ]` call sites) stay green.
 *
 * SUPPRESSION: put `# assert-integrity-ok: <reason>` on the offending line or the
 * line above it. A deliberate exception must carry its justification at the site —
 * never a silent allowlist entry. Whole-file exemptions go in ALLOW below.
 *
 * Scope: tracked .sh under papercusp-desktop/bin/ (the rig + scenario surface).
 * Excludes *.selftest.sh (they assert ON these shapes deliberately).
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripShellTrailingComment } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'papercusp-desktop/bin/';

/** Whole-file exemptions. Prefer the inline `# assert-integrity-ok:` pragma. */
const ALLOW = new Set([]);

const PRAGMA = 'assert-integrity-ok:';

/** Vars assigned anywhere from a command substitution — the probe-derived set. */
function cmdSubVars(lines) {
  const set = new Set();
  for (const line of lines) {
    // VAR="$(...)"  |  VAR=$(...)  |  local VAR="$(...)"
    const m = line.match(/^\s*(?:local\s+|declare\s+-\w+\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"?\$\()/);
    if (m) set.add(m[1]);
  }
  return set;
}

/**
 * A pragma counts when it is on the offending line, or ANYWHERE in the contiguous comment
 * block immediately above it. Requiring it on exactly the preceding line punished the
 * authors doing the right thing: a genuine exemption needs a real WHY, a real WHY runs to
 * several comment lines, and only the FIRST carried the token — so the suppression silently
 * did nothing and the finding stayed red. Scanning the attached block keeps the pragma bound
 * to the line (a blank line or any code ends the block) while letting the reason breathe.
 */
const suppressed = (lines, i) => {
  if ((lines[i] ?? '').includes(PRAGMA)) return true;
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j] ?? '';
    if (!/^\s*#/.test(l)) return false; // block ended (blank line or code) — not attached
    if (l.includes(PRAGMA)) return true;
  }
  return false;
};

const NUM_CMP = /-(?:gt|ge|lt|le|eq|ne)\b/;

function scan(file, text) {
  const lines = text.split('\n');
  const derived = cmdSubVars(lines);
  const out = [];
  const add = (i, rule, msg) => {
    if (!suppressed(lines, i)) out.push({ file, line: i + 1, rule, msg });
  };

  // Which derived vars are later used in a NUMERIC comparison anywhere?
  const numericallyCompared = new Set();
  for (const line of lines) {
    if (!NUM_CMP.test(line)) continue;
    for (const v of derived) if (line.includes(`$${v}`) || line.includes(`\${${v}}`)) numericallyCompared.add(v);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;

    // R1 — unmeasured value coerced PERMISSIVE, then used in a threshold compare.
    //      `[ -z "$X" ] && X=0`  |  `X="${X:-0}"`  |  `X=$(... || echo 0)`
    const c1 = line.match(/\[\s*-z\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s*\]\s*&&\s*\1=(\S+)/);
    const c2 = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)="?\$\{\1:-([^}]*)\}"?/);
    const c3 = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=.*\|\|\s*echo\s+(\S+)\s*\)/);
    const c = c1 || c2 || c3;
    if (c) {
      const [v, lit] = [c[1], c[2]];
      if (derived.has(v) && numericallyCompared.has(v)) {
        add(
          i,
          'R1-permissive-coercion',
          `"${v}" comes from a command substitution, is coerced to ${lit} when EMPTY, then used in a numeric assert. An empty read means EITHER a confirmed value OR a probe that never ran — coercing it to ${lit} makes an unmeasurable probe score as the permissive case. Track the exit code and FAIL when unmeasured (see rig_assert_absent in bin/lib/deb-hetzner-rig.sh).`,
        );
      }
    }

    // R2 — a probe-derived var pre-initialised to the value its assert treats as PASS.
    const d = line.match(/^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=(\d+|"[^"$]*")\s*(?:#.*)?$/);
    if (d) {
      const [v, lit] = [d[1], d[2].replace(/"/g, '')];
      if (derived.has(v)) {
        const assertedPass = lines.some((l) =>
          new RegExp(`\\[\\s*"?\\$\\{?${v}\\}?"?\\s*=\\s*"?${lit}"?\\s*\\]`).test(l),
        );
        if (assertedPass) {
          add(
            i,
            'R2-default-to-pass',
            `"${v}" is pre-set to ${lit} and later asserted with = ${lit} as the success condition, but is only conditionally assigned from a probe. If the probe is skipped or fails, the assert passes VACUOUSLY. Give the unmeasured case its own explicit branch.`,
          );
        }
      }
    }

    // R3 — `grep -c` captured into a threshold compare with no rc guard.
    if (/\$\([^)]*grep\s+-c\b/.test(line)) {
      const m = line.match(/^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
      const guarded = /rc=\$\?|\|\|\s*(?:return|exit|\{)/.test(line) || /rc=\$\?/.test(lines[i + 1] ?? '');
      if (m && numericallyCompared.has(m[1]) && !guarded) {
        add(
          i,
          'R3-grep-c-unguarded',
          `"${m[1]}" is a \`grep -c\` count fed into a numeric assert with no exit-code guard. grep -c prints 0 and exits 1 on a MISSING file or an empty stream, so a probe that never produced output is indistinguishable from a genuine zero.`,
        );
      }
    }

    // R4 — empty-read branch that warns and CONTINUES instead of failing.
    const e = line.match(/^\s*(?:els)?if\s*\[\s*-z\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s*\]\s*;?\s*then/);
    if (e && derived.has(e[1])) {
      let body = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*(fi|elif|else)\b/.test(lines[j])) break;
        body += lines[j] + '\n';
      }
      // A branch that sets a STATUS variable nonzero (`rc=1`, `FAIL=1`) is failing just
      // as much as one that returns — but ONLY if that variable is provably propagated
      // by the enclosing function/script (`return "$rc"` / `exit "$FAIL"`). Setting a
      // status var that nothing ever returns is EXACTLY the silent-continue this rule
      // exists to catch, so the propagation check is mandatory and never assumed: no
      // matching `return`/`exit` of that var in the file ⇒ still a finding.
      //
      // Without this, R4 fired on correct code (scenario-coord-control-plane.sh CC-4/CC-5,
      // mac-vm-fd-limit-verify.sh §1) whose empty branches DO fail via rc=1/FAIL=1. Making
      // authors pragma correct code is how a lint dies: the pragma stops meaning "reviewed
      // and genuinely safe" and starts meaning "this lint is noisy", and then a REAL hit
      // gets pragma'd by reflex too.
      // A status var is set either to a LITERAL (`rc=1`, `FAIL=1`) or bumped as an
      // accumulating COUNTER (`missing=$((missing + 1))`, `((n++))`). The counter is the
      // shape a PREFLIGHT adopts when it wants to report every unmet precondition in one
      // pass instead of dying at the first — it carries HOW MANY failed, not merely THAT
      // one did. Recognising only the literal form made R4 fire on local-matrix.sh's
      // (correct) gh-token check, whose empty branch increments `missing` and whose
      // enclosing function then does `[ "$missing" != 0 ] && return 1`: the code failed
      // exactly as this rule demands, and the rule reported it as a silent continue.
      // Propagation stays MANDATORY for a counter, identically to a literal — a counter
      // nothing ever returns is still the silent-continue this rule exists to catch.
      const statusVars = [
        ...[...body.matchAll(/(?:^\s*|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)=([1-9]\d*)\s*(?:;|$)/gm)].map((m) => m[1]),
        // `X=$((X + 1))` — self-referential so a plain `X=$((Y + 1))` recompute is not a status bump.
        ...[...body.matchAll(/(?:^\s*|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)=\$\(\(\s*\1\s*\+\s*[1-9]\d*\s*\)\)/gm)].map(
          (m) => m[1],
        ),
        // `((X++))` / `((X += 1))`, and the `let` spelling of both.
        ...[
          ...body.matchAll(
            /(?:^\s*|[;&|]\s*)(?:\(\(|let\s+"?)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|\+=\s*[1-9]\d*)/gm,
          ),
        ].map((m) => m[1]),
      ];
      // Propagation takes three shapes, and ALL must be recognised or the rule punishes a
      // correct refactor: (a) the var is returned/exited directly (`exit "$FAIL"`), or
      // (b) the var is TESTED in a condition that guards a return/exit within a few lines
      // (`if [ "$FAIL" != 0 ]; then echo …; exit 1`). Shape (b) is what a script adopts the
      // moment it needs more than two outcomes — e.g. a distinct exit for "partial/skipped" —
      // and treating that as non-propagating re-reds code that just got MORE honest.
      // (c) is (b) reached via a counter rather than a boolean — see statusVars above.
      const propagatesFailure = statusVars.some((v) => {
        const direct = new RegExp(`\\b(?:return|exit)\\s+"?\\$\\{?${v}\\}?"?`);
        const tested = new RegExp(`\\[\\s*"?\\$\\{?${v}\\}?"?\\s*(?:!=|=|-ne|-eq|-gt|-ge|-lt|-le)`);
        return lines.some((l, k) => {
          if (direct.test(l)) return true;
          if (!tested.test(l)) return false;
          return lines.slice(k, k + 4).some((n) => /\b(?:exit|return)\b/.test(n));
        });
      });
      if (!/\b(return|exit)\b/.test(body) && !propagatesFailure && /\becho\b/.test(body)) {
        add(
          i,
          'R4-empty-read-continues',
          `"${e[1]}" is probe-derived; the empty branch logs and CONTINUES, so the scenario can still report success. An empty read conflates "nothing to check" with "the probe failed" and with "the thing under test is genuinely missing" — disambiguate (prove the precondition upstream) or FAIL.`,
        );
      }
    }

    // R5 — `local X="$(cmd)"` masks the command's exit status ($? is always 0).
    if (/^\s*local\s+[A-Za-z_][A-Za-z0-9_]*="?\$\(/.test(line)) {
      const near = [lines[i + 1] ?? '', lines[i + 2] ?? ''].join('\n');
      if (/\$\?/.test(near)) {
        add(
          i,
          'R5-local-masks-rc',
          `\`local X="$(cmd)"\` makes $? the exit status of \`local\` (always 0), not of the command — the following rc check is dead. Split it: \`local X; X="$(cmd)"; rc=$?\`.`,
        );
      }
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * R6 — ORPHANED ASSERT (WI-7000). Cross-file, so it cannot live in scan().
 * ──────────────────────────────────────────────────────────────────────────── */

/** A function name counts as an assert if it says so. */
const ASSERT_NAME = /assert/i;

/**
 * Strip `#`-to-EOL comments, quote-aware.
 *
 * NOT cosmetic — it is what makes R6 mean anything. The densest concentration
 * of an assert's name in this tree is the prose ABOUT it: the lib's own
 * docblock lists all five fed_assert_* helpers, and so does the LIVE-1 runbook.
 * An un-stripped sweep therefore finds a "call" for every orphan and is most
 * confident exactly where a helper is best documented and least used — i.e. it
 * would have scored WI-7000 green. (Same trap closed for the same reason in
 * check-declared-consumed.mjs: a comment is not a use.)
 */
const stripShellComments = (line) => stripShellTrailingComment(line);

const FN_DEF = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/;
const FN_DEF_KW = /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;

/**
 * Split a script into regions: one per function definition, plus the top-level
 * remainder (`name: null`). Function extents come from brace depth.
 */
function segmentFunctions(rawLines) {
  const lines = rawLines.map(stripShellComments);
  const fns = [];
  const top = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FN_DEF) || lines[i].match(FN_DEF_KW);
    if (!m) { top.push(lines[i]); continue; }
    let depth = 0;
    let opened = false;
    let j = i;
    const body = [];
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
      }
      body.push(lines[j]);
      if (opened && depth <= 0) break;
    }
    // Keep what follows the opening brace ON the def line: a one-liner
    // (`drv_psql() { drv_psql_local "$@"; }`) has its ENTIRE body there, and
    // dropping the whole line loses the delegation — which then reports the
    // real implementation as unreachable.
    body[0] = body[0].slice(body[0].indexOf('{') + 1);
    fns.push({ name: m[1], defLine: i + 1, body: body.join('\n') });
    i = j;
  }
  return { fns, top: top.join('\n') };
}

/* ────────────────────────────────────────────────────────────────────────────
 * R7 — DISCARDED READING (WI-40549). Per-FUNCTION, so it cannot live in scan(),
 * which is line-based and has no function scope.
 *
 *     A MEASUREMENT REPORTED ONLY PAST A `return` IS NOT EVIDENCE.
 *
 * The third member of this file's family. R1–R5 catch an assert that runs and
 * cannot fail; R6 catches an assert nobody calls; R7 catches a DIAGNOSTIC that
 * was measured correctly and then thrown away before anyone could read it.
 *
 * THE SHAPE. A leg measures a diagnostic ("did the probe actually land on frame
 * b?"), then reaches its scoring message through one of SEVERAL exit paths — but
 * only ONE of those paths interpolates the value. Every other path returns having
 * silently discarded it. The reading is most valuable in exactly the paths that
 * drop it: when a leg bails early, "did the probe ever land?" is the question
 * separating a rig fault from a real product failure, and it is unrecoverable
 * afterwards because the frames are torn down.
 *
 * Live instances, both in b9-attestation.sh — the same file that motivated R1–R5:
 *   - $wrong_on_b measured at LEG3, printed only in the final FAIL message; the
 *     post-probe-UNMEASURED bail returned without it.
 *   - $probe_on_b measured at LEG4, discarded by BOTH the UNMEASURED return AND
 *     the OK path — so it was lost on green runs and dead-probe runs alike.
 *
 * WHY POSITIONAL, NOT PER-EXIT-PATH. The fix is to report AT the measurement
 * (`rig_reading`, bin/lib/deb-hetzner-rig.sh), so every exit path inherits the
 * reading for free. Patching each scoring message instead leaves the class armed:
 * the next early-return added to the leg silently re-breaks it. That is why this
 * rule keys off the FIRST reference rather than auditing each return.
 *
 * DELIBERATELY NARROW — fires only on the diagnostic-only class: EVERY reference
 * to the value must sit inside a reporting command (echo/printf/rig_reading). A
 * value that also feeds a conditional or an assert is excluded, because there an
 * intervening `return` is ordinary control flow, not a lost reading. Over-firing
 * on normal branching would train authors to blanket-suppress the rule, which
 * costs more than the class does.
 * ──────────────────────────────────────────────────────────────────────────── */

const REPORTING_CMD = /(?:^|[;&|]|\bthen\b|\{)\s*(?:echo|printf|rig_reading)\b/;
const RETURN_STMT = /(?:^|[;&|]|\bthen\b|\{)\s*return\b/;

function hasBareArithmeticRef(line, variable) {
  // Bash arithmetic contexts accept bare identifiers (`(( expires <= now ))` and
  // `$((now + ttl))`).  Treat those as real logical consumption just like `$now`;
  // otherwise R7 misclassifies a value used in arithmetic as diagnostic-only.
  const identifier = new RegExp(`(?:^|[^A-Za-z0-9_])${variable}(?![A-Za-z0-9_])`);
  for (const match of line.matchAll(/\(\((.*?)\)\)/g)) {
    if (identifier.test(match[1])) return true;
  }
  return false;
}

function discardedReadings(file, text) {
  const rawLines = text.split('\n');
  const { fns } = segmentFunctions(rawLines);
  const out = [];

  for (const fn of fns) {
    const body = fn.body.split('\n');
    for (let i = 0; i < body.length; i++) {
      const m = body[i].match(
        /^\s*(?:local\s+|declare\s+-\w+\s+)?([A-Za-z_][A-Za-z0-9_]*)="?\$\((?!\()/,
      );
      if (!m) continue;
      const v = m[1];

      // Reference = $v or ${v...}, but NOT a longer identifier merely starting with v.
      const refRe = new RegExp(`\\$\\{${v}[^A-Za-z0-9_]|\\$${v}(?![A-Za-z0-9_])`);
      const refs = [];
      for (let j = i + 1; j < body.length; j++) {
        if (refRe.test(body[j]) || hasBareArithmeticRef(body[j], v)) refs.push(j);
      }

      // Never referenced at all is a DIFFERENT defect (dead assignment), not this one.
      if (refs.length === 0) continue;

      // Diagnostic-only gate: if the value is ALSO consumed by logic, an
      // intervening return is legitimate control flow, not a discarded reading.
      if (!refs.every((j) => REPORTING_CMD.test(body[j]))) continue;

      // Can a `return` pre-empt the FIRST place this value is reported?
      let preempt = -1;
      for (let j = i + 1; j < refs[0]; j++) {
        if (RETURN_STMT.test(body[j])) {
          preempt = j;
          break;
        }
      }
      if (preempt < 0) continue;

      const absIdx = fn.defLine - 1 + i;
      if (suppressed(rawLines, absIdx)) continue;
      out.push({
        file,
        line: absIdx + 1,
        rule: 'R7-discarded-reading',
        msg:
          `"${v}" is measured here but is only ever REPORTED at line ${fn.defLine + refs[0]}, ` +
          `and the \`return\` at line ${fn.defLine + preempt} can be taken first — so on that path ` +
          `the reading is measured and then silently discarded. That is the path where it matters ` +
          `most: an early bail is exactly when "did the probe actually land?" separates a rig fault ` +
          `from a product failure, and the frames are gone afterwards. Report AT the measurement ` +
          `instead — \`rig_reading "<label>" "$${v}"\` immediately after the assignment ` +
          `(bin/lib/deb-hetzner-rig.sh) — so every exit path inherits it and the next early-return ` +
          `added here cannot re-break it.`,
      });
    }
  }
  return out;
}

/**
 * Assert helpers that no execution path can reach.
 *
 * REACHABILITY, not "is it called somewhere outside its own file". The naive
 * form breaks both ways here: fed_assert_* helpers legitimately call sibling
 * helpers in the same lib (so same-file calls are real), while a lib function
 * called ONLY by another orphaned lib function is still an orphan. So: roots
 * are the top-level regions of every script, then BFS through callees.
 *
 * The root set is deliberately PERMISSIVE (every file's top level, including
 * libs that may themselves be sourced by nobody). An over-permissive root set
 * can only under-report, never invent a finding — and it still re-derives
 * WI-7000 exactly: delete parity.sh from the tree and this reports those five
 * helpers and nothing else.
 */
function orphanedAsserts(files, read = (f) => readFileSync(resolve(ROOT, f), 'utf8')) {
  const defs = new Map(); // name -> { file, defLine, lines }
  const bodies = new Map(); // name -> concatenated body text
  const roots = [];

  for (const f of files) {
    let raw;
    try { raw = read(f); } catch { continue; }
    const lines = raw.split('\n');
    const { fns, top } = segmentFunctions(lines);
    roots.push(top);
    for (const fn of fns) {
      if (!defs.has(fn.name)) defs.set(fn.name, { file: f, defLine: fn.defLine, lines });
      bodies.set(fn.name, `${bodies.get(fn.name) ?? ''}\n${fn.body}`);
    }
  }

  const names = [...defs.keys()];
  // A call is the name as a whole word. `-` and `.` are excluded from the
  // boundary class so `foo-bar` / `foo.sh` never read as a call to `foo`.
  const callsIn = (text) => names.filter((n) => new RegExp(`(^|[^A-Za-z0-9_.-])${n}([^A-Za-z0-9_.-]|$)`, 'm').test(text));

  const reachable = new Set();
  const queue = [];
  const push = (n) => { if (!reachable.has(n)) { reachable.add(n); queue.push(n); } };
  for (const r of roots) for (const n of callsIn(r)) push(n);
  while (queue.length) for (const c of callsIn(bodies.get(queue.shift()) ?? '')) push(c);

  const asserts = names.filter((n) => ASSERT_NAME.test(n));
  const findings = [];
  for (const n of asserts) {
    if (reachable.has(n)) continue;
    const d = defs.get(n);
    if (suppressed(d.lines, d.defLine - 1)) continue;
    findings.push({
      file: d.file,
      line: d.defLine,
      rule: 'R6-orphaned-assert',
      msg:
        `"${n}" is an assert that NO execution path reaches — no script's top level calls it, ` +
        'and nothing reachable calls it either. It cannot fail, so it is not evidence; it is dead code ' +
        'that reads like proof. Give it a real caller (a runner/scenario that is itself invoked), or delete it. ' +
        'See WI-7000: five LIVE-1 parity asserts sat unreachable for a month after their named caller was retired, ' +
        'while the surfaces they were written to prove stayed "unproven, manual PG inspection".',
    });
  }
  return { findings, assertCount: asserts.length, unreachableAll: names.filter((n) => !reachable.has(n)) };
}

/**
 * Enumerate the rig/scenario scripts.
 *
 * Deliberately a filesystem walk, NOT `git ls-files`: papercusp-desktop is a
 * SUBMODULE, so a superproject `git ls-files` returns ZERO matches here and this
 * lint would scan nothing and exit 0 — a green that means "I never looked". That
 * is precisely the can-falsely-pass class this file exists to catch, so it must
 * not be the way this file finds its own inputs. (Caught on the first run of this
 * lint, which is the only reason it is written this way.)
 */
function scriptsInScope() {
  const dir = resolve(ROOT, SCOPE);
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '_retired' || e.name === 'target') continue;
        walk(p);
      } else if (e.name.endsWith('.sh') && !e.name.endsWith('.selftest.sh')) {
        out.push(relative(ROOT, p));
      }
    }
  };
  walk(dir);
  return out.filter((f) => !ALLOW.has(f)).sort();
}

/**
 * The lint's own "couldn't measure is not a pass" guard. If the scope resolves to
 * implausibly few files, the enumeration broke (submodule moved, dir renamed) and
 * a ✓ would be a lie. Fail loudly instead.
 */
const MIN_EXPECTED_SCRIPTS = 10;

function main() {
  const tracked = scriptsInScope();

  if (tracked.length < MIN_EXPECTED_SCRIPTS) {
    console.error(
      `✗ assert-integrity: scope "${SCOPE}" resolved to only ${tracked.length} script(s) ` +
        `(expected >= ${MIN_EXPECTED_SCRIPTS}).\n\n` +
        '  This lint scanned essentially nothing, so a PASS here would mean "I never looked" —\n' +
        '  the exact can-falsely-pass class it exists to catch. Fix the path or lower\n' +
        '  MIN_EXPECTED_SCRIPTS deliberately; do not let it report green on an empty scan.',
    );
    process.exit(1);
  }

  const findings = [];
  for (const f of tracked) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    findings.push(...scan(f, text));
    findings.push(...discardedReadings(f, text));
  }

  const orphans = orphanedAsserts(tracked);
  findings.push(...orphans.findings);

  // The same "couldn't measure is not a pass" guard, applied to R6's own input:
  // if the walk found no assert helpers at all, the parse broke and a ✓ is a lie.
  if (orphans.assertCount === 0) {
    console.error(
      `✗ assert-integrity: R6 found 0 assert-named functions across ${tracked.length} script(s).\n\n` +
        '  The function-definition parse broke (or the rig moved). R6 cannot be green on a scan\n' +
        '  that found nothing to check — that is the can-falsely-pass class this file exists to catch.',
    );
    process.exit(1);
  }

  if (process.argv.includes('--report-unreachable')) {
    console.log(`ℹ unreachable functions (advisory, non-assert included): ${orphans.unreachableAll.length}`);
    for (const n of orphans.unreachableAll.sort()) console.log(`    ${n}`);
  }

  if (findings.length === 0) {
    console.log(
      `✓ assert integrity: no can-falsely-pass shapes in ${tracked.length} rig/scenario script(s); ` +
        `all ${orphans.assertCount} assert helper(s) are reachable from a caller.`,
    );
    process.exit(0);
  }

  console.error('✗ assert-integrity: assert(s) that are not evidence.\n');
  console.error('  R1-R5 (P-411):  every "couldn\'t measure" must be a FAIL, never a pass.');
  console.error('  R6   (WI-7000): an assert nobody calls is not evidence.');
  console.error('  R7  (WI-40549): a measurement reported only past a `return` is not evidence.\n');
  for (const f of findings) {
    console.error(`    ${f.file}:${f.line}  [${f.rule}]`);
    console.error(`      ${f.msg}\n`);
  }
  console.error(
    `  ${findings.length} finding(s). Fix, or annotate the line with "# ${PRAGMA} <reason>"\n` +
      '  if the shape is genuinely safe here (for R6 the pragma goes on the function\'s\n' +
      '  definition line, or the comment block above it). See WI-5788 / P-411 and WI-7000.',
  );
  process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();

export {
  scan,
  scriptsInScope,
  ROOT,
  orphanedAsserts,
  segmentFunctions,
  stripShellComments,
  discardedReadings,
};
