#!/usr/bin/env node
/**
 * gen-claude-md-manifest.mjs — P-014 of claude-md-projection-from-pg-2026-08-10
 *
 * Emits the part manifest that P-003 loads into harness_shared.harness_doc_parts.
 *
 * WHY A GENERATOR AND NOT A COMMITTED JSON FILE.
 * CLAUDE.md is edited continuously by the whole fleet — it grew 678 bytes and 8 lines
 * during the ~40 minutes between the P-002 classification and this script being written.
 * A committed manifest would be stale before it was reviewed. The durable artifact is the
 * CLASSIFICATION (the RANGES table below, which is human judgment); the manifest is derived.
 *
 * WHY EVERY RANGE CARRIES A FINGERPRINT.
 * Ranges are line-anchored, and line numbers rot on every edit. Each range therefore records
 * the first non-blank line it began at when it was classified. The generator asserts that
 * fingerprint still matches, so drift FAILS LOUDLY naming the ranges to re-review, instead of
 * silently attaching last week's classification to today's paragraph. That failure mode —
 * a well-formed manifest that classifies the wrong text — is the one worth engineering against.
 *
 *   node scripts/gen-claude-md-manifest.mjs                # write manifest, exit 1 on drift
 *   node scripts/gen-claude-md-manifest.mjs --check        # verify only, write nothing
 *   node scripts/gen-claude-md-manifest.mjs --out <path>
 *
 * UNITS. `wc -c` reports BYTES; String.length reports UTF-16 code units. This file is dense
 * with multibyte glyphs, so the two differ by ~1.5k. The manifest records BOTH, named, because
 * the projector's budget (D-008) is compared against a threshold expressed in characters.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECTION_MARKER } from './project-doc-parts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so the drift detector can be proven falsifiable against a mutated COPY
// outside the tree (tier 2 of the mutation-probe recipe) — never by mutating the shared file.
const SOURCE = process.env.PAPERCUSP_CLAUDE_MD
  ? resolve(process.env.PAPERCUSP_CLAUDE_MD)
  : resolve(ROOT, 'CLAUDE.md');
const DEFAULT_OUT = resolve(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-part-manifest.json');

/**
 * The composed client files are projector output, not a second source of the corpus.
 * Keep this check beside the generator so a post-projection CLAUDE.md cannot silently
 * retire every corpus-only prose part when someone runs this script from the repo root.
 */
export function projectionSourceProblem(text) {
  if (!text.includes(PROJECTION_MARKER)) return null;
  return (
    `source carries the projection marker "${PROJECTION_MARKER}"; it is generated output, not canonical ` +
    `source. Refusing to regenerate the manifest from it because that would retire the corpus-only prose parts.`
  );
}

/**
 * The P-002 classification. [startLine, endLine, kind, fingerprint]
 *   INV invariant · PTR pointer · REC recipe · INS prose · EXP expiring correction
 *
 * INV/PTR/REC project into CLAUDE.md + AGENTS.md. INS/EXP move to agent-insights rows and
 * never project (enforced by harness_doc_parts_prose_never_projects, migration 781).
 * EXP is prose with a bounded life: scaffolding that exists only to correct an earlier
 * version of this file, and which should age out once no agent carries the stale reading.
 *
 * Contiguous and exhaustive: covers every line, no gaps, no overlaps (asserted below).
 */
const RANGES = [
  [1, 15, 'INV', '# Papercup — agent guide'],
  [16, 30, 'INV', '## ▶ Running / testing this app — it is '],
  [31, 57, 'EXP', '> ⚠ **Launch via `npm run dev` — never a'],
  [58, 73, 'INV', '> **You CAN — and therefore MUST — verif'],
  [74, 84, 'INV', '- **Never open `:3055` or `:3070` in a b'],
  [85, 89, 'PTR', 'The `:3055`/`:3070` layer **is the deskt'],
  [90, 106, 'INV', '## Almost all state should be in nuqs'],
  [107, 123, 'INV', '## All client data sync goes through `@p'],
  [124, 135, 'INV', '## Scheduling: no bare `setInterval`, no'],
  [136, 152, 'INS', '⚠ **`schedule:inventory` is PER-PROCESS,'],
  [153, 166, 'INS', '⚠ Federation was necessary, **not suffic'],
  // The boundary here was drawn mid-paragraph in P-002 (after L181, inside the "Never kill by
  // name" block), which split ONE paragraph into two parts. Both sides classify INV, so no
  // classification changed — but the block identity did, and blockSha is now load-bearing.
  // Moved to the blank line at L180. assertRangesRespectBlocks() keeps the class from recurring.
  [167, 180, 'INV', '## Spawning: no unenrolled `detached` sp'],
  [181, 196, 'INV', '⛔ **Never kill by name or pattern.** `pk'],
  [197, 222, 'INV', '## Shared-lib singletons: pin through th'],
  [223, 282, 'INS', 'Measured (EI-19451658870832332): `@paper'],
  [283, 295, 'INV', '## Deployment model: desktop is the prod'],
  [296, 349, 'INV', '## Retired / preserved-not-active surfac'],
  [350, 365, 'INS', '**What enforces this section.** `lint:no'],
  [366, 375, 'PTR', '## Borrowable libraries — generic-first'],
  [376, 390, 'INV', '## This app is in testing — there are no'],
  [391, 408, 'INV', '## A blocker is work, not a stop sign — '],
  [409, 422, 'INV', '## A cross-lane ruling is a plan Decisio'],
  [423, 432, 'INS', 'Two mechanisms make this cheap in practi'],
  [433, 442, 'INV', '## Branch discipline: the shared tree st'],
  [443, 452, 'INV', '## Commit discipline: git-sync owns comm'],
  [453, 541, 'INS', '> ⚠ **Checking whether your edit landed,'],
  [542, 552, 'INV', '> ⚠ **`git blame` on this repo never tel'],
  [553, 569, 'INV', '> 🚨 **NEVER run a tree-wide destructive '],
  [570, 583, 'INV', '**Never sit in a wait/poll loop for git-'],
  [584, 601, 'INV', '**"Is my change live, and if not what is'],
  [602, 630, 'INV', '**About to ACT on one of these values — '],
  [631, 650, 'INV', 'Two specifics worth knowing:'],
  [651, 679, 'EXP', '⚠⚠ **This passage asserted the OPPOSITE '],
  [680, 709, 'INV', '⚠⚠ **THE PREMISE UNDER EVERY RECIPE BELO'],
  [710, 726, 'REC', '✅ **ONE CALL ANSWERS STEP 0 AND STEP 1 T'],
  [727, 778, 'INS', 'The `candidate` field DRIFTS: a single c'],
  [779, 869, 'INS', '**FALLBACK — the routines marker in Post'],
  [870, 1019, 'INS', '**Then — and only then — settle containm'],
  [1020, 1084, 'INS', "⚠⚠ **A RUN'S JUDGED CANDIDATE CHANGES MI"],
  [1085, 1183, 'INS', '⚠ **`AFFECTED_TESTS_RESULT failed=N` cou'],
  [1184, 1249, 'INS', '⚠ **`skipped-locked` is a DESIGNED DEFER'],
  [1250, 1273, 'INV', '🚨 **Never fire a manual `release:checkpo'],
  [1274, 1333, 'INS', '🚨🚨 **Never answer "is a gate run in flig'],
  [1334, 1362, 'INV', '## Server-side edits and the two-port mo'],
  [1363, 1380, 'PTR', '## Before you design or test — read the '],
  [1381, 1389, 'PTR', '## Read this before changing code — perf'],
  [1390, 1395, 'INV', '## Storage policy: Postgres by default'],
  [1396, 1427, 'INV', '- **Schema = migrations only; NO runtime'],
  [1428, 1437, 'INV', '| you want | use | not |'],
  [1438, 1468, 'INS', 'Nothing in the table fits and the shape '],
  [1469, 1494, 'INS', 'Prefer `work_items:list{severity}` / `wo'],
  [1495, 1558, 'INV', '## Reaching for bash? These reads alread'],
  [1559, 1594, 'INV', '## `cd` outside the repo tree does NOT p'],
  [1595, 1607, 'INV', '## Long jobs: background them at the LAU'],
  [1608, 1646, 'INS', '⚠ **A background job still has a wall-cl'],
  [1647, 1689, 'INS', "⚠ **A background command's own reported "],
  [1690, 1734, 'INV', '⚠ **Never wait on a process-table patter'],
  [1735, 1777, 'REC', '✅ **"Is this process actually DOING WORK'],
  [1778, 1797, 'INS', "⚠ **Waiting on the right PID isn't enoug"],
  [1798, 1851, 'INV', '## Feature flags + PostHog'],
  [1852, 1866, 'INV', '## Tests after editing'],
  [1867, 1907, 'INS', 'A git-based probe cannot answer that que'],
  [1908, 1915, 'INV', '⚠⚠ **`lint:tsc` typechecks `packages/ope'],
  [1916, 2015, 'INS', '> ✅ **Editing `apps/operator` — includin'],
  [2016, 2049, 'INV', '**The trigger to watch: adding a REQUIRE'],
  [2050, 2070, 'INV', 'Schema/migration edits (`libs/papercusp/'],
  [2071, 2096, 'INS', "It discovers each file's owning workspac"],
  [2097, 2139, 'INS', '**`npm install`/`npm ci` on this shared '],
  [2140, 2168, 'INV', '## Proving a guard is falsifiable — neve'],
  [2169, 2211, 'INS', '| your subject | how to prove falsifiabi'],
  [2212, 2220, 'PTR', '## Browser checks — use `verdict`'],
  [2221, 2227, 'PTR', '## Use Context7 for current library docs'],
  [2228, 2284, 'INV', '## Adding a tool — the per-role guidance'],
  [2285, 2299, 'INV', '## Prompts are auto-generated — edit the'],
  [2300, 2311, 'INV', '## Where new tests go — four canonical f'],
];

// kind -> (schema kind, client scope, budget rank). Ranks are coarse on purpose: D-008 keeps
// every imperative, so rank orders the CUT if the budget bites, and safety rails must survive.
const KIND = { INV: 'invariant', PTR: 'pointer', REC: 'recipe', INS: 'prose', EXP: 'prose' };
const SCOPE = { INV: ['all'], PTR: ['all'], REC: ['all'], INS: [], EXP: [] };
const RANK = { INV: 100, REC: 200, PTR: 300, EXP: 900, INS: 1000 };

/**
 * Blocks classified AFTER the RANGES bootstrap, keyed by content.
 *
 * RANGES is pinned to the snapshot it was drawn on and cannot classify text written since; this is
 * where new and edited blocks land instead. Keyed by blockSha on purpose — a classification here
 * attaches to the exact text it was made against, so an edit to that text does not silently inherit
 * the old verdict, it comes back UNCLASSIFIED for a fresh look. Append-only: entries whose sha is no
 * longer in the file are inert, and are reported as `departed` rather than quietly dropped.
 */
const CLASSIFIED = {
  // 2026-08-11, EI-20110999835069827 — the mutation-probe tier table and recipe are
  // operative guidance, not corpus-only evidence. Keep the classification durable by
  // content hash so a later projection/load cannot silently hide the promised remedy.
  aba95162c5517792: 'INV', // tier table
  '1b0502dc916158cf': 'INV', // mutation-probe overview
  a15204c8f6cc5d8e: 'INV', // mutation-probe invocation
  '1fc7000761ea9ac8': 'INV', // exit-code semantics
  '65289b5b559eff0d': 'INV', // tier-3 sweep pause
  '4f42386af1aaea88': 'INV', // tier-3 lock invocation
  // 2026-08-10, WI-37636 — a peer anchored three gate-forensics greps on a field only a real
  // machine line carries, so vitest test NAMES stop matching them as impostors. All three code
  // blocks and both new warnings sit inside the L1085-1183 [INS] band and inherit prose from the
  // paragraphs they replace (commit-discipline-git-sync-o-bash-3/4/5, all prose).
  cbe4038edb3767ae: 'INS', // ```bash grep -o 'GATE_PROMOTION candidate=.*'
  '213721f3ce9a76cf': 'INS', // "⚠ The ` candidate=` anchor is prophylactic here…"
  '4d615c553e999816': 'INS', // ```bash grep -o 'AFFECTED_TESTS_FAILING_FILES run=.*'
  '4b7c788b2032a7fe': 'INS', // ```bash grep -o 'GATE_HELD_BY count=.*'
  '5db12b56770442ca': 'INS', // "⚠⚠ Keep the ` count=` in that grep…" (superseded by e337b6dd below)
  e337b6ddc39d8670: 'INS', // same warning, reworded by its author minutes later — a live example
  //                          of why these are keyed by content: the reword did NOT inherit the
  //                          old verdict, it came back UNCLASSIFIED for a fresh look.
  // 2026-08-11, acceptance-rubrics-on-every-plan-2026-08-11 P-008 close-out — a day of fleet
  // edits (08-10 → 08-11) accumulated 44 unclassified shas; the acceptance-rubric part-add made
  // the corpus/manifest count disagree, surfacing the debt. Each entry below inherits the kind
  // of the RANGES band its predecessor text was classified under (edited-in-place blocks), except
  // the NEW acceptance-rubric section (L244-254), classified fresh: mandate → INV, procedure → REC.
  '74ce21d375537f69': 'INV', // generated-file banner comment (header band, was [1,15] INV)
  '66d8732b7f7fa2d9': 'INV', // "CLAUDE.md is GENERATED" edit-here-does-nothing warning (header band)
  '7f03f82ccff20c50': 'INV', // nuqs "when in doubt" (nuqs band)
  '27248f050cf1d0c8': 'INV', // sync reads via useSyncQuery (sync band)
  '63244dd893eacece': 'INV', // retired-but-kept surfaces (retired band)
  '70b9a0e2aa2d18cb': 'INV', // interactive PSU fast-redirect caveat (blocker-is-work band)
  b46620700749e7d8: 'INV', // "not a paperwork nicety" (cross-lane-ruling band)
  '5de19f8341082941': 'INV', // NEW: every plan ships a graded acceptance rubric — the mandate
  c90bef7f972641c7: 'REC', // NEW: the rubrics:propose → grade → ship numbered procedure
  e4209ee6aa342d4d: 'INV', // NEW: do NOT author rubric at plan-creation / during impl
  '175012caaed9da5b': 'INV', // git blame / commit subject not evidence (git-blame band)
  '3d3eab92f9c953e6': 'INV', // never tree-wide destructive git (destructive-git band)
  '4bdc02653cd66cfc': 'INV', // pipeline_position is THE one call (pipeline band)
  '9becd6ceaa007c37': 'INV', // plane block derived from changeSignal (state-plane band)
  '170b31339bc7eec4': 'INV', // corroboration requires independent evidence (gate-premise band)
  '170a81fc52423874': 'REC', // judged-sha cell result description (step-0 recipe band)
  '9ffeab0cb6e5c504': 'INV', // never manual checkpoint-run in re-triage window (band [1250,1273])
  ffe0e74c54cda1ae: 'INV', // verb now refuses with the answer (same band, tool-behavior update)
  '7e4fb883d47f8fdc': 'INV', // :3070 = GREEN operator from release checkout (two-port band)
  d155239fab627ef3: 'INV', // migrations only + atomic allocator (storage band)
  '7174c313eb871f21': 'INV', // cwd reset outside repo tree (cd band)
  '23b58d4bd089993d': 'INV', // never wait on self-matching process pattern (band [1690,1734])
  '9dbad4b0b9a15867': 'REC', // ✅ proc-guard.mjs check first (tool recommendation)
  '71e9c27df7d39add': 'INV', // pgrep -q does not exist here (band [1690,1734])
  '92520ab4a43b5bfd': 'INV', // pgrep -x comm 15-char truncation (band [1690,1734])
  '0cacb67d5e732ccb': 'REC', // ✅ two-sample cgroup delta (band [1735,1777] REC)
  d861e922b67b7026: 'REC', // the cgroup recipe fenced code block (same recipe)
  '7a6a4d30d5802618': 'REC', // every capability:bash job runs in its own scope (recipe caveat)
  '1fb09dc254a11c4d': 'INS', // hand-rolled /proc walk false-idle evidence (band [1778,1797] INS)
  ea8c5c1f0075bdf4: 'REC', // measure the whole process tree (recipe caveat)
  '5b335f0b191b0d31': 'REC', // top -n1 usable; two-sample still preferred (recipe caveat)
  '0e76e5d8a8c19c88': 'INV', // dark allowlist shrink-only (flags band)
  '224a290b2a64b5fd': 'INV', // print-only affected probe emissions (tests band)
  '7460e9852fc9b8c4': 'INV', // lint:tsc typechecks operator-core only (band [1908,1915])
  '77b629143b1e13a8': 'INV', // required-field trigger (band [2016,2049])
  e1a3af688dce9938: 'INV', // lint:required-field-strands (same band)
  '1a4dd129d76af447': 'INV', // migration strands hand-rolled fixture (band [2050,2070])
  b126206dfcdb7f8c: 'INV', // npm only — never pnpm/yarn (mandate)
  c92a77e73c4f323f: 'INV', // mutation probe committed-by-sweep hazard (mutation-probe band)
  '4096577550e801d4': 'INV', // adding-a-tool step 1 (band [2228,2284])
  d4b8359815556547: 'INV', // root entrypoint queues behind pc-heavy (same band)
  c70d45382ca9853d: 'INV', // editing a live tool counts too (same band)
  '79b88796a185815c': 'INV', // limit bounds row lists, never aggregates (same band)
  '0169fa20bd8c7bf6': 'INV', // censusLimit + truncatedByLimit fix pattern (same band)
};

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function slug(s, max = 48) {
  return s
    .replace(/`|\*\*/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '-') // '_' too: \w keeps it, but part keys stay strictly kebab-case
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
}

/** Blank-line-delimited blocks, with fenced code held together. */
function splitBlocks(lines, from, to) {
  const out = [];
  let cur = [];
  let start = null;
  let fenced = false;
  for (let i = from - 1; i < to; i++) {
    const line = lines[i] ?? '';
    if (line.trim().startsWith('```')) fenced = !fenced;
    if (!line.trim() && !fenced) {
      if (cur.length) out.push({ start, end: i, body: cur });
      cur = [];
      start = null;
      continue;
    }
    if (start === null) start = i + 1;
    cur.push(line);
  }
  if (cur.length) out.push({ start, end: to, body: cur });
  return out;
}

const firstNonBlank = (lines, a, b) => (lines.slice(a - 1, b).find((l) => l.trim()) ?? '').trim();

const sortedRanges = () => [...RANGES].sort((x, y) => x[0] - y[0]);

/** Last line the RANGES bootstrap covers — i.e. the snapshot it was drawn against. */
export const bootstrapExtent = () => sortedRanges().at(-1)[1];

/**
 * A classification range must never end in the MIDDLE of a block.
 *
 * When it does, the block is emitted as two parts split at the range boundary rather than at the
 * blank line — so its identity is an artifact of where the classification was drawn, not of the
 * text. That was harmless while parts were addressed by line, and is not once `blockSha` carries
 * the classification: the two halves have shas no whole-file reader will ever produce. Exactly one
 * such boundary existed (after L181, inside "Never kill by name"); this keeps the class from
 * returning as the ranges are re-drawn.
 */
export function rangeBoundaryProblems(lines, sorted) {
  const blank = (n) => (lines[n - 1] ?? '').trim() === '';
  const inFence = [];
  let f = false;
  for (const l of lines) { if (l.trim().startsWith('```')) f = !f; inFence.push(f); }

  const out = [];
  for (const [a, b, kind] of sorted) {
    if (b >= lines.length) continue;
    if (inFence[b - 1]) {
      out.push(`L${a}-${b} [${kind}] ends INSIDE a fenced code block — the boundary splits code.`);
    } else if (!blank(b) && !blank(b + 1)) {
      out.push(
        `L${a}-${b} [${kind}] ends mid-paragraph (L${b} and L${b + 1} are both non-blank), so the ` +
          `block spanning it is emitted as two parts split at the range boundary. Move the boundary ` +
          `to the blank line that ends the block.`,
      );
    }
  }
  return out;
}

/**
 * The classified parts, each carrying the raw block text it was cut from.
 *
 * Exported so later phases address the SAME blocks the manifest does. P-015
 * (rule/evidence separation) needs each block's text; a second copy of
 * splitBlocks would drift from this one silently, and every partKey/blockSha it
 * produced would then name a block that no longer exists here.
 *
 * `raw` is deliberately NOT carried into the manifest JSON: it is CLAUDE.md's
 * own text, and copying 160KB of it into a committed artifact would create a
 * second copy of the file that can disagree with the first. Downstream readers
 * re-derive it from the source and check `blockSha`.
 */
export function extractParts(text, { classBySha = null } = {}) {
  const lines = text.split('\n');

  // Classification comes from ONE of two sources, never both:
  //   • classBySha — the committed manifest, keyed by CONTENT. Survives line movement.
  //   • RANGES     — the P-002 bootstrap, keyed by LINE. Valid only at the snapshot it was drawn on.
  // A block whose sha is unknown is left UNCLASSIFIED (kind null) and reported for review, never
  // guessed: inheriting a neighbour's classification is the "renumbering" failure D-011 forbids.
  //
  // The whole tuple travels, not just `kind` — KIND maps both INS and EXP to 'prose', so a
  // kind-only carry would silently lose `expiring` and collapse rank 900 into 1000.
  const rangeCodeAt = (line) => {
    for (const [a, b, code] of sortedRanges()) if (line >= a && line <= b) return code;
    return null;
  };
  const fromRangeCode = (code) =>
    code ? { kind: KIND[code], clientScope: SCOPE[code], projectRank: RANK[code], expiring: code === 'EXP' } : null;

  const heads = [];
  lines.forEach((l, i) => {
    if (l.startsWith('## ')) heads.push([i + 1, l.slice(3).trim()]);
  });
  const sectionOf = (n) => {
    let cur = '(preamble)';
    for (const [ln, t] of heads) {
      if (ln <= n) cur = t;
      else break;
    }
    return cur;
  };

  const parts = [];
  const seen = new Set();
  let ordinal = 0;
  // Split the WHOLE file, not range by range. Ranges tile the file at blank-line
  // boundaries, so this yields the same blocks — confirmed empirically at the
  // re-anchor: 247 of 252 shas matched, and all 5 misses were genuinely edited text.
  for (const blk of splitBlocks(lines, 1, lines.length)) {
    const raw = blk.body.join('\n');
    if (raw.trimStart().startsWith('## ')) continue; // headings are emitted by the projector
    const blockSha = sha16(raw);
    const cls = classBySha ? (classBySha.get(blockSha) ?? null) : fromRangeCode(rangeCodeAt(blk.start));
    const section = sectionOf(blk.start);
    ordinal += 1;
    const base = slug(`${slug(section, 28)}--${firstNonBlank(lines, blk.start, blk.end)}`);
    let key = base || `part-${ordinal}`;
    let n = 1;
    while (seen.has(key)) key = `${base}-${++n}`;
    seen.add(key);
    const scope = cls?.clientScope ?? [];
    parts.push({
      partKey: key,
      ordinal,
      kind: cls?.kind ?? null,
      clientScope: scope,
      // targetSection is POSITIONAL, so it is always recomputed — a block that moved under a
      // different heading must project under the new one, even though its classification carried.
      //
      // EVERY part carries it, projected or not. This used to read `scope.length ? section : null`,
      // which discarded the section for all 172 non-projecting (prose) blocks — the section was
      // computed for them and then thrown away. Two things broke downstream, and both are the
      // reason this is a defect rather than a preference:
      //   • the corpus could not be RECOMPOSED, because `assemble()` derives the `## ` headings
      //     from target_section and headings are deliberately not stored as parts. Without a
      //     section on prose rows the corpus has no headings at all, so `retired-surfaces`
      //     (which locates its subject BY HEADING) judged 0 claims and still reported a found
      //     section — the most reassuring possible shape for a guard judging nothing (D-015).
      //   • Phase 3 moves prose into agent-insights BY SECTION, and cannot without it.
      // The table CHECK (harness_doc_parts_projected_needs_section) only ever REQUIRED a section
      // on projected parts; nothing ever asked for it to be absent from the rest.
      targetSection: section,
      projectRank: cls?.projectRank ?? null,
      expiring: cls?.expiring ?? false,
      blockSha,
      chars: raw.length + 1,
      lineHint: [blk.start, blk.end],
      raw,
    });
  }
  return parts;
}

/**
 * @param text  current CLAUDE.md
 * @param prior the committed manifest, or null to BOOTSTRAP the classification from RANGES.
 *
 * With a prior, classification is carried by content (blockSha), so a peer inserting a paragraph
 * anywhere does NOT invalidate the blocks below it. Only genuinely new or edited blocks come back
 * unclassified. The old check keyed on LINE position and so refused on movement alone: at the
 * re-anchor it reported 30 drifted ranges and exit 1 while 247 of 252 blocks (98.0%) were
 * byte-identical — a ~6x overstatement that would have made Phase 1b restart-prone, because this
 * file moves daily (WI-37635 / D-011).
 */
export function buildManifest(text, prior = null) {
  const lines = text.split('\n');
  const problems = [];
  const projectionProblem = projectionSourceProblem(text);
  if (projectionProblem) problems.push(projectionProblem);

  const fromCode = (code) => ({ kind: KIND[code], clientScope: SCOPE[code], projectRank: RANK[code], expiring: code === 'EXP' });
  const classBySha = prior
    ? new Map([
        ...prior.parts
          .filter((p) => p.kind)
          .map((p) => [p.blockSha, { kind: p.kind, clientScope: p.clientScope, projectRank: p.projectRank, expiring: p.expiring }]),
        // CLASSIFIED wins over the prior manifest: it is the hand-made verdict on text written
        // since the bootstrap, and re-stating it every run is what keeps it auditable in source.
        ...Object.entries(CLASSIFIED).map(([sha, code]) => [sha, fromCode(code)]),
      ])
    : null;

  // ── structural checks on the RANGES bootstrap (only meaningful when bootstrapping) ──
  if (!classBySha) {
    const sorted = sortedRanges();
    if (sorted[0][0] !== 1) problems.push(`ranges must start at line 1, start at ${sorted[0][0]}`);
    for (let i = 0; i < sorted.length - 1; i++) {
      const end = sorted[i][1];
      const next = sorted[i + 1][0];
      if (next !== end + 1) {
        problems.push(next > end + 1 ? `gap: lines ${end + 1}..${next - 1} unclassified` : `overlap at line ${next}`);
      }
    }
    const lastLine = sorted[sorted.length - 1][1];
    if (lastLine !== lines.length) {
      problems.push(
        `ranges end at line ${lastLine} but the file has ${lines.length} — ${lines.length - lastLine} line(s) unclassified. ` +
          `The RANGES bootstrap is pinned to its snapshot; re-anchor from the committed manifest instead.`,
      );
    }
    for (const [a, b, kind, fingerprint] of sorted) {
      const actual = firstNonBlank(lines, a, b).slice(0, fingerprint.length);
      if (actual !== fingerprint) problems.push(`L${a}-${b} [${kind}] fingerprint moved: expected ${JSON.stringify(fingerprint)}, reads ${JSON.stringify(actual)}`);
    }
    problems.push(...rangeBoundaryProblems(lines, sorted));
  }

  // ── emit parts (raw block text dropped: see extractParts) ──
  const withRaw = extractParts(text, { classBySha });
  const parts = withRaw.map(({ raw: _raw, ...p }) => p);

  // Blocks whose content the classification has never seen. NOT a line-drift signal.
  const needsReview = parts.filter((p) => !p.kind).map((p) => ({
    partKey: p.partKey,
    blockSha: p.blockSha,
    line: p.lineHint[0],
    chars: p.chars,
    head: (withRaw.find((w) => w.blockSha === p.blockSha)?.raw ?? '').split('\n')[0].slice(0, 88),
  }));
  // Classified blocks that are no longer anywhere in the file.
  const liveShas = new Set(parts.map((p) => p.blockSha));
  const departed = prior ? prior.parts.filter((p) => p.kind && !liveShas.has(p.blockSha)).map((p) => ({ partKey: p.partKey, blockSha: p.blockSha, kind: p.kind })) : [];

  // ── invariants the loader depends on (mirrors migration 781's CHECK constraints) ──
  for (const p of parts) {
    if (p.kind === 'prose' && p.clientScope.length) problems.push(`${p.partKey}: prose must not project`);
    if (p.clientScope.length && !p.targetSection) problems.push(`${p.partKey}: projected part needs a targetSection`);
  }

  const byKind = {};
  for (const p of parts) {
    const k = p.kind ?? 'UNCLASSIFIED';
    byKind[k] ??= { parts: 0, chars: 0 };
    byKind[k].parts += 1;
    byKind[k].chars += p.chars;
  }
  const projectedChars = parts.reduce((n, p) => n + (p.clientScope.length ? p.chars : 0), 0);

  return {
    manifest: {
      schema: 'claude-md-part-manifest/1',
      sourcePath: 'CLAUDE.md',
      docId: 'claude-md',
      contentMode: 'composed', // migration 781 / D-010: parts are canonical, the file is output
      snapshotSha256: createHash('sha256').update(text).digest('hex'),
      // Named units, because `wc -c` (bytes) and String.length disagree by ~1.5k on this file.
      snapshotChars: text.length,
      snapshotBytes: Buffer.byteLength(text, 'utf8'),
      snapshotLines: lines.length,
      generatedBy: 'scripts/gen-claude-md-manifest.mjs (P-014, claude-md-projection-from-pg-2026-08-10)',
      summary: { byKind, projectedChars, totalParts: parts.length, needsReview: needsReview.length },
      parts,
    },
    problems,
    needsReview,
    departed,
  };
}

// ── CLI ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;

  // --bootstrap re-derives the classification from the line-anchored RANGES. That is valid ONLY
  // at the snapshot RANGES was drawn on; every other run carries classification by content.
  const bootstrap = argv.includes('--bootstrap');
  const text = readFileSync(SOURCE, 'utf8');
  const prior = bootstrap ? null : JSON.parse(readFileSync(out, 'utf8'));
  const { manifest, problems, needsReview, departed } = buildManifest(text, prior);
  const { byKind, projectedChars, totalParts } = manifest.summary;

  console.log(`gen-claude-md-manifest: ${totalParts} parts from ${manifest.snapshotChars} chars ` +
              `(${manifest.snapshotBytes} bytes) / ${manifest.snapshotLines} lines` +
              `${bootstrap ? '  [bootstrap: classifying from RANGES]' : ''}`);
  for (const k of ['invariant', 'pointer', 'recipe', 'prose', 'UNCLASSIFIED']) {
    const v = byKind[k] ?? { parts: 0, chars: 0 };
    if (!v.parts && k === 'UNCLASSIFIED') continue;
    const pct = ((100 * v.chars) / manifest.snapshotChars).toFixed(1);
    console.log(`  ${k.padEnd(12)} ${String(v.parts).padStart(3)} parts  ${String(v.chars).padStart(7)} chars  (${pct}%)`);
  }
  console.log(`  projected    ${projectedChars} chars (${((100 * projectedChars) / manifest.snapshotChars).toFixed(1)}%)`);

  if (departed.length) {
    console.log(`\nℹ ${departed.length} classified block(s) no longer present (edited or removed) — their classification retires with them:`);
    for (const d of departed.slice(0, 10)) console.log(`   ${d.kind.padEnd(9)} ${d.partKey}`);
    if (departed.length > 10) console.log(`   ... and ${departed.length - 10} more`);
  }
  if (needsReview.length) {
    console.error(`\n✗ ${needsReview.length} block(s) UNCLASSIFIED — new or edited text the classification has never seen.`);
    console.error('  Classify each against the P-002 map, then re-run. Do NOT let them inherit a neighbour:');
    console.error('  a block that merely MOVED keeps its sha and never appears here, so anything listed is genuinely new text.');
    for (const n of needsReview.slice(0, 15)) console.error(`   L${String(n.line).padStart(4)} ${n.blockSha}  ${n.head}`);
    if (needsReview.length > 15) console.error(`   ... and ${needsReview.length - 15} more`);
  }
  for (const p of problems) console.error(`✗ ${p}`);

  const bad = needsReview.length > 0 || problems.length > 0;
  if (!checkOnly && !bad) {
    writeFileSync(out, `${JSON.stringify(manifest, null, 1)}\n`);
    console.log(`\n✓ wrote ${out}`);
  } else if (!checkOnly && bad) {
    console.error('\n✗ refusing to write a manifest built on an incomplete classification.');
  } else if (!bad) {
    console.log('\n✓ classification is current (--check: nothing written)');
  }
  process.exit(bad ? 1 : 0);
}
