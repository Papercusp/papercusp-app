#!/usr/bin/env node
/**
 * check-explicit-presence.mjs — the going-forward guard for the explicit-presence
 * convention (WI-5977, "Adopt explicit-presence as an enforced convention at every
 * boundary where absence is possible").
 *
 * THE INCIDENT CLASS this guards against (10 distinct incidents in one night, all one
 * shape): a layer that CANNOT tell "absent" from "measured zero" silently picks the
 * type's zero value instead of erroring or carrying its own ABSENT representation —
 * udxRelayed absent read as `relayed:false`, bytesReceived absent read as `0`,
 * lastProgressAt:null read as "abandoned", a job-runner wrapper reporting exit 0 while
 * the wrapped tsc actually exited 2. The convention (WI-5977 body):
 *   1. At any boundary where a field may be absent, absence gets its OWN
 *      representation — never the type's zero value. Absent != false, != 0.
 *   2. A reader that cannot distinguish absent from measured must ERROR, not choose.
 *
 * This lint is the MECHANICAL half WI-5977 asked for and explicitly deferred (only the
 * canary — gate-canary-sweep-action.ts — landed in that item; this is the remainder,
 * tracked as WI-6004).
 *
 * SCOPE (a heuristic, like check-generic-first.mjs — advisory, not a type checker):
 * flag a `??`/`||` defaulted-to-a-zero-value read (`?? false`, `?? 0`, `?? ''`, `?? []`,
 * `?? {}` and the `||` spellings) whose LHS is LOCALLY traceable to a parse/deserialize
 * boundary: a direct `JSON.parse(...).field` chain; a member access on a variable this
 * same file visibly assigned from `JSON.parse(...)` or a `sql`-tagged query within the
 * last ~40 lines; or a `payload.field` / `event.data.field` read in a file with an IPC/
 * `.on('message')` handler. LOCALITY is the precision filter (mirrors check-generic-
 * first's "structural decoupling alone is too noisy" lesson) — a whole-FILE gate
 * ("this file mentions JSON.parse somewhere") was tried first and measured 1264 hits on
 * this tree, mostly unrelated `opts.foo ?? 0` reads hundreds of lines from the nearest
 * JSON.parse call. A bare `x.foo ?? false` for an untracked `x` is extremely common and
 * mostly fine — it's only suspicious when the read is actually reachable to a boundary
 * where the RHS could be genuinely absent rather than deliberately falsy/zero.
 *
 * KNOWN LIMITATION (v1): only the `??`/`||` operator form is checked. A destructuring
 * default (`const { foo = false } = JSON.parse(x)`) is the same anti-pattern but isn't
 * matched yet — same class as check-generic-first's documented false-negative tradeoff:
 * acceptable for an advisory lint, worth widening if it proves to matter.
 *
 *   node scripts/check-explicit-presence.mjs             # report candidates in this change (informational)
 *   node scripts/check-explicit-presence.mjs --all        # scan the whole tree
 *   node scripts/check-explicit-presence.mjs --strict     # exit 1 if any unallow-listed candidate
 *   node scripts/check-explicit-presence.mjs --ratchet    # GATE: whole tree, fail iff the count ROSE above baseline
 *   node scripts/check-explicit-presence.mjs --ratchet --positive-control  # prove the real gate can turn red
 *   node scripts/check-explicit-presence.mjs --ratchet --update   # lower the baseline to the current count
 *   node scripts/check-explicit-presence.mjs --self-test  # verify the analyzer on inline fixtures
 *
 * Informational by default (like lint:generic-first) — a heuristic, so it advises
 * rather than blocks. A field that is genuinely always-present, or whose zero value IS
 * the correct default, is a false positive: add an `{ at: 'path:line', code: '<the line>' }`
 * entry to ALLOW below.
 *
 * WHY `--ratchet` EXISTS, AND WHY IT IS THE MODE THAT GETS WIRED (WI-5977, 2026-08-13).
 * WI-5977's own thesis is that "a convention nobody enforces decays into advice", and
 * until this mode existed that is exactly what had happened: this guard ran on NO
 * blocking path and sat in ACKNOWLEDGED_UNREACHABLE (check-lint-guard-reachability.mjs)
 * as "logic-test only". Two constraints shaped the fix:
 *   - `--strict` is NOT reachable today. Measured 2026-08-13: 55 unallowlisted candidates
 *     tree-wide, ALLOW empty. Wiring a permanently-red leg teaches the fleet to ignore it.
 *   - the DIFF-scoped default mode is VACUITY-PRONE in a gate: with no diff base it prints
 *     "nothing new to check" and exits 0 having scanned NOTHING — a verifier that reports
 *     success without measuring, which is the very defect class this file guards against.
 * So the wired mode scans the WHOLE tree (deterministic, never vacuous) and gates on the
 * COUNT rising. The baseline is ratchet-only-down and lives in a file, mirroring the
 * proven sibling convention in check-mock-cast-escape.mjs / .mock-cast-escape-baseline.json
 * rather than inventing a second one. Cost is stated where it is paid: ~13.5s whole-tree
 * (measured, 2 runs), which is why the REPO_WIDE_INVARIANT_GUARDS registration in
 * scripts/affected-tests.mjs keys on the analyzer's own SCAN_ROOTS and nothing wider.
 *
 * A REJECTED OPTIMIZATION, recorded so it is not re-attempted blind: pre-filtering each
 * file on `text.includes('JSON.parse') || …` before the per-line lookback would cut most
 * of that 13.5s, and every detection path does structurally require one of those markers.
 * It was still declined — a prefilter derived by hand from the detection regexes silently
 * stops matching the day someone edits a regex without it, and the failure mode is a
 * guard that reports a clean tree because it scanned less of it. That is precisely the
 * "absence read as a measurement" shape this file exists to catch, and EI-20080351414486996
 * already recorded one count regression here that only reading the drop caught.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listTrackedFiles, describeUnscanned } from "./lib/tracked-files.mjs";
import { stripCommentsOnly } from "./lib/strip-comments-and-strings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_ROOTS = [
  "packages/operator-core/lib/",
  "apps/operator/lib/",
  "libs/papercusp/",
];

/**
 * The ratchet's stored high-water mark. Shape + semantics mirror .mock-cast-escape-baseline.json.
 *
 * `EXPLICIT_PRESENCE_BASELINE_FILE` overrides the path so tests can exercise baseline parsing and
 * decisions without touching the shared tree. It is NOT the end-to-end positive control: once the
 * real corpus reached zero candidates, a temporary baseline of zero became vacuous and returned
 * green. Use `--ratchet --positive-control` instead. That mode reads the real baseline, runs the
 * real analyzer, then evaluates an isolated analyzer-produced candidate set at exactly baseline
 * + 1. It refuses `--update`, writes nothing, and therefore remains a safe, falsifiable control
 * even when the production corpus is perfectly clean or concurrently changing.
 */
const BASELINE_FILE =
  process.env.EXPLICIT_PRESENCE_BASELINE_FILE ||
  join(ROOT, ".explicit-presence-baseline.json");

/**
 * Read the stored baseline count. THROWS rather than defaulting — a baseline that cannot
 * be read is UNKNOWN, and this file of all files may not answer "unknown" with a zero:
 * `?? 0` here would turn a missing/corrupt baseline into "the tree must have zero
 * candidates", which fails every run for a reason that has nothing to do with the tree,
 * while `?? Infinity` would pass every run and guard nothing. Both are the absent-read-as-
 * measured defect this script exists to catch, so the caller is made to handle it.
 */
export function readBaseline(file = BASELINE_FILE) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isInteger(json.count) || json.count < 0) {
    throw new Error(
      `baseline file ${file} has no non-negative integer \`count\` — refusing to guess one`,
    );
  }
  return json.count;
}

function writeBaseline(count, file = BASELINE_FILE) {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        count,
        _comment:
          "RATCHET-ONLY-DOWN (see scripts/check-explicit-presence.mjs). This is the count of " +
          "zero-value-defaulted parse/deserialize-boundary reads WI-5977 has not yet burned down. " +
          "Lowering it happens with --ratchet --update on a quiet tree; RAISING it is a deliberate " +
          "hand-edit that needs a stated justification, never a silent bump.",
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * The ratchet decision, pure so it is testable without a tree scan.
 * Deliberately asymmetric, exactly like check-mock-cast-escape.mjs's: a count UNDER the
 * baseline passes but does NOT silently lock in (a transient drop — a file mid-refactor,
 * a scan root temporarily unreadable — would otherwise ratchet the baseline down to a
 * number the tree cannot actually hold, and every later run would fail for it).
 */
export function decideRatchet({ count, baselineCount, updateFlag = false }) {
  if (count > baselineCount)
    return { verdict: "fail-exceeds", by: count - baselineCount };
  if (count < baselineCount) {
    return updateFlag
      ? {
          verdict: "ok-ratchet",
          newBaseline: count,
          belowBy: baselineCount - count,
        }
      : { verdict: "ok-below", belowBy: baselineCount - count };
  }
  return { verdict: "ok-at" };
}

/**
 * False positives — the zero value IS the correct default here (a genuine config default,
 * not a parse/deserialize boundary reading absence as zero), or the field is structurally
 * guaranteed present. Curate as real ones surface.
 *
 * Each entry is `{ at: 'path:line', code: '<the source line, trimmed>' }`. BOTH halves are
 * load-bearing, and which one is authoritative is the point:
 *
 *   * `code` is the IDENTITY. An entry is matched to a candidate by content, so an edit
 *     ANYWHERE ABOVE it — which re-points `at` at a different line without touching the code
 *     — no longer un-suppresses the violation it was hiding. That un-suppression is what used
 *     to raise the candidate count and RED THE GATE on drift, contradicting this guard's own
 *     stated intent that a drifted entry must stay advisory (EI-20609643000161171: observed
 *     twice in one morning on coord-invariant-actions.ts, 1410 → 1470 → 1527, each a
 *     fleet-wide red landing on whoever ran the gate next rather than on the editor).
 *   * `at` is the ANCHOR: it is what a human reads to find the line, and it disambiguates
 *     when several identical lines share one file (the nearest unclaimed one wins). It is
 *     allowed to go stale — a drifted `at` is reported, never fatal.
 *
 * Matching is strictly ONE-TO-ONE per file (see `applyAllowlist`), which is what makes
 * content-keying safe: N identical lines with M entries suppress exactly min(N, M), so
 * adding a genuinely new copy of an already-allowed line still raises the count and still
 * reds the ratchet. An entry can never suppress more than the one violation it was written
 * for, however unremarkable its `code` looks.
 */
const ALLOW = [
  // ── postgres.js RESULT-ARRAY `.count`, not a row column ────────────────────────────────
  // Every one of these is `<result>.count` on the object postgres.js returns from a
  // DELETE/UPDATE — the driver's affected-row count, which it populates on every command.
  // The analyzer sees `x.count ?? 0` on a variable assigned from a sql`` template and cannot
  // tell that apart from `rows[0].count` (a real, NULLable column read). The `?? 0` here is
  // a no-op, and the zero it would produce is the honest "nothing matched".
  {
    at: "packages/operator-core/lib/blueprint/commit-reproject-real.ts:110",
    code: "return { ...res, proposalMarked: (updated.count ?? 0) > 0 };",
  },
  {
    at: "packages/operator-core/lib/harness/routines/coord-invariant-actions.ts:1527",
    code: "const n = del.count ?? 0;",
  },
  {
    at: "packages/operator-core/lib/search/session-ingest.ts:1969",
    code: "deleted += r.count ?? 0;",
  },
  {
    at: "packages/operator-core/lib/search/session-ingest.ts:1970",
    code: "if ((r.count ?? 0) < 5000) break;",
  },
  {
    at: "packages/operator-core/lib/search/session-ingest.ts:2001",
    code: "partsDeleted += r.count ?? 0;",
  },
  {
    at: "packages/operator-core/lib/search/session-ingest.ts:2002",
    code: "if ((r.count ?? 0) < 5000) break;",
  },
  {
    at: "packages/operator-core/lib/steering-churn.ts:316",
    code: "return deleted.count ?? 0;",
  },
  {
    at: "packages/operator-core/lib/sync/hyperbee/coord-quarantine-store.ts:139",
    code: "return { cleared: rows.count ?? 0 };",
  },

  // ── absence IS the encoder's representation of empty ───────────────────────────────────
  // encodeSessionCursor (same file, ~line 90) OMITS `bounds` when it is empty:
  // `...(bounds && Object.keys(bounds).length > 0 ? { bounds } : {})`. So an absent `bounds`
  // does not mean "unknown" here — it is how this codec spells "no bounds".
  {
    at: "packages/operator-core/lib/agent-tools/sessions/cursor.ts:103",
    code: "const bounds = payload.bounds ?? {};",
  },
  // `!Number.isInteger(payload.offset)` earlier in the SAME `||` disjunction already rejects
  // an absent offset, so this arm is unreachable for absence. (Its sibling on the preceding
  // line uses the correct `?? -1` sentinel; only the reachability argument saves this one.)
  {
    at: "packages/operator-core/lib/agent-tools/sessions/cursor.ts:119",
    code: "(payload.offset ?? 0) > MAX_CURSOR_OFFSET",
  },

  // ── schema-verified: the column cannot be absent, or NULL and {} are indistinguishable ──
  // harness_shared.routines.trigger_config is NOT NULL (information_schema, 2026-08-13).
  {
    at: "packages/operator-core/lib/plugin-host.ts:246",
    code: "triggerConfig: rows[0].trigger_config ?? {},",
  },
  // payload_template IS nullable, but it is immediately spread into a merge — `{...null}` and
  // `{...{}}` produce the identical object, so no reader can distinguish the two outcomes.
  {
    at: "packages/operator-core/lib/plugin-host.ts:248",
    code: "payloadTemplate: { ...(rows[0].payload_template ?? {}), ...(payload ?? {}) },",
  },

  // ── the zero is a declared sentinel the no-data branch already uses ────────────────────
  // A high-water mark: the surrounding expression is `hwmRows.length ? Number(...) : 0`, so 0
  // is this function's stated "no HWM yet" value; a NULL mtime_ms means the same thing and
  // errs toward re-ingesting, never toward skipping.
  {
    at: "packages/operator-core/lib/search/session-ingest.ts:1864",
    code: "const hwm = hwmRows.length ? Number(hwmRows[0].mtime_ms ?? 0) : 0;",
  },

  // ── the file-absent branch above already yields exactly this empty value ───────────────
  // Each of these reads an optional list/map out of a config or state file whose enclosing
  // function ALREADY returns the same empty value when the file does not exist. An absent key
  // and an empty collection therefore reach every caller identically; there is no reader that
  // could act on the distinction even if it were preserved.
  {
    at: "packages/operator-core/lib/plugin-grants.ts:45",
    code: "const grants = parsed.grants ?? {};",
  },
  {
    at: "packages/operator-core/lib/endpoint-route/routes/harness/testing.ts:67",
    code: "return (JSON.parse(raw).tests ?? []) as HarnessTestRow[];",
  },
  {
    at: "packages/operator-core/lib/endpoint-route/routes/harness/tests.ts:67",
    code: "return parsed.tests ?? [];",
  },
  {
    at: "packages/operator-core/lib/endpoint-route/routes/harness/runs.ts:106",
    code: "const lanes = (manifest.lanes ?? []).map((lane: any) => {",
  },
  {
    at: "packages/operator-core/lib/sync-resolver/index.ts:1671",
    code: "for (const l of raw.lanes ?? []) {",
  },
  {
    at: "libs/papercusp/packages/cli/src/snapshot-cli.ts:663",
    code: "const fields = Object.entries(shape.fields ?? {});",
  },

  // ── absence resolves in the CONSERVATIVE direction ─────────────────────────────────────
  // An ollama manifest with no `layers` finds no model layer, so the loop `continue`s to the
  // next root and ultimately reports needsDownload — the same outcome the adjacent catch gives
  // a malformed manifest. Absence can only cause a redundant download, never a false hit.
  {
    at: "packages/operator-core/lib/provisioner/weights.ts:96",
    code: "const layer = (manifest.layers ?? []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');",
  },

  // ── free-text field where empty and absent carry the same meaning ──────────────────────
  // The auditor's `reasons` is prose shown to a human; the VERDICT it explains is validated
  // separately on the line above and a missing verdict returns null. "No reason given" is
  // what both an absent and an empty `reasons` mean.
  {
    at: "libs/papercusp/packages/orchestrator/src/auditor-dispatch.ts:233",
    code: "const reasons = typeof obj.reasons === 'string' ? obj.reasons : String(obj.reasons ?? '');",
  },
];

/**
 * Whitespace-insensitive content key. Indentation and inter-token spacing move under an
 * entry for reasons that have nothing to do with the suppression's validity (a reformat, a
 * block re-indented by an enclosing `if`), and treating those as a different line would
 * reintroduce the same false un-suppression by a slower route.
 */
function codeKey(s) {
  return String(s).trim().replace(/\s+/g, " ");
}

/**
 * Resolve ALLOW entries against measured candidates, per file, ONE-TO-ONE.
 *
 * Pure and exported so the properties below are testable without a tree scan.
 *
 *   1. EXACT: an entry whose `at` line still holds a candidate consumes it. Unchanged from
 *      the original line-keyed behavior; the overwhelmingly common case.
 *   2. DRIFTED: a leftover entry consumes the nearest remaining candidate IN THE SAME FILE
 *      whose content matches its `code`. Reported, never fatal.
 *   3. UNMATCHED: nothing matched — the code was fixed or deleted. Reported, never fatal;
 *      the count simply falls below baseline, which the ratchet already handles.
 *
 * A candidate is consumed at most once and an entry consumes at most one candidate, so the
 * suppressed TOTAL is min(entries, matching candidates) regardless of which of several
 * identical lines pass 2 happens to pick. That is what closes the over-suppression hole a
 * content-keyed allowlist would otherwise open: a newly-added duplicate of an already-allowed
 * line is still counted, still raises the ratchet, and is still reported.
 *
 * Residual, stated rather than hidden: if the one allowed line is DELETED and a genuinely new
 * violation with byte-identical content appears in the SAME file, the entry suppresses the new
 * one. That window existed before this change too (the new line had only to land on the
 * allowed line number), it is narrower now, and every re-point is printed.
 */
export function applyAllowlist({ allow, hitsByFile }) {
  const candidates = [];
  const drifted = [];
  const unmatched = [];

  const entriesByFile = new Map();
  for (const entry of allow) {
    const i = entry.at.lastIndexOf(":");
    const path = entry.at.slice(0, i);
    const line = Number(entry.at.slice(i + 1));
    if (!entriesByFile.has(path)) entriesByFile.set(path, []);
    entriesByFile.get(path).push({ ...entry, path, line });
  }

  for (const [path, hits] of hitsByFile) {
    const entries = entriesByFile.get(path) ?? [];
    const claimed = new Set();
    const leftover = [];

    for (const entry of entries) {
      const exact = hits.findIndex(
        (h, idx) => !claimed.has(idx) && h.line === entry.line,
      );
      if (exact >= 0) claimed.add(exact);
      else leftover.push(entry);
    }

    for (const entry of leftover) {
      const want = codeKey(entry.code ?? "");
      let best = -1;
      if (want) {
        for (let idx = 0; idx < hits.length; idx++) {
          if (claimed.has(idx) || codeKey(hits[idx].snippet) !== want) continue;
          if (
            best < 0 ||
            Math.abs(hits[idx].line - entry.line) <
              Math.abs(hits[best].line - entry.line)
          )
            best = idx;
        }
      }
      if (best >= 0) {
        claimed.add(best);
        drifted.push({
          at: entry.at,
          resolvedLine: hits[best].line,
          code: entry.code,
        });
      } else {
        unmatched.push(entry.at);
      }
    }

    hits.forEach((h, idx) => {
      if (!claimed.has(idx)) candidates.push({ f: path, ...h });
    });
  }

  // Entries naming a file the scan never opened are NOT stale — a diff-scoped run legitimately
  // touches almost none of them. Only `--all` callers pass every file an entry could name.
  const scannedFiles = new Set(hitsByFile.keys());
  for (const [path, entries] of entriesByFile) {
    if (!scannedFiles.has(path)) for (const e of entries) unmatched.push(e.at);
  }

  return { candidates, drifted, unmatched };
}

// v1 (whole-file "does this file mention JSON.parse anywhere" gate) was tried first and
// measured 1264 hits on this tree — cry-wolf, the exact failure check-generic-first.mjs's
// own header warns about ("structural decoupling alone is far too noisy... require BOTH").
// A 1000-line file that happens to JSON.parse a config once does not make every unrelated
// `opts.foo ?? 0` on line 900 a boundary read. Precision comes from LOCALITY instead of
// file-wide presence: the risky access must be either a DIRECT chain off JSON.parse(...),
// or a member access on a variable this same file visibly assigned FROM JSON.parse(...) /
// a `sql` tagged-template result within a nearby lookback window (still in the same
// function-ish vicinity, not merely "somewhere earlier in a 1000-line file).

/**
 * Test sources, which never ship. The `[.-]` before `test|spec` is load-bearing: this repo
 * has TWO test naming conventions and the original `\.(test|spec)\.ts$` only knew one.
 * `libs/papercusp/packages/cli` runs `node --test src/**\/*.node-test.ts` (11 files, declared
 * in its own package.json `test` script), whose separator is a HYPHEN — so every one of them
 * was scanned as production code, and two of its fixture-cleanup reads sat on the baseline.
 */
const TEST_FILE_RE = /[.-](test|integration\.test|spec)\.ts$/;

/**
 * RETIRED code is out of scope, matching what ~12 sibling guards already do
 * (check-constant-conditional, check-no-raw-agent-spawn, check-js-syntax, affected-tests,
 * check-declared-consumed's "retired code is not a consumer", …). This guard's SCAN_ROOTS
 * names `libs/papercusp/` wholesale and so picked up `libs/papercusp/_retired/`, which is
 * WORSE than noise here: repo convention is that retired surfaces are "not deleted, not
 * deployed, not tested, NOT TO BE EXTENDED", so those rows were permanently unfixable —
 * the only two dispositions a candidate has (fix it / allow it) were both closed, and 12
 * of them were pinning the baseline where no burn-down could ever reach them.
 */
const RETIRED_RE = /(^|\/)_retired\//;

const ZERO = "(false|0|''|\"\"|\\[\\]|\\{\\})";
const OP = "(\\?\\?|\\|\\|)";
/** How many preceding lines a tracked-variable assignment stays "in scope" for — generous
 *  enough to span a function body, narrow enough not to bleed across unrelated code. */
const LOOKBACK_LINES = 40;

/** `const/let/var x = JSON.parse(...)` — tracks x as a parsed-boundary variable. */
const ASSIGN_FROM_JSON_PARSE_RE =
  /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?JSON\.parse\(/;
/** `const/let/var x = [await] sql<...>\`...\`` / `sql\`...\`` — this codebase's postgres.js
 *  tagged-template convention (see agent-facts/store.ts) — tracks x as a DB-row variable. */
const ASSIGN_FROM_SQL_ROW_RE =
  /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?sql\s*[<`]/;

/** Direct chain: `JSON.parse(<balanced-ish args>).field ?? zero` on one line — the exact
 *  udxRelayed/bytesReceived incident shape. Handles one level of nested parens in the args
 *  (covers the common `JSON.parse(x.toString())` shape) without a full parser. */
const DIRECT_JSON_PARSE_CHAIN_RE = new RegExp(
  `JSON\\.parse\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.\\s*\\w+\\s*${OP}\\s*${ZERO}`,
);

/** A member access on a bare identifier (optionally `name[0]`/`name['k']`), defaulted via
 *  `??`/`||` to a zero value — checked against the tracked-variable maps below, never used
 *  standalone (a bare `x.foo ?? false` for an UNtracked `x` is far too generic to flag). */
const TRACKED_MEMBER_RISKY_RE = new RegExp(
  `\\b(\\w+)(?:\\[(?:\\d+|['"][^'"]+['"])\\])?\\s*\\.\\s*\\w+\\s*${OP}\\s*${ZERO}`,
);

/** IPC/event-payload marker — kept file-level (rarer + lower-noise than JSON.parse/sql, so
 *  the whole-file gate the other two boundaries dropped is still an acceptable signal here). */
const IPC_MARKER_RE =
  /ipcRenderer\.on\(|ipcMain\.on\(|\.on\(\s*['"]message['"]/;
/** `payload.field ?? zero` / `event.data.field ?? zero` — the two conventional payload names. */
const IPC_PAYLOAD_RISKY_RE = new RegExp(
  `\\b(?:payload|event\\.data)\\s*\\.\\s*\\w+\\s*${OP}\\s*${ZERO}`,
);

function lineIsExcluded(line) {
  return /^\s*\/\//.test(line) || /^\s*\*/.test(line); // comments
}

/**
 * Analyze one file's text. Returns an array of { line, snippet, reason } candidates.
 * Single forward pass, tracking parsed/row variables as it goes (a variable's tracked
 * scope is the LOOKBACK_LINES window following its assignment — reassignment to something
 * else simply overwrites the tracked line, which is what we want). PURE — no IO,
 * unit-tested inline via selfTest().
 */
export function analyzeForExplicitPresence({ path, text }) {
  if (TEST_FILE_RE.test(path)) return [];
  if (path.endsWith(".d.ts")) return [];
  if (RETIRED_RE.test(path)) return [];

  // COMMENTS ARE MASKED; STRINGS ARE DELIBERATELY NOT. Both halves are measured, and the
  // asymmetry is the whole point (2026-08-10, WI-37717):
  //
  //   * Comments must go. `lineIsExcluded` below only skips a line whose FIRST character is
  //     `//` or `*`, and the two tracked-variable assignment regexes run BEFORE that check —
  //     so `// const payload = JSON.parse(x)` registered `payload` as a parsed-boundary
  //     variable and then flagged an unrelated REAL line further down. That phantom is the
  //     worst shape there is: the reported line is genuine code, so triage looks legitimate
  //     and the bogus tracking that caused it is invisible at the reported location.
  //
  //   * Strings must STAY. This guard's corpus deliberately includes source that lives inside
  //     template literals — `admin-test-suites.ts` builds a runner script that really does
  //     `JSON.parse(...)` then reads `payload.n || 0`, and that generated code carries the
  //     exact incident risk this guard exists to catch. Measured over 3,934 tracked .ts/.tsx
  //     files: stripCommentsOnly changes the corpus verdict by NOTHING (62 -> 62, zero drops,
  //     zero adds) while stripCommentsAndStrings drops 8 rows, ALL of them real embedded
  //     code in that one file and NOT ONE of them a phantom. So the full stripper — the
  //     reflexive "migrate it to the shared masker" fix — is a net REGRESSION here.
  //
  // Consequence, stated so nobody "fixes" it later: this guard cannot pass
  // probeStringLiteralBlindness, whose string-literal and template-literal cases are exactly
  // the behaviour above. Its SCANS_UNMASKED_SOURCE entry is ACCURATE and intentional.
  //
  // stripCommentsOnly blanks with spaces rather than deleting, so it is length-preserving and
  // every line index below still addresses the raw text — which is why `rawLines` can supply
  // the snippet while detection runs on the masked copy.
  const rawLines = text.split("\n");
  const maskedText = stripCommentsOnly(text, path);
  const lines = maskedText.split("\n");
  const hasIpcMarker = IPC_MARKER_RE.test(maskedText);
  const parsedVars = new Map(); // name -> assignment line index
  const sqlRowVars = new Map();
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = ASSIGN_FROM_JSON_PARSE_RE.exec(line);
    if (m) parsedVars.set(m[1], i);
    m = ASSIGN_FROM_SQL_ROW_RE.exec(line);
    if (m) sqlRowVars.set(m[1], i);

    if (lineIsExcluded(line)) continue;

    if (DIRECT_JSON_PARSE_CHAIN_RE.test(line)) {
      hits.push({
        line: i + 1,
        snippet: (rawLines[i] ?? line).trim().slice(0, 160),
        reason:
          "defaults a field read directly off JSON.parse(...) to a zero value — the udxRelayed/bytesReceived incident shape (WI-5977): absence and a genuine zero/false/empty measurement read identically here.",
      });
      continue;
    }

    m = TRACKED_MEMBER_RISKY_RE.exec(line);
    if (m) {
      const varName = m[1];
      const parsedAt = parsedVars.get(varName);
      const sqlAt = sqlRowVars.get(varName);
      if (parsedAt !== undefined && i - parsedAt <= LOOKBACK_LINES) {
        hits.push({
          line: i + 1,
          snippet: (rawLines[i] ?? line).trim().slice(0, 160),
          reason: `defaults a field read on \`${varName}\` (assigned from JSON.parse at line ${parsedAt + 1}) to a zero value — absence and a genuine zero/false/empty measurement read identically here.`,
        });
        continue;
      }
      if (sqlAt !== undefined && i - sqlAt <= LOOKBACK_LINES) {
        hits.push({
          line: i + 1,
          snippet: (rawLines[i] ?? line).trim().slice(0, 160),
          reason: `defaults a field read on \`${varName}\` (a DB row, assigned from a sql-tagged query at line ${sqlAt + 1}) to a zero value — a NULL column and a genuine zero/false/empty value read identically here.`,
        });
        continue;
      }
    }

    if (hasIpcMarker && IPC_PAYLOAD_RISKY_RE.test(line)) {
      hits.push({
        line: i + 1,
        snippet: (rawLines[i] ?? line).trim().slice(0, 160),
        reason:
          "defaults an IPC/event payload field read to a zero value — a field the sender never set and a genuine zero/false/empty value read identically here.",
      });
    }
  }
  return hits;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────

function selfTest() {
  const cases = [
    {
      name: "JSON.parse boundary + ?? false → flagged (the udxRelayed incident shape)",
      expect: 1,
      path: "packages/operator-core/lib/x/a.ts",
      text: "const relayed = JSON.parse(raw).udxRelayed ?? false;\n",
    },
    {
      name: "JSON.parse boundary + ?? 0 → flagged (the bytesReceived incident shape)",
      expect: 1,
      path: "packages/operator-core/lib/x/b.ts",
      text: "const bytesReceived = JSON.parse(logLine).bytesReceived ?? 0;\n",
    },
    {
      name: "DB row (sql-tagged query result) + ?? false → flagged",
      expect: 1,
      path: "packages/operator-core/lib/x/c.ts",
      text: "const rows = await sql`select active from t`;\nconst active = rows[0].active ?? false;\n",
    },
    {
      name: "DB row var reused many lines later, still within the lookback window → flagged",
      expect: 1,
      path: "packages/operator-core/lib/x/c2.ts",
      text:
        "const row = await sql`select status from t`;\n" +
        "// pad\n".repeat(10) +
        "const status = row.status ?? false;\n",
    },
    {
      name: "DB row var reused far outside the lookback window → not flagged (unrelated to a boundary read that far away)",
      expect: 0,
      path: "packages/operator-core/lib/x/c3.ts",
      text:
        "const row = await sql`select status from t`;\n" +
        "// pad\n".repeat(60) +
        "const status = row.status ?? false;\n",
    },
    {
      name: "IPC payload handler + || 0 → flagged",
      expect: 1,
      path: "packages/operator-core/lib/x/d.ts",
      text: "ipcRenderer.on('reply', (event, payload) => {\n  const count = payload.count || 0;\n});\n",
    },
    {
      name: "NO boundary marker in file → not flagged even with the same risky shape",
      expect: 0,
      path: "packages/operator-core/lib/x/e.ts",
      text: "const debugEnabled = config.debug ?? false;\n",
    },

    // ── COMMENT-PHANTOM REGRESSIONS (WI-37717). Every one of these FIRED before comments
    // were masked. They are cheap to re-break: deleting the stripCommentsOnly call restores
    // all four, and nothing else in this suite would notice.
    {
      name: "PHANTOM: the whole risky chain sits in a line comment → not flagged",
      expect: 0,
      path: "packages/operator-core/lib/x/p1.ts",
      text: "// const n = JSON.parse(raw).count ?? 0;\n",
    },
    {
      name: "PHANTOM: risky chain in a block comment whose line starts with neither // nor *",
      expect: 0,
      path: "packages/operator-core/lib/x/p2.ts",
      text: "/* JSON.parse(raw).count ?? 0 */\n",
    },
    {
      name: "PHANTOM: risky chain in a TRAILING comment after real code → not flagged",
      expect: 0,
      path: "packages/operator-core/lib/x/p3.ts",
      text: "const ok = true; // JSON.parse(raw).count ?? 0\n",
    },
    {
      // The nastiest shape: the assignment regexes run BEFORE lineIsExcluded, so a
      // commented-out assignment poisoned the tracked-variable map and then flagged a REAL
      // line below it. The reported line is genuine code, so the phantom is invisible there.
      name: "PHANTOM: tracked var assigned ONLY inside a comment must not poison tracking",
      expect: 0,
      path: "packages/operator-core/lib/x/p4.ts",
      text: "// const parsed = JSON.parse(raw);\nconst n = parsed.count ?? 0;\n",
    },
    {
      // The deliberate NON-fix: strings stay live. admin-test-suites.ts embeds a generated
      // runner script in a template literal that carries the real incident shape; masking
      // strings would drop 8 such rows and zero phantoms. If someone "fixes" this guard with
      // stripCommentsAndStrings, THIS case is what fails.
      name: "INTENTIONAL: risky shape inside a template literal IS still flagged (generated code)",
      expect: 1,
      path: "packages/operator-core/lib/x/p5.ts",
      text: "const script = `\n  const payload = JSON.parse(line);\n  send(payload.n || 0);\n`;\n",
    },
    {
      name: "boundary present but default is a non-zero sentinel string → not flagged",
      expect: 0,
      path: "packages/operator-core/lib/x/f.ts",
      text: "const name = JSON.parse(raw).name ?? 'unknown';\n",
    },
    {
      name: "boundary present but bare local var defaulted (no field access) → not flagged",
      expect: 0,
      path: "packages/operator-core/lib/x/g.ts",
      text: "const parsed = JSON.parse(raw);\nconst x = maybeUndefined ?? false;\n",
    },
    {
      name: "explicit-presence done correctly (an `in` check, no risky default) → not flagged",
      expect: 0,
      path: "packages/operator-core/lib/x/h.ts",
      text: "const p = JSON.parse(raw);\nconst relayed = 'udxRelayed' in p ? p.udxRelayed : ABSENT;\n",
    },
    {
      name: "test file → never flagged regardless of content",
      expect: 0,
      path: "packages/operator-core/lib/x/i.test.ts",
      text: "const relayed = JSON.parse(raw).udxRelayed ?? false;\n",
    },
    {
      // The HYPHEN convention (`node --test src/**/*.node-test.ts` in packages/cli). The
      // original `\.(test|spec)\.ts$` matched only the dot form, so these read as production.
      name: "node --test file (hyphen separator) → never flagged, same as a .test.ts",
      expect: 0,
      path: "libs/papercusp/packages/cli/src/x.node-test.ts",
      text: "const parsed = JSON.parse(raw);\nconst grants = parsed.grants ?? {};\n",
    },
    {
      name: "RETIRED source → never flagged (unfixable by convention, so it can never burn down)",
      expect: 0,
      path: "libs/papercusp/_retired/apps-web/app/api/x.ts",
      text: "const obj = JSON.parse(raw);\nconst cost = obj.total_cost_usd ?? 0;\n",
    },
    {
      // Calibration for the two exclusions above: the SAME text at a LIVE path must still
      // fire. Without this, deleting either predicate's subject and leaving it always-true
      // would pass the suite while blinding the guard on the whole tree.
      name: "CALIBRATION: the exclusions above are path-only — identical text at a live path IS flagged",
      expect: 1,
      path: "libs/papercusp/packages/cli/src/x.ts",
      text: "const obj = JSON.parse(raw);\nconst cost = obj.total_cost_usd ?? 0;\n",
    },
    {
      name: "a comment line matching the shape → not flagged",
      expect: 0,
      path: "packages/operator-core/lib/x/j.ts",
      text: "import postgres from 'postgres';\n// const active = row.active ?? false; (old approach, kept for reference)\n",
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = analyzeForExplicitPresence({
      path: c.path,
      text: c.text,
    }).length;
    const ok = got === c.expect;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${c.name}${ok ? "" : ` (expected ${c.expect} hit(s), got ${got})`}`,
    );
  }
  if (failed) {
    console.error(`\n✗ self-test: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log("\n✓ self-test: analyzer correct on all fixtures.");
  process.exit(0);
}

// ── main ──────────────────────────────────────────────────────────────────────────────

function git(args) {
  const r = execSync(`git ${args}`, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.split("\n").filter(Boolean);
}

/** Mirrors check-generic-first.mjs's changedFiles: committed-since-base + uncommitted. */
function changedFiles(base) {
  let committed = [];
  try {
    git(`rev-parse --verify --quiet ${base}`);
    committed = git(
      `diff --no-renames --diff-filter=AM --name-only ${base}...HEAD`,
    );
  } catch {
    committed = null;
  }
  let uncommitted = [];
  try {
    uncommitted = git("diff --no-renames --diff-filter=AM --name-only HEAD");
  } catch {
    /* no HEAD */
  }
  if (committed === null && uncommitted.length === 0) return null;
  return [...new Set([...(committed ?? []), ...uncommitted])];
}

/**
 * The `--ratchet` verdict. Prints the count it MEASURED on every path, pass or fail —
 * a gate leg whose green says nothing about what it looked at is unfalsifiable from the
 * outside, and the real-tree test in packages/operator-core/lib/__tests__/
 * check-explicit-presence.test.ts parses this line to assert the scan was non-vacuous.
 */
function reportRatchet({ candidates, unscanned, updateFlag, positiveControl }) {
  const baselineCount = readBaseline();
  let measuredCandidates = candidates;
  if (positiveControl) {
    const fixturePath =
      "packages/operator-core/lib/__explicit-presence-positive-control__.ts";
    const fixtureHits = analyzeForExplicitPresence({
      path: fixturePath,
      text: "const parsed = JSON.parse(raw);\nconst measured = parsed.count ?? 0;\n",
    });
    if (fixtureHits.length !== 1) {
      throw new Error(
        `positive-control fixture produced ${fixtureHits.length} hits instead of 1 — refusing to report a synthetic verdict`,
      );
    }
    const injectedCount = baselineCount + 1;
    measuredCandidates = Array.from({ length: injectedCount }, (_, i) => ({
      f: `${fixturePath}#${i + 1}`,
      ...fixtureHits[0],
    }));
    console.error(
      `POSITIVE CONTROL: evaluating ${injectedCount} analyzer-produced known violation(s); ` +
        `the real ratchet MUST exit red at exactly baseline + 1 ` +
        `(real candidates measured separately=${candidates.length}).`,
    );
  }
  const count = measuredCandidates.length;
  const decision = decideRatchet({ count, baselineCount, updateFlag });
  const measured = `measured ${count} candidate(s) against baseline ${baselineCount}`;

  if (decision.verdict === "fail-exceeds") {
    console.error(
      `✗ explicit-presence: count ROSE above baseline — ${measured} (+${decision.by}).${describeUnscanned(unscanned)}`,
    );
    console.error(
      "  WI-5977: absence needs its OWN representation at a parse/deserialize boundary —",
    );
    console.error(
      "  never the type's zero value, because a NULL/missing field and a genuine 0/false/empty",
    );
    console.error(
      "  then read identically. Fix the NEW read (an `in` check, an explicit `present:` field, or",
    );
    console.error(
      "  erroring when the two cannot be told apart), or — if the zero value is genuinely the",
    );
    console.error(
      "  correct default there — add an `{ at: 'path:line', code: '<the line>' }` entry to ALLOW",
    );
    console.error(
      "  in this script with that reason. `code` is the identity; `at` may later drift harmlessly.\n",
    );
    for (const c of measuredCandidates)
      console.error(
        `    ${c.f}:${c.line}\n        ${c.snippet}\n        ${c.reason}`,
      );
    console.error(
      `\n  Raising the baseline is a deliberate hand-edit with a justification, never a silent bump.`,
    );
    process.exit(1);
  }

  if (decision.verdict === "ok-ratchet") {
    writeBaseline(decision.newBaseline);
    console.log(
      `✓ explicit-presence: baseline lowered ${baselineCount} → ${count} (--update).${describeUnscanned(unscanned)}`,
    );
    process.exit(0);
  }

  if (decision.verdict === "ok-below") {
    console.log(
      `✓ explicit-presence: ${decision.belowBy} under baseline — ${measured}. NOT locked in; run ` +
        "`node scripts/check-explicit-presence.mjs --ratchet --update` on a quiet tree to lower it deliberately." +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }

  if (updateFlag)
    console.log("✓ --update: count equals baseline — nothing to lower.");
  console.log(
    `✓ explicit-presence: at baseline — ${measured}.${describeUnscanned(unscanned)}`,
  );
  process.exit(0);
}

function main() {
  const strict = process.argv.includes("--strict");
  const ratchet = process.argv.includes("--ratchet");
  const updateFlag = process.argv.includes("--update");
  const positiveControl = process.argv.includes("--positive-control");
  if (positiveControl && !ratchet) {
    console.error(
      "✗ --positive-control requires --ratchet (it proves the wired ratchet verdict path).",
    );
    process.exit(2);
  }
  if (positiveControl && updateFlag) {
    console.error(
      "✗ --positive-control refuses --update — a synthetic violation must never rewrite the baseline.",
    );
    process.exit(2);
  }
  // `--ratchet` gates on the WHOLE tree: the diff-scoped mode can legitimately scan zero
  // files, and a gate that reports success without measuring is the defect class above.
  const all = process.argv.includes("--all") || ratchet;
  if (process.argv.includes("--self-test")) return selfTest();

  let files;
  let unscanned = [];
  if (all) {
    // WI-6666: SCAN_ROOTS explicitly names `libs/papercusp/`, but plain `git ls-files`
    // (this branch, historically) STOPS AT THE SUPERPROJECT BOUNDARY — libs/papercusp
    // is a submodule, so that root matched ZERO files no matter what it contained.
    // `listTrackedFiles` recurses into submodules so `--all` can finally see it.
    ({ files, unscanned } = listTrackedFiles(ROOT));
  } else {
    const baseArg = process.argv.indexOf("--base");
    const base =
      baseArg >= 0
        ? process.argv[baseArg + 1]
        : process.env.AFFECTED_BASE || "origin/main";
    const changed = changedFiles(base);
    if (changed === null) {
      console.log(
        "✓ explicit-presence: no diff base (origin/main) and no working-tree changes — nothing new to check.",
      );
      process.exit(0);
    }
    files = changed;
  }
  files = files.filter(
    (f) => SCAN_ROOTS.some((r) => f.startsWith(r)) && f.endsWith(".ts"),
  );

  const hitsByFile = new Map();
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    hitsByFile.set(f, analyzeForExplicitPresence({ path: f, text }));
  }
  const { candidates, drifted, unmatched } = applyAllowlist({
    allow: ALLOW,
    hitsByFile,
  });

  // Both reports below are ADVISORY BY CONSTRUCTION, and that is the whole contract: a drifted
  // or dead ALLOW entry names bookkeeping to tidy, never a NEW boundary read, so neither may
  // reach the exit code. Before content-keying (EI-20609643000161171) that promise was made in
  // a comment and broken by the ratchet leg, because drift un-suppressed the violation and the
  // count rose. Now drift changes nothing the ratchet can see.
  if (all && drifted.length > 0) {
    console.error(
      `⚠ explicit-presence: ${drifted.length} ALLOW entr(ies) DRIFTED — matched by content at a new line.\n` +
        "  Suppression held (the reason is still true); re-point `at` when convenient:",
    );
    for (const d of drifted)
      console.error(`    ${d.at}  →  :${d.resolvedLine}`);
    console.error("");
  }

  // An entry that suppresses nothing is this guard's own subject one level up: a suppression
  // believed to be doing work while it measures nothing. Only meaningful under `--all`, which
  // scans every file an entry could name (a diff-scoped run legitimately touches almost none).
  if (all && unmatched.length > 0) {
    console.error(
      `⚠ explicit-presence: ${unmatched.length} ALLOW entr(ies) matched NO candidate by line OR content —\n` +
        "  the code was fixed or deleted. Delete them; a suppression that suppresses nothing hides the next hit:",
    );
    for (const k of unmatched) console.error(`    ${k}`);
    console.error("");
  }

  if (ratchet)
    return reportRatchet({
      candidates,
      unscanned,
      updateFlag,
      positiveControl,
    });

  const scope = all ? "the app tree" : "this change";
  if (candidates.length === 0) {
    console.log(
      `✓ explicit-presence: no zero-value-defaulted parse/deserialize-boundary reads in ${scope} — convention intact.` +
        (all ? describeUnscanned(unscanned) : ""),
    );
    process.exit(0);
  }

  const header = strict
    ? "✗ explicit-presence"
    : "⚠ explicit-presence (advisory)";
  console.error(
    `${header}: ${candidates.length} boundary read(s) in ${scope} default absence to a zero value.`,
  );
  console.error(
    "  WI-5977: at a boundary where a field may be absent, absence needs its OWN representation —",
  );
  console.error(
    "  never the type's zero value (absent != false, != 0). A reader that cannot tell the two apart",
  );
  console.error(
    "  must error, not silently choose. These are *candidates*, not certainties: for a field that is",
  );
  console.error(
    '  genuinely always-present, or whose zero value is a deliberate default (not "unknown"), add its',
  );
  console.error(
    "  `{ at: 'path:line', code: '<the line>' }` entry to ALLOW in scripts/check-explicit-presence.mjs.\n",
  );
  for (const c of candidates)
    console.error(
      `    ${c.f}:${c.line}\n        ${c.snippet}\n        ${c.reason}`,
    );
  process.exit(strict ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
