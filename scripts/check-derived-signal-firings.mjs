#!/usr/bin/env node
/**
 * check-derived-signal-firings.mjs — THE DEAD-DERIVED-SIGNAL DETECTOR
 * (auto-coupling-delivery-and-correctness-2026-08-09 P-007, ruled by D-088).
 *
 * ── THE QUESTION NO EXISTING PROBE CAN ANSWER ───────────────────────────────
 *
 * The plane ships three reachability probes and a derived signal slips past all
 * three at once:
 *
 *   · check-plane-producers.mjs   — is the FIELD written?        (a DB column fact)
 *   · check-declared-consumed.mjs — is the field READ in source? (a static fact)
 *   · check-plane-adoption.mjs    — does an AGENT ever call it?  (a call count)
 *
 * A derived coupling relation is computed at read time and persisted nowhere, so
 * it HAS no column; it is plainly read in source; and its enclosing tool really is
 * called. Three green ticks, and the relation can still emit nothing, ever.
 *
 * It has happened twice, to the same dimension of the same feature, and a human
 * hand-querying live data found it both times:
 *
 *   · `current_files`    — real roster field, 119 live rows, ZERO populated.
 *   · `holds-a-lock-on`  — shipped to REPLACE that dead signal, then silently
 *                          inherited an unrelated flag's gate and fired zero times
 *                          for 12 days (D-088).
 *
 * ── THE VERDICTS, AND WHY THERE ARE SIX ─────────────────────────────────────
 *
 * A bare firing count collapses situations with opposite remedies. Each verdict
 * below is a distinct defect (or a distinct non-defect), and the two that FAIL are
 * exactly the two that are decidable from the data without a judgement call:
 *
 *   firing        edges reached callers.                            ✓
 *   armed-silent  wired, had input, produced no edges. Usually honest scarcity
 *                 (nobody held overlapping locks). Reported, never fails.
 *   starved       wired and consulted, but the INPUT was empty every time — the
 *                 `current_files` shape: a live relation over a dead producer.
 *                 Reported, never fails: the defect is upstream, not here.
 *   never-armed   ⛔ runs happened and the input was never WIRED IN at all. This
 *                 is `holds-a-lock-on`'s shape exactly, and it is a code defect
 *                 with no benign reading. FAILS at review.
 *   unobserved    ⛔ the census ran and never mentioned this relation, though its
 *                 contract is to emit EVERY relation including zeros. That means
 *                 the detector itself has gone blind to a signal — a new relation
 *                 added without census coverage, or a schema drift. FAILS at
 *                 review, because a detector with a hole is worse than none.
 *   no-data       nothing was censused in the window at all. NEITHER pass nor
 *                 fail — the same discipline as `judgeProducerField`'s `no-data`.
 *
 * ⚠ THE VACUOUS PASS THIS IS BUILT TO AVOID, TWICE OVER.
 *
 *   (1) An empty census window (fresh DB, pruned table, code not yet deployed)
 *       would render every relation as dead. That is a confident wrong answer that
 *       looks exactly like a real finding, so a zero is only believed once the
 *       window is shown to contain census rows at all.
 *   (2) The DECLARED relation list is parsed from the source of truth
 *       (`DERIVED_COUPLING_RELATIONS` in coord/couplings.ts), never hardcoded here
 *       — otherwise this probe goes stale in precisely the way it exists to
 *       detect. A parse that yields ZERO relations is a hard ERROR, never a clean
 *       report over nothing: a guard that silently measures an empty set is the
 *       failure mode this whole probe family keeps re-learning.
 *
 * ── WHY IT IS REPORT-ONLY UNTIL A REVIEW DATE ───────────────────────────────
 *
 * Landing a probe that fails today would red-pin `main` for the whole fleet over a
 * condition no commit caused and no commit can fix — the trap
 * EI-18850142725126359 filed against the first live-DB gate. Same posture as the
 * adoption probe: a failing verdict before its review date is REPORTED at exit 0;
 * on/after that date it fails, and the remedy is a decision recorded on the plan
 * (wire the leg, cut the relation, or record a `ruling` here).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the DERIVED relation vocabulary actually lives. */
export const RELATIONS_SOURCE = 'packages/operator-core/lib/coord/couplings.ts';

/** The census key written by coord/derived-signal-census.ts. Must match it. */
export const CENSUS_KEY = 'derivedSignals';

/**
 * The census schema version this probe can INTERPRET. Must equal
 * DERIVED_SIGNAL_CENSUS_VERSION in coord/derived-signal-census.ts — pinned by a
 * test, because the two live in different languages and cannot import each other.
 *
 * WHY A VERSION FILTER AND NOT JUST A WINDOW. `inputs` was REDEFINED in v2 (pool
 * -> binding input), and `inputRuns` below is what separates `starved` from
 * `armed-silent`. A 14-day window spanning that change therefore mixes two
 * incompatible measurements of the one field the verdict turns on, and produces a
 * confident verdict from an average of the two. Older rows are EXCLUDED and
 * COUNTED, never quietly folded in: a shrunken evidence base has to be visible,
 * since it is the difference between "we looked and it was dead" and "we have not
 * measured it yet under this instrument".
 */
export const CENSUS_VERSION = 2;

/** Days of history each relation is judged over. */
export const WINDOW_DAYS = 14;

/**
 * The telemetry ledger is shared by every workspace and harness.  A standalone
 * probe has no MCP context to resolve for itself, so it follows the same explicit
 * environment contract as the other scripts/* database readers.
 */
export const DEFAULT_WORKSPACE_ID = 'papercusp-workspace';
export const DEFAULT_HARNESS_SLUG = 'papercusp';
export const WORKSPACE_GLOBAL_HARNESS_SLUG = '*';

export function resolveTelemetryScope(env = process.env) {
  return {
    workspaceId: String(env.PAPERCUSP_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID).trim() || DEFAULT_WORKSPACE_ID,
    harnessSlug: String(env.PAPERCUSP_HARNESS_SLUG ?? DEFAULT_HARNESS_SLUG).trim() || DEFAULT_HARNESS_SLUG,
  };
}

/**
 * The date a bad verdict starts FAILING rather than reporting.
 *
 * Chosen, not inherited: the census only wrote on the opt-in `include_coupling`
 * branch, measured at ~11 calls per fortnight, so a window shorter than this
 * cannot accumulate enough runs for `never-armed` to mean anything. Moving this
 * date is a decision to record on the plan, not a knob to nudge when it goes red.
 *
 * ⚠ THE PREMISE ABOVE EXPIRED ON 2026-08-10 (D-098) — read the date with that in
 * mind. `include_coupling` is now DEFAULT-ON, so the census rides the default
 * presence path instead of an opt-in branch taken 11 times in its entire life. The
 * ~11-per-fortnight rate this date was sized against is therefore obsolete, and
 * 2026-09-13 is now far more conservative than intended rather than barely
 * sufficient. Left UNCHANGED deliberately: it is a recorded decision, and the
 * honest move is to re-derive it from the OBSERVED post-D-098 rate once real
 * census rows exist — not to guess a new date from the same armchair the old one
 * came from. Whoever does that: record it, and update this note with it.
 */
export const REVIEW_BY = '2026-09-13';

/**
 * Per-relation rulings: a permanent statement that a bad verdict is INTENDED.
 * Unlike a work-item a ruling cannot close, which is the point — it must be
 * re-read and re-justified rather than silently ageing out.
 */
export const RULINGS = {
  // EMPTY ON PURPOSE, and the emptiness is the healthy state: the detector
  // currently suppresses NOTHING, so every bad verdict it reports is one somebody
  // still has to answer for.
  //
  // Its only entry was `shared-file`, whose ruling read "kept because it is
  // correct on the rare populated row" — the exact rationale D-093 overturned on
  // 2026-08-10 when the relation was retired for producing ZERO edges in 14 days.
  // Worth noticing what happened here: the ruling was written to explain away a
  // PERMANENTLY starved signal, which is precisely the state this detector exists
  // to surface. A suppression that can never expire is a signal that should have
  // been deleted, so retiring the relation removed the need for the ruling rather
  // than the other way round.
  //
  // ⚠ A FUTURE ENTRY MUST BE A RELATION THAT STILL EXISTS. The probe's
  // "shipped ruling set names only relations that still exist" test fails on a key
  // that has left DERIVED_COUPLING_RELATIONS — which is how this stale entry was
  // caught rather than quietly outliving its signal.
};

export const FIRING_VERDICTS = ['firing', 'armed-silent', 'starved', 'never-armed', 'unobserved', 'no-data'];

/** Verdicts that are CODE defects with no benign reading, hence the only failing ones. */
export const FAILING_VERDICTS = ['never-armed', 'unobserved'];

/**
 * Census rows the window must contain before a bad verdict may FAIL the gate.
 *
 * ⚠ THIS IS A STATISTICAL-POWER FLOOR, NOT A TUNING KNOB, and it is this plan's own
 * precedent applied to itself: D-090 parked P-006 until 2026-08-16 because a 12×
 * rate jump on n=3 is indistinguishable from noise at the null rate. A review DATE
 * alone would make exactly that mistake here — the census wrote only on the opt-in
 * `include_coupling` branch (~11 calls per fortnight), so 2026-09-13 could arrive
 * with three census rows and red-pin the fleet on three samples.
 *
 * ⚠ That starvation is what D-098 fixed (default-ON, 2026-08-10), so this floor
 * should now clear easily instead of being the binding constraint. KEEP IT ANYWAY:
 * it is a floor, not a target, and it costs nothing when data is plentiful. Its
 * whole value is on the day the rate collapses again — a regression that silently
 * re-gates the census would otherwise arrive disguised as a confident verdict over
 * three samples, which is exactly the shape this refuses to condemn on.
 *
 * `no-data` already refuses to interpret an EMPTY window; this refuses to CONDEMN a
 * nearly-empty one. It also absorbs the version-skew case for free: a relation added
 * upstream but not yet deployed reads `unobserved` while the census is still warming
 * up, and must not fail on that.
 */
export const MIN_CENSUS_ROWS_TO_FAIL = 5;

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * Judge one relation. PURE ({counts} -> verdict) so every branch is testable with
 * no database.
 *
 * ⚠ ORDER IS LOAD-BEARING. `firing` is decided FIRST: a relation that demonstrably
 * delivered edges to a caller is alive whatever the arming bookkeeping says, and
 * letting a bookkeeping disagreement mask real delivered output would be the
 * detector lying in the expensive direction.
 */
export function judgeSignalFiring({ runs, armedRuns, inputRuns, edges, windowHadCensus }) {
  if (windowHadCensus === false) return 'no-data';
  const r = int(runs);
  const a = int(armedRuns);
  const i = int(inputRuns);
  const e = int(edges);
  if (e > 0) return 'firing';
  if (r <= 0) return 'unobserved';
  if (a <= 0) return 'never-armed';
  if (i <= 0) return 'starved';
  return 'armed-silent';
}

/** Has this row's review date arrived? PURE, so the transition is testable. */
export function isPastReview(reviewBy, now) {
  const d = Date.parse(`${reviewBy}T00:00:00Z`);
  if (!Number.isFinite(d)) return false;
  return now.getTime() >= d;
}

/**
 * Parse the DECLARED relation vocabulary out of its source of truth.
 *
 * Deliberately not a hardcoded list: a relation added upstream must appear here
 * automatically, or this probe rots into exactly the stale-and-silent surface it
 * was built to catch. Returns [] on any failure so the CALLER decides — and every
 * caller must treat [] as an error, never as "no relations to check".
 */
export function parseDeclaredRelations(source) {
  // Comment lines inside the array carry quoted prose (the `same-fleet` tombstone
  // quotes the owner verbatim), so strip comments BEFORE harvesting string
  // literals — otherwise a retired relation named in a comment reads as declared.
  //
  // COMMENTS ONLY: the relation names ARE the string literals we harvest, so masking
  // strings would return []. Via the shared stripper rather than a private regex pair:
  // that pair reads `/*` inside a `//` comment or a string (a glob like `lib/*.mjs`) as
  // an open block comment and deletes to the next `*/`, which measurably deleted 119
  // lines of live code elsewhere in scripts/ (EI-20045405992394901). It is also
  // length-preserving, so the extraction offsets below are unchanged.
  const text = stripCommentsOnly(String(source ?? ''), 'couplings.ts');
  const m = /DERIVED_COUPLING_RELATIONS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/.exec(text);
  if (!m) return [];
  const out = [];
  const body = m[1];
  for (const lit of body.matchAll(/'([^']+)'|"([^"]+)"/g)) {
    const v = (lit[1] ?? lit[2] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

export function rollupFirings(rows, now, censusRows = Infinity) {
  const bad = (r) => FAILING_VERDICTS.includes(r.verdict) && !r.ruling;
  // Evidence floor BEFORE the date check: too few samples is not a pass and not a
  // failure, it is an unfinished measurement. See MIN_CENSUS_ROWS_TO_FAIL.
  const enoughEvidence = Number.isFinite(censusRows) ? censusRows >= MIN_CENSUS_ROWS_TO_FAIL : true;
  return {
    censusRows,
    underpowered: rows.filter((r) => bad(r) && isPastReview(r.reviewBy, now) && !enoughEvidence),
    firing: rows.filter((r) => r.verdict === 'firing').length,
    armedSilent: rows.filter((r) => r.verdict === 'armed-silent').length,
    starved: rows.filter((r) => r.verdict === 'starved').length,
    neverArmed: rows.filter((r) => r.verdict === 'never-armed').length,
    unobserved: rows.filter((r) => r.verdict === 'unobserved').length,
    noData: rows.filter((r) => r.verdict === 'no-data').length,
    ruled: rows.filter((r) => r.ruling).length,
    failing: rows.filter((r) => bad(r) && isPastReview(r.reviewBy, now) && enoughEvidence),
    pending: rows.filter((r) => bad(r) && !isPastReview(r.reviewBy, now)),
  };
}

const MARK = {
  firing: '✓',
  'armed-silent': '·',
  starved: '⚠',
  'never-armed': '✗',
  unobserved: '✗',
  'no-data': '?',
};

const MEANING = {
  firing: 'edges delivered to callers',
  'armed-silent': 'wired, had input, emitted nothing — usually honest scarcity',
  starved: 'wired and consulted, but its INPUT was empty every run — dead producer upstream',
  'never-armed': 'runs happened and the input was NEVER wired in — a dead gate (D-088 shape)',
  unobserved: 'the census never mentioned this relation — the detector has a hole',
  'no-data': 'nothing censused in this window — uninterpretable, neither pass nor fail',
};

export function formatReport(rows, roll, now, scope = {}) {
  // The CLI passes the result of resolveTelemetryScope here.  Keep the formatter
  // on that resolved report-scope surface rather than treating an ambient MCP
  // context's `harnessSlug` (which may be the '*' sentinel) as an identity.
  const { workspaceId, harnessSlug, censusRows = 0, staleVersionRows = 0 } = scope;
  const out = [`\nDERIVED-SIGNAL FIRING PROBE — is each derived relation alive in production? (P-007 / D-088)\n`];
  if (workspaceId || harnessSlug) {
    out.push(
      `  scope: workspace=${workspaceId ?? DEFAULT_WORKSPACE_ID} · ` +
        `harness=${harnessSlug ?? DEFAULT_HARNESS_SLUG} + ${WORKSPACE_GLOBAL_HARNESS_SLUG}\n`,
    );
  }
  out.push(`  window: ${WINDOW_DAYS}d · census rows: ${censusRows} (v${CENSUS_VERSION}) · source: ${RELATIONS_SOURCE}\n`);
  if (staleVersionRows) {
    // Say this out loud rather than reporting a quietly smaller number: during the
    // changeover the excluded rows are the MAJORITY, and a reader who does not know
    // that will read a thin post-bump window as "the signal went quiet".
    out.push(
      `  ⚠ ${staleVersionRows} row(s) in this window are from an OLDER census instrument (not v${CENSUS_VERSION}) and are\n` +
        `    excluded — they measured \`inputs\` differently, so folding them in would average two instruments.\n` +
        `    Expected while the bump rolls out; the window refills at the current version.\n`,
    );
  }
  for (const r of rows) {
    const bar = `${r.edges} edges · armed ${r.armedRuns}/${r.runs} runs · input ${r.inputRuns}`;
    out.push(`  ${MARK[r.verdict] ?? '?'} ${String(r.relation).padEnd(18)} ${String(bar).padEnd(44)} ${r.verdict}`);
    if (r.verdict === 'firing') continue;
    out.push(`      means:  ${MEANING[r.verdict] ?? r.verdict}`);
    if (FAILING_VERDICTS.includes(r.verdict) && !r.ruling) {
      out.push(`      ${isPastReview(r.reviewBy, now) ? 'REVIEW DUE' : `review ${r.reviewBy}`}`);
    }
    if (r.ruling) out.push(`      RULED:  ${r.ruling}`);
  }
  out.push(
    `\n  ${roll.firing} firing · ${roll.armedSilent} armed-silent · ${roll.starved} starved · ` +
      `${roll.neverArmed} NEVER-ARMED · ${roll.unobserved} UNOBSERVED · ${roll.noData} no-data · ${roll.ruled} ruled\n`,
  );
  if (roll.failing.length > 0) {
    out.push(
      '✗ a derived signal is DEAD and its review date has passed. This is not a number to nudge — the remedy is\n' +
        '  a decision recorded on the plan: wire the leg, cut the relation, or record a `ruling` in this file:\n' +
        roll.failing.map((r) => `    · ${r.relation} — ${MEANING[r.verdict]}`).join('\n'),
    );
  } else if (roll.underpowered?.length > 0) {
    out.push(
      `⚠ ${roll.underpowered.length} relation(s) look dead and their review date HAS passed, but the window holds only\n` +
        `  ${roll.censusRows} census row(s) — below the ${MIN_CENSUS_ROWS_TO_FAIL}-row floor, so this is an UNFINISHED measurement, not a verdict.\n` +
        '  Condemning a signal on this little evidence is the n=3 mistake D-090 parked P-006 to avoid. Reported, not failing:\n' +
        roll.underpowered.map((r) => `    · ${String(r.relation).padEnd(18)} ${r.verdict}`).join('\n'),
    );
  } else if (roll.pending.length > 0) {
    out.push(
      `⚠ ${roll.pending.length} relation(s) look dead, none past review yet — reported, not failing. The clock is running:\n` +
        roll.pending.map((r) => `    · ${String(r.relation).padEnd(18)} ${r.verdict} · review ${r.reviewBy}`).join('\n'),
    );
  } else if (roll.noData === rows.length) {
    out.push(
      '? NO CENSUS DATA in the window — uninterpretable, reported as unknown rather than as a clean pass.\n' +
        '  Expected until the census ships and an agent calls coord:presence with include_coupling.',
    );
  } else {
    out.push('✓ every derived relation is either firing or accounted for.');
  }
  return out.join('\n');
}

/**
 * Read the scoped census population used by the CLI.  Keep both aggregate
 * queries in this helper so a future edit cannot scope the evidence floor but
 * accidentally leave relation counts cross-tenant (or vice versa).
 *
 * `harness_slug='*'` is a legitimate workspace-global superuser context.  It
 * carries valid coupling firings for the workspace and is intentionally included
 * alongside the concrete harness, while rows from every other workspace or
 * harness are excluded.
 */
export async function readCensusRows(sql, { workspaceId, harnessSlug, windowDays = WINDOW_DAYS } = {}) {
  const scope = {
    workspaceId: workspaceId ?? resolveTelemetryScope().workspaceId,
    harnessSlug: harnessSlug ?? resolveTelemetryScope().harnessSlug,
  };
  const params = [
    String(windowDays),
    CENSUS_KEY,
    String(CENSUS_VERSION),
    scope.workspaceId,
    scope.harnessSlug,
    WORKSPACE_GLOBAL_HARNESS_SLUG,
  ];
  // Compared as TEXT, deliberately: an ::int cast would ERROR on a malformed
  // `v` and take the whole probe down, where a text mismatch simply excludes the
  // row — which is the correct handling for a census this probe cannot interpret.
  const [t] = await sql.unsafe(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE metadata_json -> $2 ->> 'v' = $3)::int AS at_version
       FROM harness_shared.tool_invocations
      WHERE invoked_at > now() - ($1 || ' days')::interval
        AND metadata_json ? $2
        AND workspace_id = $4
        AND harness_slug IN ($5, $6)`,
    params,
  );
  // The evidence floor counts only rows this probe can INTERPRET. Counting all of
  // them would let stale-instrument rows satisfy MIN_CENSUS_ROWS_TO_FAIL and let
  // a verdict fail on evidence it never actually read.
  const censusRows = Number(t?.at_version ?? 0);
  const staleVersionRows = Math.max(0, Number(t?.total ?? 0) - censusRows);

  const agg = await sql.unsafe(
    `SELECT rel.key AS relation,
            count(*)::int AS runs,
            count(*) FILTER (WHERE rel.value->>'armed' = 'true')::int AS armed_runs,
            count(*) FILTER (WHERE COALESCE((rel.value->>'inputs')::int, 0) > 0)::int AS input_runs,
            COALESCE(sum(COALESCE((rel.value->>'edges')::int, 0)), 0)::int AS edges
       FROM harness_shared.tool_invocations ti,
            LATERAL jsonb_each(ti.metadata_json -> $2 -> 'relations') AS rel
      WHERE ti.invoked_at > now() - ($1 || ' days')::interval
        AND ti.metadata_json ? $2
        AND ti.metadata_json -> $2 ->> 'v' = $3
        AND ti.workspace_id = $4
        AND ti.harness_slug IN ($5, $6)
      GROUP BY 1`,
    params,
  );
  return {
    observed: new Map(agg.map((r) => [r.relation, r])),
    censusRows,
    staleVersionRows,
    scope,
  };
}

async function main() {
  const relSource = readFileSync(path.join(HERE, '..', RELATIONS_SOURCE), 'utf8');
  const declared = parseDeclaredRelations(relSource);
  if (declared.length === 0) {
    // NOT a pass. A probe that cannot enumerate its subjects has measured nothing,
    // and reporting that as green is the vacuous pass this family exists to refuse.
    console.error(
      `\n✗ could not parse DERIVED_COUPLING_RELATIONS from ${RELATIONS_SOURCE} — the probe has no subjects and\n` +
        '  therefore measured NOTHING. Fix the parse or the source; this is never a clean run.',
    );
    process.exitCode = 1;
    return;
  }

  const postgres = (await import('postgres')).default;
  const sql = postgres(resolveScriptPgUrl().url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  const now = new Date();
  const scope = resolveTelemetryScope();
  let observed = new Map();
  let censusRows = 0;
  let staleVersionRows = 0;
  try {
    const census = await readCensusRows(sql, scope);
    observed = census.observed;
    censusRows = census.censusRows;
    staleVersionRows = census.staleVersionRows;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const rows = declared.map((relation) => {
    const o = observed.get(relation);
    const counts = {
      runs: o?.runs ?? 0,
      armedRuns: o?.armed_runs ?? 0,
      inputRuns: o?.input_runs ?? 0,
      edges: o?.edges ?? 0,
    };
    return {
      relation,
      ...counts,
      reviewBy: REVIEW_BY,
      ruling: RULINGS[relation],
      verdict: judgeSignalFiring({ ...counts, windowHadCensus: censusRows > 0 }),
    };
  });

  const roll = rollupFirings(rows, now, censusRows);
  console.log(formatReport(rows, roll, now, { ...scope, censusRows, staleVersionRows }));
  if (roll.failing.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // ⚠ DELIBERATELY EXIT 0, unlike its siblings. This probe has no failing verdict
    // before its review date, so it has no teeth to protect — and a report-only
    // probe that can red the fleet gate on a transient PG blip is pure liability.
    // Being unable to measure cannot establish that a review date was breached,
    // which is the `no-data` discipline applied to the probe itself.
    console.error('\n? derived-signal firing probe could not run (reported UNKNOWN, not failed):', e?.message ?? e);
  });
}
