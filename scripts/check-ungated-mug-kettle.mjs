#!/usr/bin/env node
/**
 * lint:no-ungated-mug-kettle — the RECURRENCE GUARD for the mug/kettle/cup retirement.
 * plan `retire-mug-kettle-su-only-2026-08-09` · P-016, seeded from P-005's census.
 *
 * WHAT IT FAILS ON:
 *   1. a NEW mug/kettle/cup entry point that is not behind the MUG_KETTLE_SYSTEM
 *      gate. This family is a shrink-only ratchet over a reviewed baseline.
 *   2. CURRENT agentic template or su-prompt guidance that recommends Queen/Mug/
 *      Kettle execution. This family has NO baseline: explicitly historical,
 *      retirement, and refusal prose is allowed; active prescriptions are not.
 *
 * ── TWO DETECTOR FAMILIES, AND WHY THE SECOND ONE EXISTS ──────────────────────
 *
 * (A) THE CENSUS (`scripts/mug-kettle-surface-census.mjs --json`). Re-used, not
 *     re-implemented: it owns 8 detectors (system-action, spawn-role, blueprint-launch,
 *     tool, flag, prompt, ui, wake) and this guard shells out to it so there is exactly
 *     ONE implementation of them. It runs in ~3s.
 *
 * (B) ROLE-PARAMETERIZED DOORS — added HERE because the census structurally cannot
 *     see them, and the gap is not academic. MEASURED 2026-08-10 against the live
 *     census output: it returns **0 findings** for BOTH
 *       · `endpoint-route/routes/agent-mcp/bootstrap-role.ts`  (the console door, D-022)
 *       · `endpoint-route/routes/harness/spawn.ts`             (the spawn door,   D-018)
 *     i.e. for 2 of the 3 spawn doors this plan gated. It sees `fleet/operator-spawn.ts`
 *     ONLY because that file happens to contain literal `role: 'cup'` strings.
 *
 *     The reason is structural: every census detector keys on the role NAME appearing
 *     as a literal in source. In these doors the role arrives as DATA — `body.role`,
 *     `url.searchParams.get('role')` — so there is no literal to match, and a scan that
 *     looks for one is blind to the entire class BY CONSTRUCTION. That blind spot is
 *     exactly how the console door survived P-013's sweep and had to be found by hand
 *     (D-022): P-013 checked "is spawn-by-name covered?", found a doc asserting the
 *     surface had "exactly TWO doors" with both gated, and stopped.
 *
 *     So membership here is derived from the PROPERTY that defines the danger —
 *     *can this site turn a role NAME into a running process?* — never from a keyword.
 *     A door qualifies when it BOTH takes a role from input AND reaches a launch
 *     primitive. Add a fourth door tomorrow that reads `payload.agentRole` and execs a
 *     launcher, and it is caught without anyone updating a list of role spellings.
 *
 * ── WHAT COUNTS AS GATED ──────────────────────────────────────────────────────
 * The file must reference the canonical predicate `isRetiredTierRole` (or the
 * `RETIRED_TIER_ROLES` set / `mugKettleSystemEnabled` / `refuseIfMugKettleRetired`).
 * Deliberately the PREDICATE and not a string match on 'mug' — bootstrap-role.ts:204
 * makes the same point in its own comment, so that a future rename of the roles cannot
 * silently disarm every gate at once.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────
 *   node scripts/check-ungated-mug-kettle.mjs              # the guard (exit 1 = new ungated door)
 *   node scripts/check-ungated-mug-kettle.mjs --list       # read-only measured population
 *   node scripts/check-ungated-mug-kettle.mjs --reseed --reason "..."  # atomically write a reviewed population
 *   node scripts/check-ungated-mug-kettle.mjs --json
 *   node scripts/check-ungated-mug-kettle.mjs --check-file <path>   # ONE file — the falsifiability seam
 *   node scripts/check-ungated-mug-kettle.mjs --check-file <path> --full   # …incl. census families
 *
 * `--check-file` exists so falsifiability can be proven with a COPY-OUT mutation
 * (`scripts/mutation-probe.sh`) instead of mutating this shared tree, where git-sync
 * commits every few minutes and an exclusive lock does NOT pause it
 * (EI-19450431506682666).
 *
 * ⚠ `--check-file` ALONE INSPECTS ONE FAMILY: role-doors. It is fast and works
 * out-of-tree (which is what the copy-out probe needs), but it cannot see the eight
 * census families. `--full` adds them, at the cost of the ~33s whole-tree census, and
 * only for a path INSIDE the repo. Neither mode may report a clean bill for a family it
 * did not inspect — see the scope note on the --check-file branch (EI-20093615847114656).
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// This file's --list/--json output is emitted at ESM TOP LEVEL, where `return` is not
// available, so the exit cannot simply become `process.exitCode`. A plain console.log
// followed by process.exit() truncates through a pipe (measured: ~8 KiB survives), and
// --list is the documented way to RE-SEED the baseline — a truncated re-seed would
// silently shrink it. See scripts/check-undrained-stdout-exit.mjs.
import { stripCommentsOnly } from "./lib/strip-comments-and-strings.mjs";
import { writeStdoutSync } from "./lib/write-stdout-sync.mjs";
import {
  buildBaselineDocument,
  evaluateBaselineReseed,
} from "./lib/mug-kettle-baseline.mjs";
import { substrateRemediationLines } from "./lib/mug-kettle-substrate.mjs";
import {
  collectActiveRetiredGuidance,
  findRetiredGuidanceOffenders,
  guidanceTextFor,
} from "./lib/retired-tier-guidance.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BASELINE_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "ungated-mug-kettle-baseline.json",
);
const CENSUS = path.join(REPO_ROOT, "scripts", "mug-kettle-surface-census.mjs");

const SCAN_ROOTS = ["packages", "libs", "apps", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
  "_retired",
]);
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".jsx",
]);
const isTestFile = (p) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  p.includes(`${path.sep}__tests__${path.sep}`);

/** This guard must not inventory ITSELF — its doc comment names every shape it hunts. */
const SELF_FILE = fileURLToPath(import.meta.url);

/* ── (B) role-parameterized door detection ─────────────────────────────────────
 * A door needs BOTH halves. Either alone is common and harmless: plenty of files
 * read a `role` for authorization, and plenty spawn things with a fixed role.
 */

/**
 * The role arrives from EXTERNAL input — an HTTP request or a CLI argv — which is
 * what makes a site a DOOR (externally reachable) rather than an internal helper.
 * This is the half the census cannot see: there is no role literal to match.
 *
 * ⚠ SCOPE, stated because a detector's scope is a premise too: these patterns are
 * deliberately anchored to request/argv shapes. An earlier, looser draft accepted any
 * `role = <expr>.role` and matched a SORT COMPARATOR in `code-run-adoption.ts`
 * (`a.role === b.role ? …`), and accepted a bare `spawn(`/`execFileSync(` as a launch,
 * which flagged `pot/mug-warm-session.ts` — a pure, IO-free decider. Both were noise,
 * and noise is not harmless here: it is what makes a baseline get rubber-stamped.
 */
const ROLE_FROM_INPUT = [
  /\bbody\.role\b/,
  /\bsearchParams\.get\(\s*['"`]role['"`]/,
  /\bparams\.role\b/,
  /\bquery\.role\b/,
  /\bargv\.role\b/,
  /\brole\s*[:=]\s*(?:body|req|request|input|args|params|url|payload)\./,
];

/**
 * …and it reaches a real launch BACKEND. Composing a command string is NOT a door:
 * `agent-launch-core.ts` builds `--role=${opts.role}` psu commands for
 * capability:terminal / capability:launch-agent / fleet:launch-on-plan, but running
 * that command routes through `psu --role` → POST bootstrap-role, which IS gated
 * (D-022). Gating the chokepoint is correct; demanding a gate in every upstream
 * composer would be noise that trains readers to wave the guard through.
 */
const REACHES_LAUNCH = [
  /\bspawnAgentInHarness\b/,
  /\bfireLaunchBlueprint\b/,
  /\bbootstrapRole\b/,
  /\blaunchAgent\b/,
  /\binvokeOnce\b/,
  /\bexecFile(?:Sync)?\s*\(/,
  /['"`][^'"`]*\/(?:invoke|bootstrap-role)['"`]/,
];

/** Gated = references the canonical PREDICATE (never a raw 'mug' string match). */
const GATE_SYMBOLS = [
  "isRetiredTierRole",
  "RETIRED_TIER_ROLES",
  "mugKettleSystemEnabled",
  "refuseIfMugKettleRetired",
  "MUG_KETTLE_SYSTEM",
];

const isGated = (src) => GATE_SYMBOLS.some((s) => src.includes(s));

function firstMatchLine(src, regexes) {
  for (const re of regexes) {
    const m = re.exec(src);
    if (m)
      return {
        line: src.slice(0, m.index).split("\n").length,
        snippet: m[0].slice(0, 60),
      };
  }
  return null;
}

/** Does this ONE file contain a role-parameterized door? Returns a finding or null. */
export function inspectFile(abs, src) {
  // CODE ONLY, both halves. Measured under WI-37717: this file's OWN header discusses
  // the detection ("the role arrives as DATA — `body.role`, `url.searchParams.get('role')`")
  // and that prose matches ROLE_FROM_INPUT, so a file that merely explains the rule reads
  // as a door. The gated half needs the mask even more: `isGated` is a substring test, so
  // a comment that just NAMES the predicate ("this is not behind mugKettleSystemEnabled")
  // scored the file as gated — a false NEGATIVE, the direction that loses a real finding.
  //
  // stripCommentsOnly, not stripCommentsAndStrings: one ROLE_FROM_INPUT pattern REQUIRES a
  // string literal (`'…/invoke'`, `'…/bootstrap-role'`), so masking strings would delete a
  // detector rather than sharpen it. Length-preserving, so `roleHit.line` stays correct.
  src = stripCommentsOnly(src, abs);
  const roleHit = firstMatchLine(src, ROLE_FROM_INPUT);
  if (!roleHit) return null;
  const launchHit = firstMatchLine(src, REACHES_LAUNCH);
  if (!launchHit) return null;
  return {
    category: "role-door",
    subject: path.basename(abs, path.extname(abs)),
    file: path.relative(REPO_ROOT, abs),
    line: roleHit.line,
    detail: `role from input (${roleHit.snippet.trim()}) reaching a launch primitive (${launchHit.snippet.trim()})`,
    gated: isGated(src),
  };
}

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || /^dist(-|$)/.test(e.name)) continue;
      walk(abs, acc);
    } else if (
      CODE_EXT.has(path.extname(e.name)) &&
      !isTestFile(abs) &&
      abs !== SELF_FILE
    ) {
      acc.push(abs);
    }
  }
  return acc;
}

function collectRoleDoors() {
  const files = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), files);
  const out = [];
  for (const abs of files) {
    let src;
    try {
      src = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const f = inspectFile(abs, src);
    if (f) out.push(f);
  }
  return out;
}

function collectCensus() {
  const raw = execFileSync("node", [CENSUS, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const census = JSON.parse(raw);
  const selfRel = path.relative(REPO_ROOT, SELF_FILE);
  return (
    (census.findings ?? [])
      // This guard must not inventory ITSELF or its own baseline: the doc comment above
      // quotes `role: 'cup'` and the gate symbols verbatim, so the census sees a surface
      // and this file's own gate-symbol mentions mark it "gated" — a self-referential
      // green. The census applies the same exclusion to itself (SELF_FILE, census:71).
      .filter(
        (f) =>
          f.file !== selfRel &&
          !f.file.endsWith("ungated-mug-kettle-baseline.json"),
      )
      // `retired` = already under _retired/. `substrate` = D-003 population (b): the su
      // system itself runs on these, so gating them breaks loop:arm — inventory, never gate.
      // `display` = a UI site that NAMES a tier token without offering a route into it (a
      // read-only badge on a pane the roster already returned). Marked by D7 in the census,
      // filtered HERE rather than there, because the census inventories and this file
      // decides what fails. There is nothing to gate at such a site: refusing to RENDER
      // what a live pane already is would hide state, not withhold a capability — and
      // treating it as an offender is what froze `main` for an hour on a copy of a badge
      // line whose original had already been absorbed into the baseline below
      // (EI-20091394509538630).
      .filter((f) => !f.retired && !f.substrate && !f.display)
      .map((f) => {
        let gated = false;
        // Masked for the same reason as inspectFile: a gate symbol NAMED in a comment is
        // not a gate, and counting it as one is a false negative (WI-37717). The
        // self-exclusion two lines up exists because this file's own prose scored it
        // "gated" — that workaround is now redundant here, kept only so removing it is a
        // separate, separately-verified change.
        try {
          const raw = fs.readFileSync(path.join(REPO_ROOT, f.file), "utf8");
          gated = isGated(stripCommentsOnly(raw, f.file));
        } catch {
          /* file may be generated/absent */
        }
        return {
          category: f.category,
          subject: f.subject,
          file: f.file,
          line: f.line,
          detail: f.detail,
          gated,
        };
      })
  );
}

/** Line numbers drift under every unrelated edit, so they are NOT part of identity. */
const keyOf = (f) => `${f.category}|${f.subject}|${f.file}`;

function activeGuidanceFailed(result) {
  return (
    result.missingPaths.length > 0 ||
    result.readErrors.length > 0 ||
    result.offenders.length > 0
  );
}

function printActiveGuidanceFailures(result) {
  if (result.missingPaths.length) {
    console.error(
      "\n✖ current-guidance guard lost required canonical path(s):",
    );
    for (const file of result.missingPaths) console.error(`  missing: ${file}`);
  }
  if (result.readErrors.length) {
    console.error(
      "\n✖ current-guidance guard could not read maintained source(s):",
    );
    for (const error of result.readErrors)
      console.error(`  ${error.file}: ${error.message}`);
  }
  if (result.offenders.length) {
    console.error(
      "\n✖ active agentic guidance recommends a retired Queen/Mug/Kettle executor:\n",
    );
    for (const finding of result.offenders) {
      console.error(
        `  ${finding.file}:${finding.line}  [${finding.roles.join(", ")}]`,
      );
      console.error(`    ${finding.excerpt}`);
    }
    console.error(
      "\nReplace the prescription with canonical plan promotion + actionable assignment + required wake.\n" +
        "Historical text is allowed only when the same statement explicitly says retired, historical,\n" +
        "replaced, or refuses the old mechanism. Plan records and retired prompt trees are not scanned.\n",
    );
  }
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { keys: new Set(), raw: null };
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  return { keys: new Set(raw.entries ?? []), raw };
}

/** Write a reviewed baseline as one atomic same-directory rename. */
function writeBaselineAtomically(document) {
  const tempPath = `${BASELINE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(tempPath, BASELINE_PATH);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* rename already consumed it */
    }
  }
}

/* ── main ─────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

if (has("--list") && has("--reseed")) {
  console.error(
    "check-ungated-mug-kettle: --list is read-only and cannot be combined with --reseed",
  );
  process.exit(2);
}
if (has("--reason") && !has("--reseed")) {
  console.error(
    "check-ungated-mug-kettle: --reason is only valid with --reseed",
  );
  process.exit(2);
}

// --check-file: single-file mode, the mutation-probe seam.
//
// ⚠ SCOPE — stated in the OUTPUT, not only here, because a scope note only the author
// reads is not a scope note. This branch returns BEFORE `collectCensus()` below, so it
// sees the role-door family and nothing else. It used to answer
// `no role-parameterized door detected in X — nothing to gate`, exit 0 — a verdict about
// the FILE phrased from one family's evidence. That is a false green, and it fires
// exactly when someone is under pressure: a red gate leg names a file, the natural next
// move is to scope the guard to that file, and the guard answers clean. It was measured
// answering "nothing to gate" (exit 0) on the very file the FULL guard was failing on,
// and on libs/flags/src/types.ts, which carries 31 `flag|…` surfaces in the baseline; a
// peer issued a retraction off that green (EI-20093615847114656). The absence of a
// finding was being reported as a positive verdict — the same shape as
// EI-19947254836762793 (zero substrate rows read as "the substrate is fine").
//
// The rule this encodes: A VERDICT MAY NEVER BE BROADER THAN WHAT IT MEASURED. So the
// no-finding path names the families it did NOT inspect, and --full actually inspects
// them. Exit codes for every pre-existing invocation are unchanged, because
// scripts/mutation-probe.sh reads the guard's exit code as its verdict.
const checkFile = valOf("--check-file");
if (checkFile) {
  const wantFull = has("--full");
  const abs = path.isAbsolute(checkFile)
    ? checkFile
    : path.join(REPO_ROOT, checkFile);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch (err) {
    console.error(
      `check-ungated-mug-kettle: cannot read ${checkFile}: ${err.message}`,
    );
    process.exit(2);
  }

  // The census walks SCAN_ROOTS under REPO_ROOT, so it structurally CANNOT see a
  // copy-out probe in /tmp. Answering "no census surfaces" for such a path would
  // reintroduce this very bug one level up — an UNMEASURABLE thing reported as
  // measured-clean — so --full REFUSES rather than answers. Role-door detection is
  // path-independent, which is why the probe seam keeps working without --full.
  const rel = path.relative(REPO_ROOT, abs);
  const inTree = !rel.startsWith("..") && !path.isAbsolute(rel);
  if (wantFull && !inTree) {
    console.error(
      `check-ungated-mug-kettle: --full cannot inspect ${checkFile} — it is outside the repo,`,
    );
    console.error(
      `  and the census only walks [${SCAN_ROOTS.join(", ")}] under ${REPO_ROOT}.`,
    );
    console.error(
      `  Refusing rather than reporting a clean bill for files it cannot see.`,
    );
    console.error(
      `  Drop --full for the copy-out mutation probe (role-doors work out-of-tree).`,
    );
    process.exit(2);
  }

  const CENSUS_FAMILIES =
    "ui, tool, flag, spawn-role, prompt, wake, system-action, blueprint-launch";
  const roleDoor = inspectFile(abs, src);
  // WI-1726926: normalize exactly as the CORPUS scan does. `findRetiredGuidanceOffenders`
  // takes already-normalized text, so passing raw source re-enables comment scanning and
  // makes this single-file view DISAGREE with the gate's own verdict — reporting offenders
  // in the historical comments the guard deliberately allows. Measured before the fix:
  // launch-prompt.ts read 1 offender here and 0 in the corpus; decide.ts read 2 vs 0.
  // That divergence lands on whoever is using --check to confirm their own fix, and it is
  // how a census over raw source reported 1,325 offenders against a real 382.
  const guidanceOffenders = findRetiredGuidanceOffenders(
    checkFile,
    guidanceTextFor(checkFile, src),
  );

  if (roleDoor && roleDoor.gated) {
    console.log(`GATED  ${checkFile}:${roleDoor.line}  ${roleDoor.detail}`);
  } else if (roleDoor) {
    console.error(`UNGATED ROLE-DOOR  ${checkFile}:${roleDoor.line}`);
    console.error(`  ${roleDoor.detail}`);
    console.error(
      `  This site can turn a role NAME into a running process and does not reference`,
    );
    console.error(
      `  the retirement predicate. Gate it: isRetiredTierRole(role) + mugKettleSystemEnabled().`,
    );
  } else {
    console.log(`no role-parameterized door detected in ${checkFile}`);
  }

  if (guidanceOffenders.length) {
    console.error(
      `\n✖ ${guidanceOffenders.length} retired-executor guidance finding(s) in ${checkFile}:`,
    );
    for (const finding of guidanceOffenders) {
      console.error(
        `  ${finding.file}:${finding.line} [${finding.roles.join(", ")}] ${finding.excerpt}`,
      );
    }
  } else {
    console.log(
      `no current Queen/Mug/Kettle execution prescription detected in ${checkFile}`,
    );
  }

  let censusOffenders = [];
  if (!wantFull) {
    // NOT "nothing to gate". This is the whole fix: say what was not looked at.
    console.log(
      `⚠ NOT A CLEAN BILL — role-door + current-guidance were checked.`,
    );
    console.log(`  NOT inspected here: ${CENSUS_FAMILIES}.`);
    console.log(
      `  Re-run with --full for those, or run the full guard (npm run lint:no-ungated-mug-kettle).`,
    );
  } else {
    const hits = collectCensus().filter((f) => f.file === rel);
    const { keys: baselineKeys } = loadBaseline();
    censusOffenders = hits.filter(
      (f) => !f.gated && !baselineKeys.has(keyOf(f)),
    );
    if (hits.length) {
      console.log(`census surfaces in ${checkFile}: ${hits.length}`);
      for (const f of hits) {
        const mark = f.gated
          ? "GATED   "
          : baselineKeys.has(keyOf(f))
            ? "BASELINE"
            : "✖ NEW   ";
        console.log(`  ${mark} ${f.category} ${f.subject}  :${f.line}`);
      }
    } else {
      console.log(
        `no census surfaces in ${checkFile} (checked: ${CENSUS_FAMILIES})`,
      );
    }
    if (censusOffenders.length) {
      console.error(
        `\n✖ ${censusOffenders.length} NEW UNGATED census surface(s) in ${checkFile}.`,
      );
    }
  }

  process.exit(
    (roleDoor && !roleDoor.gated) ||
      censusOffenders.length ||
      guidanceOffenders.length
      ? 1
      : 0,
  );
}

const findings = [...collectCensus(), ...collectRoleDoors()];
const roleDoors = findings.filter((f) => f.category === "role-door");
const activeGuidance = collectActiveRetiredGuidance(REPO_ROOT);

if (has("--list")) {
  if (activeGuidanceFailed(activeGuidance)) {
    printActiveGuidanceFailures(activeGuidance);
    process.exit(1);
  }
  // The baseline is re-seeded from THIS, never from a hand-run grep (CLAUDE.md).
  // Written SYNCHRONOUSLY so `--list | …` cannot silently re-seed from a truncated set.
  writeStdoutSync(
    JSON.stringify({ entries: findings.map(keyOf).sort() }, null, 2),
  );
  process.exit(0);
}

const { keys: baseline, raw: baselineRaw } = loadBaseline();
const novel = findings.filter((f) => !baseline.has(keyOf(f)));
const offenders = novel.filter((f) => !f.gated);
const newlyGated = novel.filter((f) => f.gated);
const stale = [...baseline].filter(
  (k) => !findings.some((f) => keyOf(f) === k),
);

if (has("--reseed")) {
  if (activeGuidanceFailed(activeGuidance)) {
    console.error(
      "check-ungated-mug-kettle: refusing to reseed while current guidance is invalid.",
    );
    printActiveGuidanceFailures(activeGuidance);
    process.exit(1);
  }
  const evaluation = evaluateBaselineReseed({
    previousEntries: baselineRaw?.entries ?? [],
    currentEntries: findings.map(keyOf),
    reason: valOf("--reason") ?? "",
  });

  if (evaluation.reasonRequired && !evaluation.reason) {
    console.error(
      `check-ungated-mug-kettle: refusing to reseed a shrinking baseline ` +
        `(${evaluation.previousEntryCount} → ${evaluation.nextEntryCount} unique entries) without --reason`,
    );
    if (evaluation.removedEntries.length) {
      console.error(
        `  removed: ${evaluation.removedEntries.slice(0, 10).join(", ")}`,
      );
      if (evaluation.removedEntries.length > 10) {
        console.error(`  …and ${evaluation.removedEntries.length - 10} more`);
      }
    }
    process.exit(2);
  }

  const document = buildBaselineDocument({
    baseline: baselineRaw ?? {},
    currentEntries: findings.map(keyOf),
    reason: evaluation.reason ?? "",
  });
  writeBaselineAtomically(document);
  console.log(
    `✓ baseline reseeded atomically (${evaluation.previousEntryCount} → ` +
      `${evaluation.nextEntryCount} unique entries; removed ${evaluation.removedEntries.length}, ` +
      `added ${evaluation.addedEntries.length})`,
  );
  process.exit(0);
}

if (has("--json")) {
  writeStdoutSync(
    JSON.stringify(
      {
        total: findings.length,
        roleDoors: roleDoors.length,
        roleDoorsUngated: roleDoors.filter((f) => !f.gated).map(keyOf),
        baselineSize: baseline.size,
        offenders,
        newlyGated,
        stale,
        activeGuidance,
      },
      null,
      2,
    ),
  );
  process.exit(
    offenders.length || activeGuidanceFailed(activeGuidance) ? 1 : 0,
  );
}

console.log(
  `mug/kettle entry points: ${findings.length} live+non-substrate ` +
    `(${roleDoors.length} role-parameterized door(s), ${roleDoors.filter((f) => f.gated).length} gated)`,
);
console.log(
  `baseline: ${baseline.size} known${baselineRaw?.generatedAt ? ` (seeded ${baselineRaw.generatedAt})` : ""}`,
);
console.log(
  `current guidance: ${activeGuidance.filesScanned} maintained file(s) scanned, ` +
    `${activeGuidance.offenders.length} retired-executor prescription(s)`,
);

if (newlyGated.length) {
  console.log(
    `\n${newlyGated.length} new entry point(s), correctly GATED — add to the baseline when convenient:`,
  );
  for (const f of newlyGated.slice(0, 10))
    console.log(`  ✓ ${f.category} ${f.subject}  ${f.file}:${f.line}`);
}

if (stale.length) {
  // Shrink-only: a baseline entry that no longer exists is GOOD (a surface was retired).
  // Name the command that actually WRITES. `--list` only prints the current entries to
  // stdout (writeStdoutSync); `--reseed` is the sole caller of writeBaselineAtomically, so
  // telling the reader to "prune with --list" sends them to a no-op and the phantom row
  // survives to red the gate again, hours later, for a different agent (EI-20203730618121482).
  console.log(
    `\n${stale.length} baseline entr(y|ies) no longer present — the surface shrank.\n` +
      `  If the surface was DELETED or retired, drop the row(s) with:\n` +
      `      npm run lint:no-ungated-mug-kettle -- --reseed --reason "<why the surface was retired>"\n` +
      `  If it was RENAMED, re-key the census literal first and confirm the census sees it again;\n` +
      `  re-seeding while the census is blind to a surface that still exists makes that blindness permanent.`,
  );
}

if (offenders.length) {
  console.error(
    `\n✖ ${offenders.length} NEW UNGATED mug/kettle entry point(s):\n`,
  );
  for (const f of offenders) {
    console.error(`  ${f.category}  ${f.subject}`);
    console.error(`    ${f.file}:${f.line}`);
    console.error(`    ${f.detail}`);
  }
  console.error(
    `\nThe mug/kettle/cup tier is RETIRED behind FLAGS.MUG_KETTLE_SYSTEM (default OFF).`,
  );
  console.error(`A new entry point must refuse when the flag is off:`);
  console.error(
    `    import { isRetiredTierRole } from '<...>/pot/retired-tier-roles';`,
  );
  console.error(
    `    import { mugKettleSystemEnabled } from '<...>/pot/started';`,
  );
  console.error(
    `    if (isRetiredTierRole(role) && !(await mugKettleSystemEnabled())) return <refusal>;`,
  );
  for (const line of substrateRemediationLines(offenders)) console.error(line);
  console.error(
    `Plan: retire-mug-kettle-su-only-2026-08-09 (D-017/D-018/D-019/D-020/D-021/D-022).`,
  );
  // Match the report: otherwise the CI guard prints a failure but exits successfully.
  process.exitCode = 1;
} else {
  console.log("\n✓ no new ungated mug/kettle entry points");
}

if (activeGuidanceFailed(activeGuidance)) {
  printActiveGuidanceFailures(activeGuidance);
  process.exitCode = 1;
} else {
  console.log(
    "✓ active agentic template + su guidance names no retired executor as current",
  );
}
