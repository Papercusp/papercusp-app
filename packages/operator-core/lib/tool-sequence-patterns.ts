/**
 * tool-sequence-patterns.ts — mine the ORDERED tool-call dances that recur across
 * distinct agents, so a pattern a dozen agents each rediscover can become one
 * reusable thing (okf-frontmatter-adoption-2026-08-08 §D).
 *
 * This is the INPUT-WIDENING half of workstream D. The recipe graduation layer
 * (code-recipes-candidates.ts) already scores repetition and clusters
 * near-duplicates, but it only ever sees SAVED code:run scripts — while the
 * repetition actually worth capturing is in the tool-call sequences agents
 * perform without ever saving anything. `tool_invocations` has recorded those
 * all along. Deliberately NOT a second synthesizer: this module produces
 * candidates and hands them to the existing scorer (§10 names a parallel
 * synthesizer as the mistake).
 *
 * The counting is delegated to @papercusp/sequence-patterns, which is
 * domain-free. Everything here is the part that is NOT generic: how this
 * particular table encodes "an agent decided to do something".
 *
 * ── THE PROVENANCE RULE, and why it is the whole ballgame ──────────────────
 *
 * Three facts about `tool_invocations`, each measured on live data 2026-08-09
 * (papercusp-workspace) rather than assumed, and each one fatal to the obvious
 * implementation:
 *
 *  1. `spawn_id` IS NOT A SESSION. It is per-REQUEST (`ephemeral-<hash>`) —
 *     572,435 of them across 607,140 rows in 7d, ~1.06 rows each. Grouping a
 *     "session" by it yields sequences of length one.
 *
 *  2. The agent is `coord_owner_id`, and its stream must be SEGMENTED. An
 *     agent's 7-day history is not one sequence; adjacency across an idle hour
 *     is not adjacency. Hence the burst gap.
 *
 *  3. `transport` ENCODES WHO DECIDED. `mcp` = the agent called it over the
 *     wire. `in_process` = a TOOL IMPLEMENTATION called it. `coord:orient`
 *     fans out to ~10 in_process calls (memory:search, coord:whoami,
 *     coord:plan-events, …) under its own spawn_id, and the parent row is
 *     written LAST, after its children complete.
 *
 *     Miss (3) and the miner's top "patterns" are the internals of ONE tool
 *     that already exists — it would confidently propose promoting
 *     `coord:orient`'s own guts into a new tool. Measured: `memory:search →
 *     coord:whoami → coord:plan-events` appeared across 52 distinct agents,
 *     ranking 15th overall, and every one of those was coord:orient's fan-out.
 *
 * A caution earned the expensive way, because the SAME pair of conditions is
 * already wired into the promotion rubric and silently cancels out there: the
 * existing `toolCooccurrence` miner (dev-data.ts) filters `transport='mcp'` and
 * THEN groups by `spawn_id` — but the rows that share a spawn are exactly the
 * `in_process` ones the filter just removed. Measured over 24h: 53,295 spawns,
 * 998 (1.9%) with ≥2 tools, and every top "co-occurrence" was a dispatcher and
 * the thing it dispatched. Filter and grouping key must be chosen together.
 *
 * ── ONE SPAWN IS ONE DECISION ──────────────────────────────────────────────
 *
 * Several `mcp` rows can still share a spawn when the agent's call dispatches
 * others (`code:run` running a script that calls three tools; `tools:invoke`
 * dispatching one). Those are ONE agent decision, so a spawn contributes ONE
 * event: the OUTERMOST call, which is the last-written row (a wrapper completes
 * after its children). `code:run` is genuinely that decision — the agent chose
 * to run a script. `tools:invoke` is not: it is pure dispatch, and the intent is
 * the tool it names, so it is unwrapped (see {@link DEFAULT_DISPATCHER_TOOLS}).
 *
 * Server-only. Transport-agnostic: takes the `sql` handle like its siblings.
 */
import type postgres from 'postgres';
import {
  minePatternsFromEvents,
  segmentBursts,
  containsRun,
  type SequenceEvent,
  type MinedPattern,
  type Burst,
} from '@papercusp/sequence-patterns';
import {
  computeGraduationStandings,
  type GraduationEvidenceItem,
} from './graduation/core';

/**
 * Tools that are PURE DISPATCH — the agent's intent is the tool they name, not
 * the call itself, so they are unwrapped to the inner call sharing their spawn.
 * `code:run` is deliberately absent: running a script IS the decision, and the
 * script's internal calls are implementation, not intent.
 */
export const DEFAULT_DISPATCHER_TOOLS = ['tools:invoke'] as const;

/**
 * Rows read per call before truncation.
 *
 * Sized against the real corpus rather than guessed: one fleet-week of
 * agent-initiated calls measured 528,878 rows on 2026-08-09, so the previous
 * 200,000 read barely half the default span. Truncation is now harmless to the
 * streak (the newest rows are kept — see readAgentInvocations), but a span that
 * silently arrives half-length still weakens the lift marginals, so the default
 * covers a normal week with headroom and callers report `stats.truncated` rather
 * than discovering the ceiling by getting quietly worse results.
 */
export const DEFAULT_MAX_ROWS = 750_000;
export const MAX_ROWS_CEILING = 1_500_000;

export interface ToolSequenceOpts {
  /** Workspace to mine (required — the table is multi-tenant). */
  workspaceId: string;
  /** Optional harness scope. Omitted ⇒ every harness in the workspace. */
  harnessSlug?: string;
  /** Lookback window in hours (default 168 = 7d, max 720). */
  hours?: number;
  /** Idle gap that ends a burst, in seconds (default 120). */
  gapSec?: number;
  /** Distinct-agent floor — the "ours, not mine" gate (default 3). */
  minAgents?: number;
  /** Total-occurrence floor (default 5). */
  minOccurrences?: number;
  /** Lift floor — rejects ambient telemetry (default 3). */
  minLift?: number;
  /** Longest dance to mine (default 5). */
  maxLength?: number;
  /** Max patterns returned (default 25). */
  limit?: number;
  /** Row cap pulled from PG before mining (default 200k) — bounds memory. */
  maxRows?: number;
  /** Override the pure-dispatch set. */
  dispatcherTools?: readonly string[];
}

/** One mined dance, in the shape the recipe scorer's rubric can read. */
export interface ToolSequenceCandidate {
  /** Stable kebab id derived from the tool sequence — the recipe-id shape. */
  id: string;
  /** The ordered tool names. */
  toolsUsed: string[];
  /** How many times the dance occurred. */
  occurrences: number;
  /** How many DISTINCT agents performed it — the reuse-breadth signal. */
  distinctAgents: number;
  /** A bounded sample of those agent ids, as evidence. */
  agentSample: string[];
  /** Distinct bursts it appeared in. */
  bursts: number;
  /** observed / expected-under-independence. ~1 = ambient; >>1 = a real dance. */
  lift: number;
  /**
   * The RANKING key: mean per-transition log10 lift, so a 5-call dance and a
   * 2-call one are comparable. Raw `lift` is not — it compounds with length.
   */
  strength: number;
  /** Human-readable rendering, for a work-item body or a log line. */
  label: string;
}

/** A candidate plus the evidence that it PERSISTS, not just that it spiked once. */
export interface PersistentToolSequenceCandidate extends ToolSequenceCandidate {
  /** Trailing consecutive windows the pattern appeared in (the graduation streak). */
  windowStreak: number;
  /** Windows it appeared in, lifetime across the mined span. */
  windowsSeen: number;
  /** Total windows examined — the denominator for `windowsSeen`. */
  windowsExamined: number;
  /** True once `windowStreak` clears the promotion threshold. */
  graduated: boolean;
}

export interface ToolSequenceResult {
  candidates: ToolSequenceCandidate[];
  stats: {
    rowsRead: number;
    /** Rows dropped as `in_process` — a tool implementation's calls, not an agent's. */
    droppedNonAgent: number;
    /** Rows collapsed because they shared a spawn with an outer call. */
    collapsedInnerCalls: number;
    /** Agent decisions actually mined, after the collapse. */
    decisions: number;
    agents: number;
    bursts: number;
    distinctTools: number;
    candidatesConsidered: number;
    rejected: { occurrences: number; cohorts: number; lift: number; subsumed: number };
    /** True when the row cap was hit — the window is then a SAMPLE, not the whole period. */
    truncated: boolean;
  };
}

type InvocationRow = {
  agent: string;
  tool_name: string;
  spawn_id: string;
  invoked_at: Date | string;
};

const asMs = (v: Date | string): number => (typeof v === 'string' ? Date.parse(v) : v.getTime());

/** Kebab id for a tool sequence, matching the recipe-id shape (`ns:verb` → `ns-verb`). */
export function sequenceId(tools: readonly string[]): string {
  return tools
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .join('--');
}

/**
 * Collapse each spawn to the ONE agent decision it represents: the outermost
 * (last-written) call, unwrapping a pure dispatcher to the inner call it names.
 *
 * Exported for unit test without PG — this is the step that carries the
 * provenance rule, so it is the step most worth testing directly.
 */
export function collapseSpawnsToDecisions(
  rows: readonly InvocationRow[],
  dispatcherTools: readonly string[] = DEFAULT_DISPATCHER_TOOLS,
): { events: SequenceEvent[]; collapsed: number } {
  const dispatchers = new Set(dispatcherTools);
  const bySpawn = new Map<string, InvocationRow[]>();
  for (const r of rows) {
    const list = bySpawn.get(r.spawn_id);
    if (list) list.push(r);
    else bySpawn.set(r.spawn_id, [r]);
  }

  const events: SequenceEvent[] = [];
  let collapsed = 0;
  for (const [, list] of bySpawn) {
    list.sort((a, b) => asMs(a.invoked_at) - asMs(b.invoked_at));
    collapsed += list.length - 1;
    // Walk inward from the outermost row past any pure dispatcher.
    let idx = list.length - 1;
    while (idx > 0 && dispatchers.has(list[idx]!.tool_name)) idx--;
    const chosen = list[idx]!;
    events.push({
      symbol: chosen.tool_name,
      cohort: chosen.agent,
      // Anchor the decision at the OUTERMOST row's time: that is when the
      // agent's call completed, so consecutive decisions order correctly even
      // when an inner call started much earlier.
      at: asMs(list[list.length - 1]!.invoked_at),
    });
  }
  return { events, collapsed };
}

/** Render a mined pattern as a candidate the recipe rubric can score. */
function toCandidate(p: MinedPattern): ToolSequenceCandidate {
  return {
    id: sequenceId(p.symbols),
    toolsUsed: p.symbols,
    occurrences: p.occurrences,
    distinctAgents: p.cohorts,
    agentSample: p.cohortSample,
    bursts: p.bursts,
    lift: Math.round(p.lift * 10) / 10,
    strength: Math.round(p.strength * 100) / 100,
    label: p.symbols.join(' → '),
  };
}

/**
 * Read the agent-initiated invocations for a window. The provenance filter lives
 * HERE, in the query: `in_process` rows are a tool implementation's fan-out (see
 * the module docstring) and must never enter a sequence.
 *
 * ⚠ The row cap selects the NEWEST rows (`ORDER BY invoked_at DESC`), then restores
 * ascending order in memory. The direction is load-bearing, not a preference.
 *
 * Ordering ASC and capping keeps the OLDEST rows, which silently deletes the
 * TRAILING windows — and the graduation streak is counted backwards from the most
 * recent window, so every candidate scores a streak of zero and NOTHING can ever
 * graduate. Measured 2026-08-09 on live data (528,878 rows over 7 days, the old
 * 200k cap): 0 graduated / 1,610 held; the same call at 1M rows: 6 graduated /
 * 3,118 held. The failure is invisible from the outside — a four-figure held list
 * looks like a healthy miner being appropriately picky.
 *
 * Dropping the oldest rows instead is the harmless direction: it shortens the span,
 * which weakens marginals but leaves the recency the streak actually depends on.
 */
async function readAgentInvocations(
  sql: postgres.Sql,
  opts: ToolSequenceOpts,
  sinceIso: string,
  maxRows: number,
): Promise<InvocationRow[]> {
  const harnessFrag = opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``;
  const rows = (await sql`
      SELECT coord_owner_id AS agent, tool_name, spawn_id, invoked_at
        FROM harness_shared.tool_invocations
       WHERE invoked_at > ${sinceIso}::timestamptz
         AND workspace_id = ${opts.workspaceId}
         ${harnessFrag}
         AND transport = 'mcp'
         AND status = 'ok'
         AND coord_owner_id IS NOT NULL
         AND spawn_id IS NOT NULL AND spawn_id <> ''
       ORDER BY invoked_at DESC
       LIMIT ${maxRows}
  `) as unknown as InvocationRow[];
  return rows.reverse();
}

/** Mine one already-collapsed event set with this call's floors. */
function mineEvents(events: SequenceEvent[], opts: ToolSequenceOpts) {
  return minePatternsFromEvents(
    events,
    { gapMs: (opts.gapSec ?? 120) * 1000, minBurstLength: 2 },
    {
      minLength: 2,
      maxLength: opts.maxLength ?? 5,
      minOccurrences: opts.minOccurrences ?? 5,
      minCohorts: opts.minAgents ?? 3,
      minLift: opts.minLift ?? 3,
      maximalOnly: true,
    },
  );
}

/**
 * Mine the recurring cross-agent tool dances for a workspace.
 *
 * Deterministic given the same rows and options. Read-only.
 */
export async function mineToolSequences(
  sql: postgres.Sql,
  opts: ToolSequenceOpts,
): Promise<ToolSequenceResult> {
  const hours = Math.max(1, Math.min(720, opts.hours ?? 168));
  const maxRows = Math.max(1000, Math.min(MAX_ROWS_CEILING, opts.maxRows ?? DEFAULT_MAX_ROWS));
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const rows = await readAgentInvocations(sql, opts, sinceIso, maxRows);

  const { events, collapsed } = collapseSpawnsToDecisions(
    rows,
    opts.dispatcherTools ?? DEFAULT_DISPATCHER_TOOLS,
  );

  const mined = mineEvents(events, opts);

  return {
    candidates: mined.patterns.slice(0, opts.limit ?? 25).map(toCandidate),
    stats: {
      rowsRead: rows.length,
      // Every row read is already agent-initiated (the query filters
      // in_process out), so this is reported as 0 rather than inferred — an
      // honest 0 beats a number that looks measured and is not.
      droppedNonAgent: 0,
      collapsedInnerCalls: collapsed,
      decisions: events.length,
      agents: mined.stats.cohorts,
      bursts: mined.stats.bursts,
      distinctTools: mined.stats.distinctSymbols,
      candidatesConsidered: mined.stats.candidatesConsidered,
      rejected: mined.stats.rejected,
      truncated: rows.length >= maxRows,
    },
  };
}

export interface GraduateToolSequencesOpts extends ToolSequenceOpts {
  /** How many consecutive windows to examine (default 7). */
  windows?: number;
  /** Hours per window (default 24 — so the default span is a week of days). */
  windowHours?: number;
  /** Consecutive-window streak a pattern needs to graduate (default 3). */
  minStreak?: number;
}

export interface GraduateToolSequencesResult {
  /** Candidates that cleared the streak — the promotable set. */
  graduated: PersistentToolSequenceCandidate[];
  /** Everything mined in the most recent window, streak-annotated. */
  candidates: PersistentToolSequenceCandidate[];
  stats: ToolSequenceResult['stats'] & {
    windows: number;
    windowHours: number;
    minStreak: number;
    /** Mined in the latest window but not yet persistent — the waiting room. */
    heldForEvidence: number;
  };
}

/**
 * Mine, then require the pattern to PERSIST before it may be promoted.
 *
 * This is the loop-closing half of workstream D. The existing recipe promotion
 * path ends at a decision someone has to make; §10 of the design says to replace
 * that ending with the graduation engine, and this does — with no human in it.
 *
 * The evidence bar is persistence across time, which matters because a single
 * mining pass cannot distinguish a genuinely reusable dance from one busy
 * afternoon: five agents doing the same thing during one incident is an
 * artifact of the incident, not a pattern worth capturing. So the span is cut
 * into consecutive windows and each window is mined independently; a pattern
 * earns a promotion by showing up in the last N windows in a row.
 *
 * REUSE, NOT REBUILD: the streak counter is {@link computeGraduationStandings},
 * the same frontier tracker `autonomy/tripwire/graduation.ts` uses — a window
 * the pattern appears in maps to a clean 'verified' pass, a window it is absent
 * from maps to 'recurred' and resets the streak. Writing a second streak counter
 * here would be the parallel-machinery mistake the design names by name.
 *
 * Deliberately needs NO new table, sweep or migration: the windows are cut from
 * `tool_invocations`, which has been recording this all along. One query covers
 * the whole span; the windows are partitioned in memory.
 */
export async function graduateToolSequences(
  sql: postgres.Sql,
  opts: GraduateToolSequencesOpts,
): Promise<GraduateToolSequencesResult> {
  const windows = Math.max(1, Math.min(30, opts.windows ?? 7));
  const windowHours = Math.max(1, Math.min(168, opts.windowHours ?? 24));
  const minStreak = Math.max(1, opts.minStreak ?? 3);
  const maxRows = Math.max(1000, Math.min(MAX_ROWS_CEILING, opts.maxRows ?? DEFAULT_MAX_ROWS));

  const nowMs = Date.now();
  const spanMs = windows * windowHours * 3600 * 1000;
  const startMs = nowMs - spanMs;

  const rows = await readAgentInvocations(
    sql,
    opts,
    new Date(startMs).toISOString(),
    maxRows,
  );
  const { events, collapsed } = collapseSpawnsToDecisions(
    rows,
    opts.dispatcherTools ?? DEFAULT_DISPATCHER_TOOLS,
  );

  // ── Ranking comes from the FULL span; windows supply ONLY persistence ──────
  //
  // Mining each window independently under the caller's floors looks like the
  // obvious design and is wrong in a way that inverts the result. The floors
  // (minOccurrences, minAgents) are sized for the whole span, so inside a single
  // day only HIGH-FREQUENCY traffic can clear them — and the highest-frequency
  // traffic is exactly the ambient telemetry this module exists to reject. A
  // genuine dance performed six times a week clears a weekly floor and no daily
  // one, so it scores a streak of zero.
  //
  // Measured before the fix (7×24h over papercusp, 539k rows): ZERO patterns
  // graduated, and the top of the held list was `activity:report →
  // locks:check_command → coord:glance` across 90 agents — ambient promoted by
  // its own ubiquity while every real finding sat at streak 0.
  //
  // So: rank once over the whole span (where the floors mean what the caller
  // intended), then ask each window only the cheap yes/no question "did this
  // exact run occur here?".
  const fullSpan = mineEvents(events, opts);
  const windowMs = windowHours * 3600 * 1000;

  const windowBursts: Burst[][] = [];
  for (let w = 0; w < windows; w++) {
    const from = startMs + w * windowMs;
    const to = from + windowMs;
    windowBursts.push(
      segmentBursts(events.filter((e) => e.at >= from && e.at < to), {
        gapMs: (opts.gapSec ?? 120) * 1000,
        minBurstLength: 2,
      }),
    );
  }

  const presentIn = (bursts: Burst[], symbols: string[]): boolean =>
    bursts.some((b) => containsRun(b.symbols, symbols));

  // One evidence CLASS per full-span candidate, one pass per window: present ⇒
  // a clean 'verified' pass, absent ⇒ 'recurred' (which resets the streak).
  const evidence: GraduationEvidenceItem[] = [];
  for (const p of fullSpan.patterns) {
    const id = sequenceId(p.symbols);
    for (let w = 0; w < windows; w++) {
      evidence.push({
        id: `${id}@w${w}`,
        findingClass: id,
        resolvedAtMs: startMs + (w + 1) * windowMs,
        lifecycle: presentIn(windowBursts[w]!, p.symbols) ? 'verified' : 'recurred',
        autoDispatched: true,
        hasEvidence: true,
      });
    }
  }

  const standings = computeGraduationStandings(
    evidence,
    [],
    {
      threshold: minStreak,
      // A window IS the recurrence window here, so the decay bar is one window.
      recurrenceWindowDays: Math.max(1, Math.round(windowHours / 24)),
      neverGraduateClassPatterns: [],
    },
    nowMs,
  );
  const streakOf = new Map(standings.map((s) => [s.findingClass, s]));

  // Rank by the full-span STRENGTH, not by streak: persistence is a GATE (you
  // graduate or you wait), never a ranking. Sorting on streak first would put
  // the most ubiquitous traffic on top for the same reason the per-window floors
  // did — and that is the failure this restructure removed.
  const annotated: PersistentToolSequenceCandidate[] = fullSpan.patterns
    .map((p) => {
      const s = streakOf.get(sequenceId(p.symbols));
      const windowStreak = s?.cleanStreak ?? 0;
      return {
        ...toCandidate(p),
        windowStreak,
        windowsSeen: s?.totalClean ?? 0,
        windowsExamined: windows,
        graduated: windowStreak >= minStreak,
      };
    })
    .sort((a, b) => b.strength - a.strength);

  const graduated = annotated.filter((c) => c.graduated).slice(0, opts.limit ?? 25);

  return {
    graduated,
    candidates: annotated.slice(0, opts.limit ?? 25),
    stats: {
      rowsRead: rows.length,
      droppedNonAgent: 0,
      collapsedInnerCalls: collapsed,
      decisions: events.length,
      agents: fullSpan.stats.cohorts,
      bursts: fullSpan.stats.bursts,
      distinctTools: fullSpan.stats.distinctSymbols,
      candidatesConsidered: fullSpan.stats.candidatesConsidered,
      rejected: fullSpan.stats.rejected,
      truncated: rows.length >= maxRows,
      windows,
      windowHours,
      minStreak,
      heldForEvidence: annotated.length - graduated.length,
    },
  };
}
