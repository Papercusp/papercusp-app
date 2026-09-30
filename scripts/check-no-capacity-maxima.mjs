#!/usr/bin/env node
/**
 * P-013 (capless-inference-gateway-2026-08-28) — the recurrence guard.
 *
 * The capless work removed every productive-capacity maximum from the inference
 * gateway. Nothing stopped one from coming back. A single `const maxConcurrent = 4`
 * reintroduced in a helper is invisible in review, silently re-caps the fleet, and
 * is discovered the expensive way — an agent staring at queued work beside idle
 * slots, blaming a "capacity crunch".
 *
 * ## What this rejects
 *
 * A HARD-CODED or DERIVED bound on productive capacity: a maximum concurrency,
 * queue size, slot count, or admission window, assigned from a numeric literal or
 * computed with a clamping expression (Math.min / clamp).
 *
 * ## What makes a bound legitimate
 *
 * Some limits are real and must stay expressible. A site is ACCEPTED when its
 * writer declares WHY it is allowed to bind, on or directly above the line:
 *
 *     // @capacity-disposition: physical-contract — provider 429 budget, not our choice
 *     const maxConcurrent = quota.limit;
 *
 * Accepted dispositions are exactly the three that may bind a lane in
 * `admission-state-model.ts` (BINDING_DISPOSITIONS): `semantic`, `protocol`,
 * `physical-contract`. Deliberately NOT accepted: `observed` and `derived`. Those
 * describe a measurement or a presentation view, and neither may cap anything — so
 * a developer cannot wave a site through by picking the vaguest-sounding word.
 * A disposition also requires a reason after the marker; a bare marker is refused,
 * because an unexplained declaration is the rubber stamp this guard exists to stop.
 *
 * ## The baseline is SHRINK-ONLY
 *
 * Pre-existing sites live in BASELINE below and are re-seeded ONLY from a measuring
 * `--list` run, never a hand-written grep. A run that finds FEWER sites than the
 * baseline fails and tells you to shrink it — otherwise the baseline rots into a
 * permanent parking lot and the guard quietly stops guarding.
 *
 * Usage:
 *   node scripts/check-no-capacity-maxima.mjs           # the check
 *   node scripts/check-no-capacity-maxima.mjs --list     # measure + print a fresh baseline
 *   node scripts/check-no-capacity-maxima.mjs --root <d> # scan a different tree (used by the guard's own test)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { writeStdoutSync } from './lib/write-stdout-sync.mjs';

const REPO_ROOT = resolve(process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : new URL('..', import.meta.url).pathname);

/** Trees where a productive-capacity maximum is a real regression risk. */
const SCAN_DIRS = [
  'packages/operator-core/lib/inference-gateway',
  'packages/operator-core/lib/resource-governor',
];

const ACCEPTED_DISPOSITIONS = new Set(['semantic', 'protocol', 'physical-contract']);
const DISPOSITION_RE = /@capacity-disposition:\s*([a-z-]+)\s*(.*)$/;

/**
 * Identifiers that name a bound on PRODUCTIVE capacity. Deliberately narrow: a
 * timeout, a retry count, or a byte size is not a capacity maximum, and sweeping
 * them in would produce noise that trains people to add allowlist entries.
 */
const CAPACITY_IDENT_CAMEL =
  '(?:max(?:Concurrent|Concurrency|Queued|QueueDepth|Slots|InFlight|Window|Starts|Admitted)|concurrencyCap|capacityCap|slotsPerAccount|maxPerAccount)';

/**
 * The SCREAMING_SNAKE spelling of the same names (EI-21833221898785902). A
 * module-scope `const DEFAULT_MAX_QUEUED = …` caps exactly as hard as a
 * `maxQueued` property, and the camelCase-only pattern could not see one — so
 * the guard measured 0 sites in both scan dirs and passed vacuously.
 *
 * An ALL-CAPS PREFIX is allowed (`DEFAULT_`, `PAPERCUSP_GATEWAY_`) because that
 * is how these constants are actually spelled. A SUFFIX is deliberately NOT,
 * which mirrors the camelCase arm's strictness: `\b` already stops `maxWindow`
 * from matching `maxWindowMs`, and allowing `_MS` here would sweep in timeouts —
 * the noise this identifier list was kept narrow to avoid.
 */
const CAPACITY_IDENT_SNAKE =
  '(?:[A-Z0-9]+_)*(?:MAX_(?:CONCURRENT|CONCURRENCY|QUEUED|QUEUE_DEPTH|SLOTS|IN_FLIGHT|WINDOW|STARTS|ADMITTED|PER_ACCOUNT)|CONCURRENCY_CAP|CAPACITY_CAP|SLOTS_PER_ACCOUNT)';

const CAPACITY_IDENT = `(?:${CAPACITY_IDENT_CAMEL}|${CAPACITY_IDENT_SNAKE})`;

/**
 * A bound only counts when the capacity identifier ITSELF is pinned.
 *
 * The first measured run of this guard reported 9 sites of which 8 were noise, because
 * it asked two independent questions ("does a capacity word appear?" and "does any
 * assignment appear?") and accepted any line answering both. That let `<= 0` match as
 * an assignment (`<` + `= 0`) and let a ternary's trailing `: 0` bind to a capacity word
 * elsewhere on the line. The identifier and the assignment must be ONE anchored match.
 *
 * `(?<![<>=!])=` rejects the comparison operators; a bare `=` or `:` is a real write.
 */
const ASSIGN = '(?<![<>=!])=(?!=)';
/**
 * The `:` form must be a property KEY, never a ternary's else-branch. `(?<![.\\w])`
 * is what separates them: an object key stands alone (`{ maxQueued: 0 }`) while a
 * ternary reads through a receiver (`? s.maxQueued : 0`). Without it, the second
 * survived tightening and would have been baselined as a real cap.
 */
const KEY_IDENT = `(?<![.\\w])${CAPACITY_IDENT}`;
const PINNED_LITERAL_RE = new RegExp(
  `(?:\\b${CAPACITY_IDENT}\\s*${ASSIGN}\\s*-?\\d)|(?:${KEY_IDENT}\\s*:\\s*-?\\d)`,
);
const PINNED_CLAMP_RE = new RegExp(
  `(?:\\b${CAPACITY_IDENT}\\s*${ASSIGN}|${KEY_IDENT}\\s*:)\\s*(?:Math\\.min|clamp)\\s*\\(`,
);
/**
 * The THIRD pinning shape: an environment read with a literal fallback.
 *
 *     const DEFAULT_MAX_QUEUED = Number(process.env.PAPERCUSP_GATEWAY_MAX_QUEUED) || 256;
 *
 * Neither of the two regexes above sees this — `PINNED_LITERAL_RE` wants a digit
 * immediately after the assignment and `PINNED_CLAMP_RE` wants Math.min/clamp — yet
 * with the variable unset (the normal deployment) the bound IS the literal. Missing
 * this shape is why widening the identifier alone still measured the live gateway cap
 * as absent: BOTH gaps had to close for the site to become visible.
 *
 * Bounded to the current statement with `[^;\n]*` so a fallback later in the file
 * cannot bind to a capacity word on an earlier line.
 */
const PINNED_FALLBACK_RE = new RegExp(
  `(?:\\b${CAPACITY_IDENT}\\b\\s*${ASSIGN}|${KEY_IDENT}\\b\\s*:)[^;\\n]*(?:\\|\\||\\?\\?)\\s*-?\\d`,
);
const CAPACITY_MAX_RE = new RegExp(`\\b${CAPACITY_IDENT}\\b`);

/**
 * Sites present when the guard was introduced. SHRINK-ONLY.
 * Re-seed with `--list`; never hand-edit an entry in.
 */
const BASELINE = new Set([]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Read the disposition declared on this line or the two lines above it. */
function declaredDisposition(lines, index) {
  for (let i = index; i >= Math.max(0, index - 2); i--) {
    const m = DISPOSITION_RE.exec(lines[i] ?? '');
    if (!m) continue;
    const [, disposition, reason] = m;
    return { disposition, reason: (reason ?? '').trim() };
  }
  return null;
}

function findings() {
  const found = [];
  for (const rel of SCAN_DIRS) {
    for (const file of walk(join(REPO_ROOT, rel))) {
      const raw = readFileSync(file, 'utf8');
      const lines = raw.split('\n');
      // Prose describing a cap is not a cap. A block-comment continuation line
      // (` * ... maxConcurrent: 3 ...`) is the dominant false positive: three of the
      // first measured run's nine hits were documentation explaining the very caps
      // this work removed. A capacity word quoted inside a string is census/fixture
      // data for the same reason — `currentValue: '{ anthropic: { maxConcurrent: 3 } }'`
      // describes what production USED to do and is exactly what the inventory records.
      //
      // Both are masked by the SHARED stripper. This is a correctness upgrade, not just
      // a lint migration: the line-local regexes this replaced could not see the INTERIOR
      // of a block comment (the `^\s*(?:\*|//)` heuristic only caught lines that happen to
      // start with a leader), and the naive `'[^']*'` masking mis-parsed a regex literal
      // such as /['"]/ — opening a phantom string that deleted the rest of a real line.
      // The shared module blanks with SPACES via the TypeScript parser, so it is
      // length-preserving and `maskedLines[i]` aligns exactly with `lines[i]`.
      //
      // Dispositions are still read from the RAW `lines`: they are declared IN comments,
      // which is precisely what this masks away.
      const maskedLines = stripCommentsAndStrings(raw, file).split('\n');
      lines.forEach((line, i) => {
        const unquoted = maskedLines[i] ?? '';
        if (!CAPACITY_MAX_RE.test(unquoted)) return;
        if (
          !PINNED_LITERAL_RE.test(unquoted)
          && !PINNED_CLAMP_RE.test(unquoted)
          && !PINNED_FALLBACK_RE.test(unquoted)
        ) return;
        const site = `${relative(REPO_ROOT, file)}:${i + 1}`;
        found.push({ site, line: line.trim(), disposition: declaredDisposition(lines, i) });
      });
    }
  }
  return found;
}

const all = findings();

if (process.argv.includes('--list')) {
  // Buffered into ONE synchronous write, then exit. This payload is machine-readable
  // (it gets piped into a re-seed) and data-derived (it grows with the measured site
  // count), so it is exactly the shape that a `console.log` + immediate `process.exit`
  // truncates: the write is async once stdout is a pipe, and exit does not drain it.
  // A silently half-written baseline is worse than none — it re-seeds BASELINE short,
  // which SHRINKS a shrink-only allowlist and quietly un-guards the dropped sites.
  let out = `# measured ${all.length} capacity-maximum site(s)\n`;
  for (const f of all) {
    const d = f.disposition ? `${f.disposition.disposition}` : 'UNDECLARED';
    out += `${f.site}\t${d}\t${f.line}\n`;
  }
  out += '\n# baseline literal (paste into BASELINE):\n';
  out += `${JSON.stringify(all.map((f) => f.site), null, 2)}\n`;
  writeStdoutSync(out);
  process.exit(0);
}

const violations = [];
for (const f of all) {
  if (BASELINE.has(f.site)) continue;
  if (!f.disposition) {
    violations.push({ ...f, why: 'no @capacity-disposition marker' });
    continue;
  }
  if (!ACCEPTED_DISPOSITIONS.has(f.disposition.disposition)) {
    violations.push({
      ...f,
      why: `disposition '${f.disposition.disposition}' may not bind capacity (accepted: ${[...ACCEPTED_DISPOSITIONS].join(', ')})`,
    });
    continue;
  }
  if (!f.disposition.reason) {
    violations.push({ ...f, why: `disposition '${f.disposition.disposition}' declared with no reason` });
  }
}

// SHRINK-ONLY: a baseline entry that no longer matches must be removed, or the
// baseline slowly becomes a parking lot that permanently exempts live code.
const liveSites = new Set(all.map((f) => f.site));
const staleBaseline = [...BASELINE].filter((site) => !liveSites.has(site));

if (violations.length === 0 && staleBaseline.length === 0) {
  console.log(`✓ no undeclared productive-capacity maxima (${all.length} declared site(s) scanned)`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error(`\n✗ ${violations.length} undeclared productive-capacity maximum/maxima:\n`);
  for (const v of violations) {
    console.error(`  ${v.site}`);
    console.error(`    ${v.line}`);
    console.error(`    → ${v.why}`);
  }
  console.error(`
A productive-capacity maximum needs its writer to say WHY it may bind:

    // @capacity-disposition: physical-contract — provider 429 budget, not our choice
    const maxConcurrent = quota.limit;

Accepted: ${[...ACCEPTED_DISPOSITIONS].join(', ')}. 'observed' and 'derived' are NOT
accepted — they describe a measurement or a view, and neither may cap anything.
If this is an adaptive window rather than a maximum, it does not belong under a
max*/cap identifier: name it a window and the guard stops caring.
`);
}

if (staleBaseline.length > 0) {
  console.error(`\n✗ ${staleBaseline.length} stale BASELINE entry/entries — the guard is shrink-only:\n`);
  for (const site of staleBaseline) console.error(`  ${site}`);
  console.error('\nThese sites are gone. Remove them from BASELINE (re-seed with --list).\n');
}

process.exit(1);
