#!/usr/bin/env node
/**
 * check-no-bespoke-state-read.mjs — the ADOPTION GATE for the agent state plane.
 * Plan `unified-agent-state-plane-2026-07-27` (P-005), enforcing D-010.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL, AND WHY IT SHIPS *WITH* THE REGISTRY
 *
 * D-010 makes this gate a PRECONDITION of the cell registry (P-003), not a
 * follow-up. The reason is measured, not hypothetical: `predicate_watches` is
 * shipped, correct in principle, and has NEVER been adopted — 0 rows across all
 * tenants, active and inactive, verified 2026-07-27. A registry nobody registers
 * into is not neutral; it is surface #29 and strictly WORSE than today, because
 * it adds a place to look without removing one.
 *
 * So the registry's value does not come from existing. It comes from being the
 * cheapest path when an author reaches for a new state read. This gate is what
 * puts the registry on that path: the moment someone mints a NEW state-read tool,
 * they must say — in the file, mechanically checked — whether it is a lens on a
 * cell or why it is not one.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * THE POSTURE (modelled on `lint:no-raw-setinterval`, P-007/P-008)
 *
 * Same three-part shape, deliberately:
 *   1. a PURE, unit-tested predicate (so "it fails on a NEW violation" is a
 *      verified property, not merely green-on-a-clean-tree);
 *   2. a GATING failure on anything new (exit 1, in CI);
 *   3. a SHRINK-ONLY BASELINE grandfathering what already exists.
 *
 * ⚠ ONE DELIBERATE ASYMMETRY vs the setInterval guard. That guard's BASELINE is
 * EMPTY today because P-008 migrated all 74 sites first. This one CANNOT be empty
 * yet: retiring the existing bespoke state reads is P-020 (D-018 A.3), which is
 * blocked-by P-007 and has not run. Seeding a non-empty baseline is therefore the
 * honest state, not a weakening — the ratchet property (a NEW violation fails the
 * build) holds from day one either way. P-020 empties it.
 *
 * The baseline is keyed by TOOL NAME, not by file, and that is load-bearing in
 * both directions: a file-keyed baseline would let a NEW state-read tool slip in
 * beside a grandfathered one in the same file, and P-020 retires TOOLS, so a
 * name-keyed baseline is the surface it can actually shrink one entry at a time.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THE DECLARATION IS A COMMENT MARKER AND NOT A `defineTool` FIELD
 *
 * The obvious design — a typed `cell:` field on defineTool — is wrong here, for a
 * reason worth recording so it is not re-proposed. `defineTool` lives in
 * `libs/generic/tooldef`, a domain-free borrowable lib that must not depend on
 * operator-core. A "cell" is a papercusp-domain concept from this plan's D-038;
 * putting it in the generic lib's input type inverts that layering. (It would also
 * trip TS excess-property checking on 700 existing call sites' object literals.)
 *
 * So the declaration is a structured marker inside the `defineTool({ ... })`
 * literal — unambiguous, greppable, and costing the generic lib nothing:
 *
 *     // @cell-lens git.pipelinePosition
 *          → this tool PROJECTS a registered cell. D-038 axis 5 (one derivation,
 *            many lenses): a surface may project or subset a cell, never re-derive
 *            it. This is the intended path.
 *
 *     // @not-a-cell <reason, >= 24 chars>
 *          → an explicit, reasoned exemption. TWO reason-classes are legitimate,
 *            and naming only the first is what made an honest exemption read as a
 *            dishonest one (WI-6464):
 *
 *            (i)  NOT LIVE STATE — a record read, a catalog, a report.
 *            (ii) LIVE STATE, SINGLE DOOR — genuinely current system state, but
 *                 exactly one tool answers the question and nothing re-derives it.
 *                 The VERDICTS map below already calls this "the most important
 *                 reason-class": promoting a single door adds a registry entry
 *                 WITHOUT removing one, which is precisely the D-010 failure
 *                 (`predicate_watches`: shipped, correct, 0 rows, surface #29).
 *                 The registry earns its keep by collapsing DUPLICATED derivations.
 *
 *            So "it is live state" does NOT by itself oblige a `@cell-lens`, and an
 *            author who believes it does will either register a cell nobody reads or
 *            write a false reason. Both are worse than a stated single-door verdict.
 *
 * The exemption is what stops this gate from blocking legitimate non-cell reads
 * that trip the signature. It is also the thing most likely to rot into a rubber
 * stamp — which is the measured failure of `check-generic-first.mjs` (advisory,
 * ALLOW set, nobody looks). Two mechanical defences: a reason SHORTER than
 * MIN_EXEMPTION_REASON is refused outright, and every exemption is COUNTED and
 * printed on success, so growth is visible rather than silent.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * LIMITS OF THE SIGNATURE — stated, because a gate that oversells itself is worse
 * than one that does not exist.
 *
 * `isStateReadCandidate` is a SYNTACTIC signature over the tool's name and
 * capability. It cannot know semantically whether "a cell would serve". It was
 * calibrated against the real corpus (700 defineTool call sites, 2026-07-27) and
 * selects 35 — ~11% of the 294 read-capability tools — closely matching the ~28
 * bespoke state reads this plan counted independently. That agreement is the
 * evidence the signature is aimed at the right population; it is NOT proof of
 * completeness. It WILL miss a state read with an unremarkable name
 * (`dev:pg_active_queries` is one). Those are P-007/P-020's job to find
 * semantically. This gate's guarantee is narrower and precise: the state reads it
 * DOES name cannot grow silently.
 *
 * Nor does it verify that a `@cell-lens` id is actually REGISTERED — cells
 * register at runtime, in their owners' modules, so a static scanner cannot see
 * the map. It checks the id is well-formed only.
 *
 * And it scans `git ls-files`, so a brand-new tool file is invisible until it is
 * TRACKED: an author who runs this locally seconds after creating the file gets a
 * false green. That is inherited from the setInterval guard and is acceptable for
 * the gating path it protects — git-sync commits this tree continuously and CI
 * runs on committed code, so the window closes on its own — but it does mean a
 * local green is not proof, and CI's verdict is the one that counts.
 *
 *   node scripts/check-no-bespoke-state-read.mjs
 */
import { isLiveCodeAt, stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { presentOnDisk } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Where the bare-node guard reads agent-tool declarations. Its independent
 * coverage test derives the production source set from the real registry import
 * graph and proves every graph-reachable tool file falls under one of these roots.
 *
 * ⚠ THIS LIST USED TO NAME ONLY THE FIRST TWO, and that is a false-clean waiting
 * to happen: a state-read tool declared in an unscanned root is never judged, and
 * the gate reports a clean run having never looked at it. "Found nothing" and
 * "looked nowhere" are the same output. (Measured 2026-08-03 when it was widened:
 * ZERO state-read candidates actually lived in the two missing roots, so nothing
 * had escaped yet — this closes a latent hole, it did not have a live miss. The
 * identical defect DID bite for real in the sibling gate `scout/coord-tier-gate.ts`,
 * whose first draft hand-listed two roots, reported a confident 0 offenders, and
 * was blind to all four coordination verbs in `lib/coord-ops`.)
 *
 * ⚠ IT MUST STAY HAND-LISTED HERE — importing the TypeScript graph builder is
 * unavailable because this guard runs as bare
 * `node scripts/check-no-bespoke-state-read.mjs` (package.json `lint:no-bespoke-state-read`),
 * with no TypeScript transform. What makes the list safe is the graph-derived
 * source/file and candidate parity in `no-bespoke-state-read-guard.test.ts`, not a
 * comparison against a second hand-written directory list.
 */
export const SCAN_DIRS = [
  'packages/operator-core/lib/agent-tools',
  'packages/agent-mcp/src',
  'packages/operator-core/lib/coord-ops',
];

/**
 * Nouns that mark a "what is the CURRENT STATE of X?" question rather than a
 * "give me the record for X" question. Derived from the corpus, not invented:
 * these are the tokens the existing bespoke state reads actually use.
 */
export const STATE_NOUNS = [
  'status',
  'health',
  'state',
  'position',
  'presence',
  'inventory',
  'ports',
  'processes',
  'running',
  'capacity',
  'usage',
  'uptime',
  // EI-18791777695307535 — widened from the measured corpus (tool_invocations, 30d,
  // 2026-07-27): the original list missed `fleet:assignments` (5,883 calls/30d, the
  // single busiest live-state read in the system, ~9x coord:presence) and several
  // other real state-read doors, because none of their names contained an original
  // STATE_NOUN token. This is a STOPGAP (option 1 of that bug's 3 suggested fixes):
  // it chases the corpus rather than detecting the *shape* of a state read, and will
  // still miss the next unremarkably-named one (`blender:success-metrics`,
  // `facts:list`, `pot:get`, `dev:pg_active_queries` — none of these contain any noun
  // in this list either). The evidence-based real fix (select on measured call
  // volume from `tool_invocations` rather than on the name) is filed as a follow-up:
  // WI-6487.
  'assignments',
  'roster',
  'walls',
  'conditions',
  'locks',
  'burn_down',
];

export const STATE_NOUN_RE = new RegExp(`(^|[:_-])(${STATE_NOUNS.join('|')})([:_-]|$)`);

/**
 * Verb prefixes that mark a MUTATION. Needed because the state nouns above appear
 * in write verbs too — `work_items:set_state` and `processes:kill` both match the
 * noun signature and neither is a state read.
 */
export const MUTATING_VERBS = [
  'set', 'kill', 'create', 'delete', 'remove', 'update', 'start', 'stop',
  'pause', 'resume', 'arm', 'disarm', 'emit', 'send', 'write', 'clear',
  'reset', 'restart', 'promote', 'retract', 'cancel', 'apply', 'install',
  'uninstall', 'publish', 'revoke', 'grant', 'ack', 'assign', 'claim',
  // WI-6464 backstop pass. `freeze`/`limit` are the two that actually bit (a
  // cgroup freeze and a live re-budget both read as state reads for hours); the
  // rest come from auditing the tree's mutating verbs that carry a state noun.
  // ⚠ This list is the BACKSTOP, never the mechanism — see capabilityEffect().
  'freeze', 'thaw', 'limit', 'throttle', 'drain', 'park', 'couple', 'decouple',
  'admit', 'wake',
];

/** Does the verb half of `group:verb` begin with a mutating verb? */
export function isMutatingVerb(verb) {
  return MUTATING_VERBS.some((v) => verb === v || verb.startsWith(`${v}_`) || verb.startsWith(`${v}-`));
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * THE DECLARED-EFFECT ORACLE — a MIRROR of `inferCapabilityEffect` in
 * `libs/generic/tooldef/src/define-tool.ts`, which is what `defineTool` itself
 * applies to every tool in the tree.
 *
 * WHY MIRRORED RATHER THAN IMPORTED. This is a plain `.mjs` CI gate: it must run
 * with bare `node`, before any build, with no TS loader — so it cannot import the
 * TS module that owns this knowledge. Copying it is therefore forced, and copied
 * knowledge drifts.
 *
 * So the copy is PINNED, not trusted: `no-bespoke-state-read-guard.test.ts`
 * imports tooldef's exported set and this one and asserts they are identical. A
 * capability added there and not here reds that unit test immediately — which is
 * the whole difference between this and the hand-maintained MUTATING_VERBS list
 * that caused WI-6464 in the first place.
 */
export const WRITE_CAPABILITY_SUFFIXES = [':write', ':admin', ':delete', ':manage', ':execute'];
export const WRITE_CAPABILITIES = new Set([
  'capability:bash',
  'capability:fs-write',
  'capability:edit',
  'capability:write',
  'capability:git',
  'capability:computer',
  'capability:net',
  'capability:terminal',
  'processes:kill',
  'processes:control',
  'turn:interrupt',
  'ui:dispatch',
  'tui:dispatch',
  'operator:converse',
  'activity:report',
  // WI-10004595: fleet-registry control verbs + coord:mark-terminal + testing:run.
  'fleet:create',
  'fleet:join',
  'fleet:leave',
  'fleet:take-leadership',
  'fleet:resume',
  'fleet:pause',
  'fleet:wind-down',
  'fleet:supersede',
  'fleet:headcount-target',
  'fleet:request_remote_spawn',
  'fleet:recolor',
  'fleet:reconfigure-member',
  'fleet:respawn-member',
  'coord:mark-terminal',
  'testing:run',
]);

/** `capability -> 'read' | 'write'`, exactly as `defineTool` resolves it. */
export function capabilityEffect(capability) {
  const cap = String(capability).toLowerCase();
  if (WRITE_CAPABILITIES.has(cap)) return 'write';
  return WRITE_CAPABILITY_SUFFIXES.some((s) => cap.endsWith(s)) ? 'write' : 'read';
}

/**
 * THE PREDICATE. Pure ({ name, capability } -> boolean) so the "flags a NEW state
 * read / does not flag a mutation or a record read" property is unit-testable
 * without executing a tree scan.
 *
 * Two independent tests, in this order, and the order is the fix for WI-6464:
 *
 *  1. the DECLARED EFFECT (structural). If the tool declares a capability, ask the
 *     same oracle `defineTool` asks. A capability the platform treats as mutating
 *     is not a state read, whatever the tool is named. This is what `:write`-suffix
 *     matching used to approximate and got wrong: `processes:freeze` and
 *     `processes:limit` declare `processes:control` — a control capability that
 *     tooldef has classified as a WRITE since 2026-06-20 — so the gate reported two
 *     mutations as undeclared state reads while the authoritative answer sat one
 *     lib away.
 *  2. the mutating-verb list (backstop). Catches an undeclared-capability mutation,
 *     which (1) cannot see.
 *
 * ⚠ The effect test deliberately reads "is a declared WRITE" rather than "is a
 * declared READ". An is-a-read conjunction would be a coverage regression, and a
 * MEASURED one — `fleet:status` declares `capability: 'fleet:status'`, which is
 * neither a read nor a write name, and it is a genuine grandfathered state read
 * (P-020 verdict: `delegates`). Requiring a read capability drops it, and drops it
 * SILENTLY, into a non-fatal "stale baseline entry" note. Same argument holds for
 * a tool declaring no capability at all: `coord:presence`, the canonical presence
 * cell and the surface D-038 axis 5 cites as its model, is the one this plane is
 * built around. Not-a-write keeps both; is-a-read loses both.
 */
export function isStateReadCandidate({ name, capability }) {
  if (!name || !name.includes(':')) return false;
  const verb = name.slice(name.indexOf(':') + 1);
  if (capability && capabilityEffect(capability) === 'write') return false;
  if (isMutatingVerb(verb)) return false;
  return STATE_NOUN_RE.test(name);
}

/**
 * Runtime volume is an ADVISORY second signal, not a replacement for the static
 * gate above. A fresh CI database has no meaningful agent telemetry, and a busy
 * tool can be a report/read without being live state. The floors therefore select
 * a review corpus; they do not assert that a selected tool is a cell candidate.
 *
 * The values are deliberately small relative to the measured 30-day corpus. Five
 * calls from three distinct agent callers is enough to distinguish a real shared
 * surface from a one-off probe while keeping the report useful for low-volume
 * doors such as `dev:pg_active_queries`.
 */
export const VOLUME_WINDOW_DAYS = 30;
export const VOLUME_MIN_CALLS = 5;
export const VOLUME_MIN_DISTINCT_CALLERS = 3;

/** Pure floor predicate, kept separate so calibration can be tested without PG. */
export function meetsVolumeFloor(
  { calls, callers },
  { minCalls = VOLUME_MIN_CALLS, minDistinctCallers = VOLUME_MIN_DISTINCT_CALLERS } = {},
) {
  const callCount = Number(calls);
  const callerCount = Number(callers);
  return (
    Number.isFinite(callCount) &&
    Number.isFinite(callerCount) &&
    callCount >= minCalls &&
    callerCount >= minDistinctCallers
  );
}

/**
 * Select unmarked, read-shaped tools from measured runtime rows. The result is
 * intentionally named `candidates`: volume cannot prove the semantic state-read
 * question, so this report must never turn a noisy corpus into a CI failure.
 */
export function findVolumeCandidates(rows, definitions, options = {}) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return rows
    .map((row) => {
      const definition = byName.get(row.toolName ?? row.tool_name);
      if (!definition) return null;
      const verb = definition.name.slice(definition.name.indexOf(':') + 1);
      if (definition.capability && capabilityEffect(definition.capability) === 'write') return null;
      if (isMutatingVerb(verb) || definition.lens != null || definition.exemption != null) return null;
      if (!meetsVolumeFloor(row, options)) return null;
      const calls = Number(row.calls);
      const callers = Number(row.callers ?? row.distinctCallers);
      return {
        name: definition.name,
        file: definition.file,
        calls,
        callers,
        callsPerCaller: callers > 0 ? Number((calls / callers).toFixed(2)) : null,
        syntacticCandidate: isStateReadCandidate(definition),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.calls - a.calls || b.callers - a.callers || a.name.localeCompare(b.name));
}

/**
 * Keep the volume leg explicitly non-vacuous. A fresh or unavailable telemetry
 * table is UNKNOWN, not "no candidates" and never a passing report.
 */
export function volumeReportStatus({ totalCalls } = {}) {
  const total = Number(totalCalls);
  if (!Number.isFinite(total) || total <= 0) {
    return {
      status: 'no-data',
      label: 'UNKNOWN',
      known: false,
      totalCalls: 0,
      exitCode: 1,
    };
  }
  return {
    status: 'observed',
    label: 'OBSERVED',
    known: true,
    totalCalls: total,
    exitCode: 0,
  };
}

/** Format the advisory volume report without turning it into a static-gate failure. */
export function formatVolumeReport({
  workspaceId = 'unknown',
  harnessSlug = 'unknown',
  windowDays = VOLUME_WINDOW_DAYS,
  totalCalls,
  candidates = [],
} = {}) {
  const status = volumeReportStatus({ totalCalls });
  const lines = [
    `NO-BESPOKE STATE-READ VOLUME REPORT — ${windowDays}d`,
    `scope: workspace=${workspaceId} harness=${harnessSlug}`,
  ];

  if (!status.known) {
    lines.push(
      `  ${status.label} (no-data): the scoped agent tool_invocations corpus is empty or unavailable; ` +
        'volume evidence is not a passing result.',
    );
    lines.push('  exit status: 1');
    return lines.join('\n');
  }

  lines.push(`  ${status.label}: ${status.totalCalls} agent invocation(s) observed.`);
  if (candidates.length === 0) {
    lines.push('  no volume candidates crossed the review floor.');
  } else {
    lines.push(`  ${candidates.length} read-shaped volume candidate(s):`);
    for (const candidate of candidates) {
      const callers = `${candidate.callers} caller(s)`;
      const rate = candidate.callsPerCaller == null ? 'n/a' : `${candidate.callsPerCaller} calls/caller`;
      const marker = candidate.syntacticCandidate ? ' · name-signature match' : '';
      lines.push(`    ${candidate.name} — ${candidate.calls} call(s) · ${callers} · ${rate}${marker}`);
      if (candidate.file) lines.push(`      ${candidate.file}`);
    }
  }
  lines.push('  exit status: 0 (advisory; the static gate remains authoritative)');
  return lines.join('\n');
}

/** Query the agent-only volume corpus used by the optional advisory report. */
export async function fetchVolumeReport({
  sql,
  workspaceId,
  harnessSlug,
  windowDays = VOLUME_WINDOW_DAYS,
}) {
  if (!sql) throw new TypeError('fetchVolumeReport requires a postgres client');
  const [totalRow] = await sql`
    SELECT count(*)::int AS total_calls
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
       AND invoked_at >= now() - make_interval(days => ${windowDays})
  `;
  const rows = await sql`
    SELECT tool_name,
           count(*)::int AS calls,
           count(DISTINCT coord_owner_id)::int AS callers
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
       AND invoked_at >= now() - make_interval(days => ${windowDays})
     GROUP BY tool_name
     ORDER BY count(*) DESC, tool_name ASC
  `;
  return {
    totalCalls: totalRow?.total_calls ?? totalRow?.totalCalls ?? 0,
    rows,
  };
}

/** `@cell-lens <dotted.cell.id>` — the intended path. */
export const CELL_LENS_RE = /@cell-lens\s+(\S+)/;
/** A well-formed cell id: dotted, lowerCamel segments (matches CellSpec.cell). */
export const CELL_ID_RE = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
/** `@not-a-cell <reason>` — the reasoned exemption. */
export const NOT_A_CELL_RE = /@not-a-cell\s+([^\n]+)/;
/** A reason shorter than this is a rubber stamp, not a reason. */
export const MIN_EXEMPTION_REASON = 24;

/** How far into a `defineTool({` literal to look. Clamped to the next call site. */
const HEAD_WINDOW = 6000;

/**
 * Parse a source file into its tool declarations. Pure (text -> rows).
 *
 * The attributed region for each tool starts AT its `defineTool({` and ends at
 * whichever comes first: HEAD_WINDOW chars, or the next `defineTool` in the file.
 * That makes marker ownership unambiguous in multi-tool files — the marker belongs
 * to the literal that contains it — which is why the marker must be written INSIDE
 * the object literal rather than in the doc comment above it.
 *
 * @param {string} text
 * @param {string} [fileName]  BRACKETS ARE THE CONTRACT — they are what makes this optional to
 *        TypeScript. Six existing call sites in no-bespoke-state-read-guard.test.ts pass a single
 *        argument, and without the brackets every one of them fails with TS2554.
 * @returns {Array<{name:string, capability:string|null, lens:string|null, exemption:string|null}>}
 */
export function parseToolDefs(text, fileName) {
  const out = [];
  const re = /defineTool\s*\(\s*\{/g;
  // MATCH ON RAW, VALIDATE THE ANCHOR AGAINST THE MASK. `defineTool(` written in a doc comment
  // or quoted inside a template literal is PROSE, not a tool — but the fields this parser reads
  // (`name:`, `capability:`) are themselves STRING VALUES, so masking strings before matching
  // would delete the evidence and the guard would find nothing at all. Asking instead whether
  // the `defineTool` token itself is live program text satisfies both halves.
  //
  // MEASURED before the fix (WI-37717): a `defineTool({ name: 'dev:status', capability:
  // 'intel:read' })` appearing ONLY in a line comment, a block comment, or a template literal
  // each produced a full `undeclared-state-read` VIOLATION — not merely a stray parse. This
  // guard is CI-wired, so that is the fleet-gate-reddening phantom class this whole family of
  // fixes exists to stop, recurring in a guard that the guard-of-guards could not even see.
  //
  // The mask is computed LAZILY on the first match: blanking is MONOTONIC (it can only remove a
  // match, never create one), so a file with no `defineTool(` never pays for a TS parse — and
  // this guard reads ~1500 .ts files per run.
  let masked = null;
  let m;
  while ((m = re.exec(text))) {
    masked ??= stripCommentsAndStrings(text, fileName);
    if (!isLiveCodeAt(text, masked, m.index)) continue;
    const next = text.indexOf('defineTool', m.index + 1);
    const end = next === -1 ? Math.min(text.length, m.index + HEAD_WINDOW) : Math.min(next, m.index + HEAD_WINDOW);
    const region = text.slice(m.index, end);
    const name = region.match(/\bname:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    if (!name) continue;
    const capability = region.match(/\bcapability:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    out.push({
      name,
      capability,
      lens: region.match(CELL_LENS_RE)?.[1] ?? null,
      exemption: region.match(NOT_A_CELL_RE)?.[1]?.trim() ?? null,
    });
  }
  return out;
}

/**
 * Judge one parsed tool. Pure (row -> null | { rule, detail }). Split out from the
 * scan so every branch is unit-testable.
 */
export function judgeToolDef(row) {
  if (!isStateReadCandidate(row)) return null;
  if (row.lens !== null) {
    return CELL_ID_RE.test(row.lens)
      ? null
      : { rule: 'cell-lens-malformed', detail: `@cell-lens "${row.lens}" is not a well-formed cell id (expected dotted lowerCamel, e.g. git.pipelinePosition).` };
  }
  if (row.exemption !== null) {
    return row.exemption.length >= MIN_EXEMPTION_REASON
      ? null
      : { rule: 'exemption-unreasoned', detail: `@not-a-cell needs a real reason (>= ${MIN_EXEMPTION_REASON} chars); got ${row.exemption.length}: "${row.exemption}".` };
  }
  return {
    rule: 'undeclared-state-read',
    detail: 'a NEW state-read tool must declare its relationship to the cell registry.',
  };
}

/**
 * BASELINE — grandfathered bespoke state reads, keyed by TOOL NAME. SHRINK-ONLY.
 *
 * Seeded 2026-07-27 from the signature applied to the tree at seed time, so it is
 * self-consistent by construction and did NOT need P-007's semantic inventory to
 * exist first (P-007 is not done; P-020, which retires these, is blocked on it).
 *
 * ⚠ Do NOT add entries. A NEW state-read tool is a hard failure — declare
 * `@cell-lens` or a reasoned `@not-a-cell` instead. P-020 removes entries from
 * here as it retires each tool onto a cell; the goal state is empty.
 */
/**
 * The date by which the BASELINE must be EMPTY (i.e. P-020 has retired the
 * grandfathered reads onto cells). Past this date, a non-empty baseline FAILS.
 *
 * Shrink-only is not self-enforcing: a baseline with no deadline is just a
 * permanent exemption list that happens to be sorted, and this repo has already
 * watched that specific rot happen — `KNOWN_DARK_FLAGS` became a parking lot for
 * finished work and its ceiling got quietly raised 22 -> 24 -> 25 -> 26 for the
 * same bug class. The countermeasure that worked there was an expiring
 * `DARK_FLAGS_REVIEW_BY`, so this mirrors it deliberately.
 *
 * ⚠ If you are here because the gate just went red on this: the fix is P-020
 * (retire the tools onto cells), or an explicit, recorded decision to move the
 * date. It is NOT to delete the check.
 */
export const BASELINE_REVIEW_BY = '2026-10-25';

export const BASELINE = new Set([
  'accounts:link-status',
  'accounts:status',
  'autoloop:status',
  'autonomy:graduation_status',
  // ── EI-18791777695307535 — SECOND SEEDING WAVE (2026-07-27). The STATE_NOUNS
  // widening above (assignments/roster/walls/conditions/locks/burn_down) makes these
  // 8 PRE-EXISTING tools trip the signature for the FIRST time — they are not new
  // work, exactly like the original 2026-07-27 seed was "the signature applied to the
  // tree at seed time". Each carries a VERDICTS entry below with the same evidence
  // discipline as the original set.
  'coord:conditions',
  'coord:presence',
  'coord:roster',
  'coord:walls',
  'curation:state-of-pot',
  'deploy:status',
  'dev:build_status',
  'dev:dogfood_substrate_status',
  'dev:listening_ports',
  'dev:pg_health',
  // dev:pipeline_position — RETIRED FROM THE BASELINE 2026-07-27 (P-020, the first
  // shrink). It now declares `@cell-lens git.pipelinePosition`, so the gate accepts it
  // on the intended path and it no longer needs grandfathering. Its verdict survives in
  // VERDICTS with `adopted` set. 38 -> 37.
  'dev:processes',
  'dev:rate_governor_status',
  'dev:service_health',
  'dev:stall_waker_status',
  'dev:state_counter',
  'egress:health',
  'events:status',
  'fleet:assignments',
  'fleet:capacity',
  'fleet:status',
  'gateway:status',
  'harness:health',
  'harness:status',
  'improvements:watchdog-status',
  'locks:check_command',
  'locks:list',
  'locks:queue',
  'operator:credentials_status',
  'operator:trigger_state',
  'plan_items:status',
  'plugins:runtime_status',
  'pot:status',
  'schedule:inventory',
  'scheduler:running',
  'setup:status',
  'storage:usage',
  'ui:get_state',
  'voice:status',
  'watchdog:status',
  'work_items:burn_down',
  'work_items:redundancy_status',
]);

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * VERDICTS — P-020 (D-018 A.3): the per-tool disposition of every grandfathered read.
 *
 * WHY THIS LIVES HERE AND NOT IN A DOCUMENT. P-020's deliverable is an inventory with
 * a verdict on every entry. Written as a doc it would be a snapshot that drifts from
 * BASELINE the first time BASELINE changes — and drift is the whole failure this plan
 * exists to fix. Keyed to the SAME set the gate enforces, the verdict cannot drift:
 * `verdictGaps()` makes "every entry has a verdict" a MECHANICAL property, checked in
 * CI, and retiring a tool deletes it from both maps or the check fails.
 *
 * THE THREE VERDICTS are deliberately non-overlapping, and they are the D-038 axis-5
 * distinction ("one derivation, many lenses") applied per tool:
 *
 *   'cell'      — this tool OWNS a live-state derivation that other surfaces re-derive.
 *                 Register the cell(s) here; the tool becomes a declared `@cell-lens`
 *                 over its own resolver. These are the RESOLVERS.
 *   'delegates' — this tool RE-DERIVES a value another tool owns. It must CONSUME the
 *                 cell instead of computing its own answer. These are the duplication
 *                 sites, and therefore the refactor/retirement candidates.
 *   'bespoke'   — stays as it is, with a stated reason.
 *
 * ⚠ THE MOST IMPORTANT REASON-CLASS IS 'single door'. A read can be genuinely live
 * state and STILL correctly stay bespoke: if exactly one tool answers the question and
 * nothing re-derives it, promoting it to a cell adds a registry entry without removing
 * a door — which is precisely the D-010 failure (`predicate_watches`: shipped, correct,
 * 0 rows, surface #29). The registry earns its keep by collapsing DUPLICATED doors, not
 * by cataloguing every read. A dead read (0 calls/30d) is likewise never promoted:
 * registering a value nobody asks for is that same failure at cell scale.
 *
 * Verdicts assigned 2026-07-27 from measured evidence, not taste — `tool_invocations`
 * call volume over 30d (`calls`, with the distinct-caller count in the reason where it
 * carries the argument) crossed with the resolver-eligibility constraints. `calls` is a
 * DATED OBSERVATION, not a live value: it is here to show the verdict's grounding, and
 * a stale count never changes what the gate does.
 */
export const VERDICT_KINDS = ['cell', 'delegates', 'bespoke'];

export const VERDICTS = new Map([
  // ── Cluster A — "can I get inference capacity right now?" (6 doors, 431 calls/30d)
  ['fleet:capacity', { verdict: 'cell', cluster: 'capacity', calls: 144,
    reason: 'Owns the gateway /stats capacity derivation (spare slots = cap − inFlight − queued). Register inference.capacity.spareSlots + inference.pool.healthyAccounts as global cells here; gateway:status and dev:rate_governor_status then consume them instead of re-reading the same oracle.' }],
  ['accounts:status', { verdict: 'cell', cluster: 'capacity', calls: 179,
    reason: 'Owns per-account rate-limit state; 179 calls across 179 distinct callers — one read per agent, the orientation shape. Register account.available as a parameter-relative cell keyed by account id.' }],
  ['gateway:status', { verdict: 'delegates', cluster: 'capacity', calls: 34,
    reason: 'Re-presents the SAME gateway /stats oracle fleet:capacity owns. Keep the per-tier admission detail and nextVerb; consume inference.capacity.* rather than deriving a second answer to one question.' }],
  ['dev:rate_governor_status', { verdict: 'delegates', cluster: 'capacity', calls: 70,
    reason: 'Its paused-buckets and effective-vs-configured concurrency overlap the admission state above. AIMD detail stays bespoke; the shared values delegate.' }],
  ['egress:health', { verdict: 'bespoke', cluster: 'capacity', calls: 4,
    reason: 'An ACTIVE PROBE, not a standing value: builds a dispatcher and echoes the exit IP per provider allocation. A cell caches a value others read; this one must be performed to be true.' }],
  ['accounts:link-status', { verdict: 'bespoke', cluster: 'capacity', calls: 0,
    reason: 'A one-shot poll of a held OAuth link flow, keyed to a single linkId. Flow-scoped and single-consumer — never shared state. 0 calls/30d.' }],
  ['setup:status', { verdict: 'bespoke', cluster: 'capacity', calls: 0,
    reason: 'Owner-facing Setup-Wizard step aggregation, not agent state. 0 calls/30d — promoting a read nobody makes is the D-010 failure.' }],

  // ── Cluster B — "who is alive / on what?" (the largest cluster)
  ['coord:presence', { verdict: 'cell', cluster: 'presence', calls: 648,
    reason: 'Owns the unified presence oracle (presence-derivation-unification-2026-07-17) and is the surface D-038 axis 5 cites as its model. 648 calls / 635 distinct callers ≈ one per agent. Register agent.sessionState (parameter) + fleet.wakeable (global); the derivation is already unified, only the cell face is missing.' }],
  ['fleet:status', { verdict: 'delegates', cluster: 'presence', calls: 263,
    reason: 'Re-derives member liveness that coord:presence owns. Requires `fleet` ⇒ parameter relativity. Keep the fleet identity/roster split; consume agent.sessionState for the liveness verdict.' }],
  ['scheduler:running', { verdict: 'delegates', cluster: 'presence', calls: 35,
    reason: 'Bee-run liveness re-derives both presence and claim state. The live-execution join is worth keeping; the two inputs should be read as cells.' }],
  ['plan_items:status', { verdict: 'delegates', cluster: 'presence', calls: 17,
    reason: 'Explicitly merges the DURABLE assignment with the LIVE claim. The durable half is a record read and stays; the live-claim half must delegate rather than re-derive.' }],

  // ── Cluster C — "is my code live?" (already the 5 registered cells)
  ['dev:pipeline_position', { verdict: 'cell', cluster: 'pipeline', calls: 310,
    reason: 'ALREADY the resolver behind all five registered cells (git.pipelinePosition, gate.greenCheckpoint.verdict/.candidate, deploy.3070.sha, git.mainBehindStaging). Owed only its `@cell-lens` declaration; P-007 already made its no-arg call legal so global cells resolve.',
    adopted: 'Declared `@cell-lens git.pipelinePosition` and removed from BASELINE on 2026-07-27 — the first entry P-020 retired, taking the grandfather list 38 -> 37.' }],
  ['dev:build_status', { verdict: 'delegates', cluster: 'pipeline', calls: 46,
    reason: 'Local build mtime + server reachability duplicates dev:service_health probing and the serving leg of git.pipelinePosition. Consume both rather than answering a third time.' }],
  ['deploy:status', { verdict: 'bespoke', cluster: 'pipeline', calls: 34,
    reason: 'NOT the same question as deploy.3070.sha despite the name: this reads a HARNESS deployment record + its frame handle, not the operator release pipeline. Conflating them by name similarity is the error to avoid; single door, no re-derivation.' }],

  // ── Cluster D — "is the box / service healthy?"
  ['dev:service_health', { verdict: 'cell', cluster: 'host-health', calls: 134,
    reason: 'Owns the dev-service probe (:3070/:3170/:3055/… + supervisor flap state); 134 calls / 126 callers. Register service.up as a parameter-relative cell so dev:build_status and setup wizards stop re-probing.' }],
  ['dev:pg_health', { verdict: 'bespoke', cluster: 'host-health', calls: 14,
    reason: 'Single door: nothing else derives PG version/connection counts. Live state, but registering it adds a registry entry without removing a door (D-010).' }],
  ['dev:processes', { verdict: 'bespoke', cluster: 'host-health', calls: 7,
    reason: 'Deliberately narrow inventory of six tracked agent process kinds; single door, no duplication.' }],
  ['dev:listening_ports', { verdict: 'bespoke', cluster: 'host-health', calls: 0,
    reason: 'Single door for the ss/lsof answer; 0 calls/30d. No shared demand to justify a cell.' }],
  ['dev:dogfood_substrate_status', { verdict: 'bespoke', cluster: 'host-health', calls: 13,
    reason: 'Hyperbee substrate diagnostic mirroring one admin route; single door, single consumer.' }],
  ['harness:health', { verdict: 'delegates', cluster: 'host-health', calls: 1,
    reason: 'Consolidated per-harness verdict overlapping harness:status. Requires `slug` ⇒ parameter relativity. One harness-state derivation should serve both.' }],
  ['storage:usage', { verdict: 'bespoke', cluster: 'host-health', calls: 1,
    reason: 'Sizing/trim-safety report over PG tables and on-disk stores — an analytic rollup, not a live-state value agents coordinate on.' }],

  // ── Cluster E — "is the background machinery running?"
  ['events:status', { verdict: 'cell', cluster: 'machinery', calls: 121,
    reason: 'Owns await/wake state and is natively CALLER-RELATIVE ("your active awaits") — the axis-3 shape the cell contract was built for. 121 calls / 121 distinct callers: exactly one per agent.' }],
  ['schedule:inventory', { verdict: 'bespoke', cluster: 'machinery', calls: 27,
    reason: 'A CATALOG of every scheduled thing, not a live-state value — and already the single anti-sprawl door for its own domain. It is the precedent this plan generalises, not a target of it.' }],
  ['autoloop:status', { verdict: 'bespoke', cluster: 'machinery', calls: 23,
    reason: 'Reads autoloop_state rows per harness; single door, no re-derivation elsewhere.' }],
  ['watchdog:status', { verdict: 'bespoke', cluster: 'machinery', calls: 38,
    reason: 'Id-keyed diagnostic that currently supports exactly one watchdog (su-ideate-ungraded). Too narrow to be a shared cell; revisit if it generalises across watchdogs.' }],
  ['improvements:watchdog-status', { verdict: 'bespoke', cluster: 'machinery', calls: 6,
    reason: 'Tick-ledger inspection for one watchdog; a record read over its history, not a current-state value.' }],
  ['dev:stall_waker_status', { verdict: 'bespoke', cluster: 'machinery', calls: 1,
    reason: 'Runtime counters for one poll loop; single door, 1 call/30d.' }],
  ['operator:trigger_state', { verdict: 'bespoke', cluster: 'machinery', calls: 0,
    reason: 'A fingerprint consumed machine-to-machine by the background scanner to decide rescans — not an agent-facing read. 0 agent calls/30d.' }],
  ['plugins:runtime_status', { verdict: 'bespoke', cluster: 'machinery', calls: 0,
    reason: 'Plugin-host introspection; single door, 0 calls/30d.' }],

  // ── Cluster F — "what is the pot / harness doing?"
  ['pot:status', { verdict: 'cell', cluster: 'pot', calls: 202,
    reason: 'Owns the Pot operator state (started/paused, pending wake, floor, watchdog signal); 202 calls / 202 distinct callers — one per agent, the orientation shape. Register pot.started + pot.pendingWake.' }],
  ['harness:status', { verdict: 'delegates', cluster: 'pot', calls: 9,
    reason: 'Phase/status/budget per harness overlaps both pot:status and harness:health. One harness-state derivation, three doors — consume it.' }],
  ['curation:state-of-pot', { verdict: 'bespoke', cluster: 'pot', calls: 14,
    reason: 'A deterministic DIGEST over a corpus (meta-patterns, chronic deferrals) — a computed report about history, not current system state.' }],
  ['autonomy:graduation_status', { verdict: 'bespoke', cluster: 'pot', calls: 0,
    reason: 'Trust-graduation standings computed from the tripwire ledger — a record rollup, and 0 calls/30d.' }],

  // ── Cluster G — local / UI / demo
  ['ui:get_state', { verdict: 'bespoke', cluster: 'local', calls: 13,
    reason: 'Per-browser-tab URL state ("what is the user looking at"). Scoped to one tab/client, never fleet-shared; single door.' }],
  ['operator:credentials_status', { verdict: 'bespoke', cluster: 'local', calls: 2,
    reason: 'Masked set/not-set presence for voice credentials — configuration, not live state.' }],
  ['voice:status', { verdict: 'bespoke', cluster: 'local', calls: 0,
    reason: 'Live voice channel/mute/peers, but 0 calls/30d and no second derivation. No shared demand.' }],
  ['dev:state_counter', { verdict: 'bespoke', cluster: 'local', calls: 0,
    reason: 'A DEMO fixture that ticks a counter to exercise ctx.publishState — not a real state read at all. The one unambiguous outright-deletion candidate in this baseline; it is here only because the name signature catches it.' }],

  // ── Cluster H — work-item hygiene
  ['work_items:redundancy_status', { verdict: 'bespoke', cluster: 'work-items', calls: 1,
    reason: 'An analysis report over work-item overlap, computed on demand; not a standing value anything coordinates on.' }],
  ['work_items:burn_down', { verdict: 'delegates', cluster: 'work-items', calls: 73,
    reason: 'Explicitly documents itself as a rejoin of work_items:list + coord:presence liveness (its own header: "instead of rejoining ... client-side on every wake"). Same merged-durable+live shape as plan_items:status; the leader-facing rollup is worth keeping, but the liveness half should consume a presence cell rather than re-listing it.' }],

  // ── Cluster I — EI-18791777695307535 second seeding wave: fleet/coord/locks doors the
  // widened noun list newly catches. Verdicts assigned 2026-07-27 from reading each tool's
  // own implementation (not call-volume alone, since these were previously unmeasured by
  // this gate's own signature) — `calls` here is the 30d figure from the filing bug's evidence
  // table where available.
  ['fleet:assignments', { verdict: 'delegates', cluster: 'presence', calls: 5883,
    reason: 'THE busiest state read in the corpus (5,883 calls/5,851 callers/30d, ~9x coord:presence) — exactly the shape most worth catching, per the filing bug. Already consumes the SAME unified liveness oracle as coord:presence (deriveVerdict from coordination/liveness-oracle.ts, presence-derivation-unification-2026-07-17) and joins it with its own plan-item/work-item claim data — same merged-durable+live shape as plan_items:status (already delegates). Keep the claim-join; the liveness half already IS the shared oracle, so this mainly needs a @cell-lens declaration once the oracle itself is registered as a cell.' }],
  ['coord:roster', { verdict: 'bespoke', cluster: 'presence', calls: 22,
    reason: 'Explicitly designed AS the future consolidation door for coord:presence/fleet:assignments/fleet:status/coord:glance (its own header proposes the others become thin aliases or deprecate) — not itself a duplication site. Its default view reuses the shared assemblePresenceSnapshot helper directly rather than re-deriving; the other 3 view lenses (members/claims/history) answer genuinely different questions.' }],
  ['coord:walls', { verdict: 'bespoke', cluster: 'presence', calls: 392,
    reason: 'A UNION read over two existing write surfaces (loop:checkpoint walls + needs-human work-items) that previously had no query at all (EI-10890) — filed to close a real blind spot, not a duplicate derivation. Single door.' }],
  ['coord:conditions', { verdict: 'bespoke', cluster: 'presence', calls: 16,
    reason: 'Folds the condition-keyed alarm/resolution broadcast stream into current open/resolved state (EI-6138); single door, nothing else derives this view.' }],
  ['locks:list', { verdict: 'bespoke', cluster: 'locks', calls: 245,
    reason: 'The authoritative registry + live-holder view for NAMED RESOURCE locks (locks:acquire_resource domain, P-013/P-014). Single door for that domain.' }],
  ['locks:queue', { verdict: 'bespoke', cluster: 'locks', calls: 0,
    reason: 'Live holder/waiter view for PATH/FILE locks (locks:acquire domain, backed by su-lock-store) — a distinct lock domain from locks:list\'s named-resource registry. Single door for that domain.' }],
  ['locks:check_command', { verdict: 'bespoke', cluster: 'locks', calls: 0,
    reason: 'A derived VERDICT (allow|warn|block) for a PreToolUse Bash gate, combining live resource-lock state with a bash-substitution registry match into one round-trip a hook makes on every shell command. Not a standing value re-derived elsewhere; single door serving one caller shape.' }],
]);

/**
 * The mechanical form of P-020's done-condition: every grandfathered tool carries a
 * verdict, and no verdict names a tool that is not grandfathered. Pure (-> gaps) so the
 * unit test can assert it without a tree scan.
 */
export function verdictGaps() {
  const missing = [...BASELINE].filter((n) => !VERDICTS.has(n));
  // A verdict MAY name a tool that has left BASELINE — but only if it records HOW it
  // left, in `adopted`. Without that carve-out the inventory would erode exactly as the
  // work succeeded: every retirement deleting the record of what was decided and why.
  // With it, BASELINE shrinks (the ratchet) while VERDICTS accumulates the history.
  const extra = [...VERDICTS.entries()]
    .filter(([n, v]) => !BASELINE.has(n) && !(typeof v.adopted === 'string' && v.adopted.length >= MIN_EXEMPTION_REASON))
    .map(([n]) => n);
  const badKind = [...VERDICTS.entries()]
    .filter(([, v]) => !VERDICT_KINDS.includes(v.verdict))
    .map(([n]) => n);
  const unreasoned = [...VERDICTS.entries()]
    .filter(([, v]) => !v.reason || v.reason.length < MIN_EXEMPTION_REASON)
    .map(([n]) => n);
  return { missing, extra, badKind, unreasoned };
}

/** Rollup of verdicts by kind — printed on every run so the disposition stays visible. */
export function verdictRollup() {
  const out = Object.fromEntries(VERDICT_KINDS.map((k) => [k, 0]));
  for (const v of VERDICTS.values()) if (v.verdict in out) out[v.verdict] += 1;
  return out;
}

export const isExcluded = (f) =>
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.ts$/.test(f);

/**
 * Has the grandfather period expired? Pure (today -> boolean) so the expiry is
 * unit-testable without waiting for the calendar.
 */
export function baselineExpired(today = new Date().toISOString().slice(0, 10)) {
  return BASELINE.size > 0 && today > BASELINE_REVIEW_BY;
}

/** Scan the tracked tree. Returns offenders + the visibility counters. */
export function findOffenders() {
  // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
  const tracked = presentOnDisk(
    execSync(`git ls-files ${SCAN_DIRS.join(' ')}`, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean),
    ROOT,
  );

  const offenders = [];
  const exemptions = [];
  const lenses = [];
  const definitions = [];
  const seen = new Set();

  for (const f of tracked) {
    if (isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    for (const row of parseToolDefs(text, f)) {
      definitions.push({ file: f, ...row });
      if (!isStateReadCandidate(row)) continue;
      seen.add(row.name);
      if (row.lens) lenses.push({ file: f, name: row.name, cell: row.lens });
      if (row.exemption) exemptions.push({ file: f, name: row.name, reason: row.exemption });
      const verdict = judgeToolDef(row);
      if (!verdict) continue;
      // A grandfathered tool is exempt ONLY from the undeclared case. A malformed
      // declaration is always an error: the baseline forgives an absent decision,
      // never a broken one.
      if (verdict.rule === 'undeclared-state-read' && BASELINE.has(row.name)) continue;
      offenders.push({ file: f, name: row.name, ...verdict });
    }
  }

  // Non-fatal hygiene: baseline entries whose tool no longer trips the signature
  // (retired by P-020, renamed, or now declared). Reported so the shrink-only set
  // cannot quietly accumulate dead weight; NOT a failure, because a stale entry
  // cannot cause a wrong answer and a red gate blocks the whole fleet.
  const stale = [...BASELINE].filter((n) => !seen.has(n));
  const redundant = lenses.concat(exemptions).filter((r) => BASELINE.has(r.name)).map((r) => r.name);

  return { offenders, exemptions, lenses, stale, redundant, scanned: seen.size, definitions };
}

function main() {
  const { offenders, exemptions, lenses, stale, redundant, scanned } = findOffenders();

  if (offenders.length > 0) {
    console.error('✗ no-bespoke-state-read gate (unified-agent-state-plane-2026-07-27 P-005 / D-010):\n');
    for (const o of offenders) {
      console.error(`    ${o.name}  [${o.rule}]`);
      console.error(`      ${o.file}`);
      console.error(`      ${o.detail}`);
    }
    console.error('\n  A new state-read tool must declare, INSIDE its defineTool({ ... }) literal, one of:');
    console.error('\n    // @cell-lens <cell.id>');
    console.error('        This tool PROJECTS a registered cell (D-038 axis 5: one derivation, many');
    console.error('        lenses). Register the cell with registerCell() from');
    console.error('        packages/operator-core/lib/cell-registry.ts — one object literal — then');
    console.error('        point at it. This is the intended path and the cheaper one.');
    console.error('\n    // @not-a-cell <reason, at least ' + MIN_EXEMPTION_REASON + ' chars>');
    console.error('        Either (i) this read is genuinely not live system state (a record read,');
    console.error('        a catalog, a report), OR (ii) it IS live state but is a SINGLE DOOR —');
    console.error('        one tool answers the question and nothing re-derives it, so a cell would');
    console.error('        add a registry entry without removing one (the D-010 failure).');
    console.error('        State WHICH and WHY; the count of exemptions is printed on every run.');
    console.error(`\n  ${offenders.length} offender(s). Do NOT add to BASELINE — it is shrink-only (P-020 empties it).`);
    process.exit(1);
  }

  // P-020: the inventory must stay complete. A tool grandfathered without a verdict is
  // exactly the drift this map exists to prevent, so it FAILS rather than warns — the
  // cost of a missing verdict is one sentence, the cost of silent drift is the plan.
  const gaps = verdictGaps();
  if (gaps.missing.length || gaps.extra.length || gaps.badKind.length || gaps.unreasoned.length) {
    console.error('✗ no-bespoke-state-read gate: the P-020 VERDICTS map and BASELINE have diverged.\n');
    if (gaps.missing.length) console.error(`    ${gaps.missing.length} grandfathered tool(s) with NO verdict: ${gaps.missing.join(', ')}`);
    if (gaps.extra.length) console.error(`    ${gaps.extra.length} verdict(s) for a tool no longer grandfathered — delete them: ${gaps.extra.join(', ')}`);
    if (gaps.badKind.length) console.error(`    ${gaps.badKind.length} verdict(s) with an unknown kind (expected ${VERDICT_KINDS.join('|')}): ${gaps.badKind.join(', ')}`);
    if (gaps.unreasoned.length) console.error(`    ${gaps.unreasoned.length} verdict(s) without a real reason (>= ${MIN_EXEMPTION_REASON} chars): ${gaps.unreasoned.join(', ')}`);
    console.error('\n  Retiring a tool removes it from BOTH maps. Adding one is not allowed at all.');
    process.exit(1);
  }

  if (baselineExpired()) {
    console.error('✗ no-bespoke-state-read gate: the BASELINE grandfather period has EXPIRED.');
    console.error(`    ${BASELINE.size} tool(s) are still grandfathered past BASELINE_REVIEW_BY=${BASELINE_REVIEW_BY}.`);
    console.error('\n  Shrink-only was the promise; this is the date it comes due. Retire them onto');
    console.error('  cells (P-020, unified-agent-state-plane-2026-07-27) and delete their entries.');
    console.error('  Moving the date instead is a recorded plan decision, not a quiet edit — and');
    console.error('  deleting this check is how KNOWN_DARK_FLAGS became a parking lot.');
    process.exit(1);
  }

  const roll = verdictRollup();
  const parts = [
    `${scanned} state-read tool(s) in scope`,
    `${BASELINE.size} grandfathered (shrink-only, P-020)`,
    `${lenses.length} cell lens(es)`,
    `${exemptions.length} reasoned exemption(s)`,
  ];
  console.log(`✓ no UNDECLARED state-read tool — ${parts.join(' · ')}.`);
  const adopted = [...VERDICTS.values()].filter((v) => typeof v.adopted === 'string').length;
  console.log(
    `  P-020 inventory: ${VERDICTS.size} tool(s) verdicted — ${roll.cell} become a cell · ` +
      `${roll.delegates} delegate to one · ${roll.bespoke} stay bespoke; ` +
      `${adopted} adopted so far, ${BASELINE.size} still grandfathered.`,
  );
  if (exemptions.length > 0) {
    console.log('  exemptions (visible on purpose — growth here means the gate is being routed around):');
    for (const e of exemptions) console.log(`    ${e.name} — ${e.reason}`);
  }
  if (redundant.length > 0) {
    console.log(`  note: ${redundant.length} BASELINE entr(ies) now declare a marker and can be removed: ${redundant.join(', ')}`);
  }
  if (stale.length > 0) {
    console.log(`  note: ${stale.length} BASELINE entr(ies) no longer match any tool (retired/renamed) — delete them: ${stale.join(', ')}`);
  }
  process.exit(0);
}

async function mainVolumeReport() {
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID || 'papercusp-workspace';
  const harnessSlug = process.env.PAPERCUSP_HARNESS_SLUG || 'papercusp';
  const { resolveScriptPgUrl } = await import('./lib/pg-url.mjs');
  const postgres = (await import('postgres')).default;
  const sql = postgres(resolveScriptPgUrl().url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });

  let volume;
  try {
    volume = await fetchVolumeReport({
      sql,
      workspaceId,
      harnessSlug,
      windowDays: VOLUME_WINDOW_DAYS,
    });
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const { definitions } = findOffenders();
  const candidates = findVolumeCandidates(volume.rows, definitions);
  const status = volumeReportStatus(volume);
  console.log(formatVolumeReport({
    workspaceId,
    harnessSlug,
    windowDays: VOLUME_WINDOW_DAYS,
    totalCalls: volume.totalCalls,
    candidates,
  }));
  process.exitCode = status.exitCode;
}

// CLI-only: importing the module (for the unit test) must not exec git or exit.
// Symlink-robust (WI-1443), same guard as check-no-raw-setinterval.mjs.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.includes('--volume-report')) {
    mainVolumeReport().catch((error) => {
      console.error(`✗ no-bespoke-state-read volume report unavailable: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
  } else {
    main();
  }
}
