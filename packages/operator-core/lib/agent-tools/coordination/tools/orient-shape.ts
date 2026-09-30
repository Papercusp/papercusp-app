/**
 * orient-shape.ts — payload-tier shapers for coord:orient
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * Why orient first: the 2026-07-01 fleet incident measured ONE unshaped orient
 * at ~43k tokens (~21% of a 200k window) — `claimable` full-fat work-item rows
 * (duplicated title+summary, UUID assignees, spelled-out nulls), `me.coverage`
 * spanning 37 plans, an inbox summarizing 3,327 unread. Six sonnet members died
 * within 3 tool calls.
 *
 * Shape contract (D-004): trimmed/standard PROJECT the same orientation —
 * nothing is silently dropped: every cap leaves a count + a fetch-pointer, and
 * a caller can always pass `payloadTier: 'full'` for the unshaped result.
 */

import { shapeFleetAssignments } from '../../fleet/assignments-shape';
import { capPreservingOperativeDetailed } from '../../../operative-clause';
import { workItemFetchHint } from '../../../work-item-fetch-hint';
import { ORIENT_FACTS_RECOVERY_VIA, ORIENT_OPTIONAL_EVICTION_PRIORITY } from './orient-priority';

/** Per-tier caps. `standard` is a looser projection, not a different shape. */
const CAPS = {
  trimmed: {
    claimable: 8,
    title: 90,
    inbox: 5,
    inboxSummary: 140,
    memory: 3,
    memoryText: 220,
    events: 5,
    eventText: 220,
    catchUp: 5,
    meChars: 2_400,
    facts: 8,
    factsBody: 200,
    paneContext: 2_400,
    briefMembers: 6,
    briefLists: 5,
    briefReason: 240,
    fleetSummaries: 12,
    recoveryItems: 6,
    recoveryCheckpoint: 1_200,
    recoveryBody: 600,
  },
  standard: {
    claimable: 15,
    title: 140,
    inbox: 8,
    inboxSummary: 240,
    memory: 5,
    memoryText: 400,
    events: 8,
    eventText: 500,
    catchUp: 8,
    meChars: 6_000,
    facts: 14,
    factsBody: 400,
    paneContext: 6_000,
    briefMembers: 12,
    briefLists: 10,
    briefReason: 500,
    fleetSummaries: 24,
    recoveryItems: 8,
    recoveryCheckpoint: 1_200,
    recoveryBody: 600,
  },
} as const;

type TierName = keyof typeof CAPS;

const cap = (s: unknown, n: number): unknown => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function projectFleetSummary(row: unknown, textCap: number): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const r = row as Record<string, unknown>;
  const summary = r.summary;
  const boundedSummary =
    summary && typeof summary === 'object' && !Array.isArray(summary)
      ? Object.fromEntries(
          Object.entries(summary as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === 'string' ? cap(value, textCap) : value,
          ]),
        )
      : null;
  return {
    fleet: r.fleet,
    summary: boundedSummary,
    ...(r.unavailable === true ? { unavailable: true } : {}),
    ...(typeof r.reason === 'string' ? { reason: cap(r.reason, textCap) } : {}),
  };
}

/** Priority for keeping a standing fact when the count is capped: owner-scope
 *  (owner-walls / unverified claims) and this harness's facts are load-bearing;
 *  workspace-scope shared facts are the noisiest and drop first. Array.sort is
 *  stable, so within a rank the fold's original (recency) order is preserved. */
const FACT_SCOPE_RANK: Record<string, number> = { owner: 0, work_item: 1, harness: 1, role: 2, workspace: 3 };
const factRank = (f: unknown): number => FACT_SCOPE_RANK[(f as { scope?: string } | null)?.scope ?? ''] ?? 2;

/** The fetch-pointer for standing facts. It names `full:true` deliberately:
 *  bare `facts:list` EXCERPTS bodies by default, so pointing a reader there to
 *  recover an excerpted body hands them a second excerpt. The shared pointer
 *  enumerates every selector the orient fold can carry; a single unscoped
 *  `all:true` call is rejected by the live facts:list contract, while one
 *  concrete scope would under-recover the fold. */
const FACTS_MORE = ORIENT_FACTS_RECOVERY_VIA;

/** Population of a dropped fact set by scope, for the disclosure below. */
const countByScope = (fs: readonly unknown[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of fs) {
    const s = String((f as { scope?: string } | null)?.scope ?? 'unknown');
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
};

/** Project one claimable work-item row to its placement-relevant core.
 *  Drops the duplicated summary, null fields, timestamps, and the fat payload
 *  subtree; keeps the plan_item linkage (the "which lane" signal). */
function projectClaimable(row: unknown, titleCap: number): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  const planItem = (r.payload as Record<string, unknown> | undefined)?.plan_item;
  return {
    id: r.id,
    ...(r.kind ? { kind: r.kind } : {}),
    title: cap(r.title, titleCap),
    ...(r.state ? { state: r.state } : {}),
    ...(r.assignee ? { assignee: r.assignee } : {}),
    ...(r.severity ? { severity: r.severity } : {}),
    ...(planItem ? { plan_item: planItem } : {}),
  };
}

/** Priority for keeping a fleet member when the roster is capped (EI-19314271768708528).
 *  A leader reads `leaderBrief` to find the members that need INTERVENTION, so a naive
 *  head-slice is not merely lossy — it is inverted: on an 11-member fleet with a cap of
 *  6 it can show six healthy workers and hide the one dead member, which is the same
 *  silent-drop class this whole shaper exists to prevent. Rank the actionable rows
 *  first; healthy working members are the droppable bulk. Array.sort is stable, so the
 *  brief's own ordering is preserved within a rank. */
function briefMemberRank(m: unknown): number {
  const r = (m ?? {}) as Record<string, unknown>;
  const state = String(r.sessionState ?? '');
  const verdict = String(r.verdict ?? '');
  // Gone or wedged — the leader must relaunch/reclaim.
  if (r.stalled === true || verdict === 'dead' || verdict === 'stalled' || state === 'ended' || state === 'suspect')
    return 0;
  // About to compact, or sitting on an unanswered directed question.
  const unanswered = (r.unanswered as { count?: number } | undefined)?.count ?? 0;
  const pressure = String(r.contextPressure ?? '');
  if (pressure === 'critical' || pressure === 'high' || unanswered > 0) return 1;
  // Idle next to claimable work, benched, or dormant — recoverable throughput.
  if (r.benchSuggestion != null || r.dormant === true) return 2;
  return 3;
}

/** Project one leaderBrief member row. Keeps every field a leader ACTS on
 *  (liveness, claim, pressure, bench advice) and caps the two unbounded legs:
 *  `benchSuggestion.reason` is a ~450-char paragraph repeated per idle member, and
 *  `unanswered.newest` carries whole message bodies (already depth-omitted upstream). */
function projectBriefMember(m: unknown, titleCap: number, reasonCap: number): unknown {
  if (!m || typeof m !== 'object') return m;
  const r = m as Record<string, unknown>;
  const doing = r.doing as Record<string, unknown> | null | undefined;
  const unanswered = r.unanswered as Record<string, unknown> | null | undefined;
  const bench = r.benchSuggestion as Record<string, unknown> | null | undefined;
  return {
    agentId: r.agentId,
    ...(r.label ? { label: r.label } : {}),
    ...(r.fleetRole ? { fleetRole: r.fleetRole } : {}),
    ...(r.sessionState ? { sessionState: r.sessionState } : {}),
    ...(r.verdict ? { verdict: r.verdict } : {}),
    ...(r.wakeMode ? { wakeMode: r.wakeMode } : {}),
    ...(r.stalled === true ? { stalled: true } : {}),
    ...(r.dormant === true ? { dormant: true } : {}),
    ...(r.contextPressure ? { contextPressure: r.contextPressure } : {}),
    ...(typeof r.load === 'number' ? { load: r.load } : {}),
    ...(typeof r.queuedCount === 'number' ? { queuedCount: r.queuedCount } : {}),
    ...(typeof r.lastToolCallAgeMs === 'number' ? { lastToolCallAgeMs: r.lastToolCallAgeMs } : {}),
    ...(r.nextFireAt ? { nextFireAt: r.nextFireAt } : {}),
    ...(Array.isArray(r.workItemIds) ? { workItemIds: r.workItemIds } : {}),
    ...(doing
      ? {
          doing: { id: doing.id, title: cap(doing.title, titleCap), ...(doing.status ? { status: doing.status } : {}) },
        }
      : {}),
    // parkedOn is how a leader distinguishes "correctly parked on a gate" from "idle".
    ...(r.parkedOn != null ? { parkedOn: r.parkedOn } : {}),
    ...(r.parkedOnResolved != null ? { parkedOnResolved: r.parkedOnResolved } : {}),
    ...(unanswered
      ? {
          unanswered: {
            count: unanswered.count,
            ...(unanswered.oldestAgeMs != null ? { oldestAgeMs: unanswered.oldestAgeMs } : {}),
          },
        }
      : {}),
    ...(bench
      ? {
          benchSuggestion: {
            kind: bench.kind,
            ...(bench.item != null ? { item: bench.item } : {}),
            reason: cap(bench.reason, reasonCap),
          },
        }
      : {}),
    ...(r.isSelf === true ? { isSelf: true } : {}),
  };
}

/** Project one inbox entry to glyph-line essentials. */
function projectInboxEntry(e: unknown, summaryCap: number): unknown {
  if (!e || typeof e !== 'object') return e;
  const r = e as Record<string, unknown>;
  return {
    ...(r.ts ? { ts: r.ts } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.from ? { from: r.from } : {}),
    summary: cap(r.summary ?? r.body, summaryCap),
  };
}

/** Project noisy coord/feed-ish entries. Plan-event `before`/`after` fields can
 * carry whole plan lines or `## Now` bodies; keep identity/routing fields intact
 * and cap the prose fields so a small number of events cannot dominate orient. */
function projectEventEntry(e: unknown, textCap: number): unknown {
  if (!e || typeof e !== 'object') return e;
  const out: Record<string, unknown> = { ...(e as Record<string, unknown>) };
  for (const key of ['summary', 'detail', 'before', 'after', 'text', 'body']) {
    if (key in out) out[key] = cap(out[key], textCap);
  }
  return out;
}

/** `me` arrives as fleet:assignments' inner result. It can be either the
 *  serialized/TOON form used by older in-process callers or the raw object
 *  returned when orient deliberately bypasses the sub-read's session-tier
 *  shaper. The latter is important: a fleet-wide object has one full row per
 *  member and was the source of the 64KB orient overflow. Reuse the canonical
 *  assignments projection for object-shaped results so the two surfaces keep
 *  the same placement vocabulary and caps. */
function trimMe(me: unknown, chars: number): unknown {
  if (typeof me !== 'string') return me;
  const covIdx = me.indexOf('\ncoverage');
  const cut = covIdx > 0 ? Math.min(covIdx, chars) : chars;
  if (me.length <= cut) return me;
  return `${me.slice(0, cut)}\n… (trimmed — full assignments+coverage via fleet:assignments, or payloadTier:'full')`;
}

/** Keep reclaim rows useful without carrying the full assignment/view row into
 * the nested orient fold. The direct fleet:assignments surface owns the richer
 * row shape; orient only needs enough identity, liveness, and action signal to
 * decide whether to ask/reclaim, plus a pointer for the full read. */
function projectAssignmentAlert(row: unknown, textCap: number): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    'source',
    'agent',
    'harness',
    'plan',
    'id',
    'expires',
    'holder_present',
    'progress',
    'last_progress_at',
    'holder_heartbeat_at',
    'holder_last_tool_call_at',
    'verdict',
    'action',
  ]) {
    if (!(key in r)) continue;
    const value = r[key];
    out[key] = typeof value === 'string' ? cap(value, textCap) : value;
  }
  if (r.residue && typeof r.residue === 'object') {
    const residue = r.residue as Record<string, unknown>;
    out.residue = {
      planSlug: cap(residue.planSlug, textCap),
      itemId: cap(residue.itemId, textCap),
      effectiveStatus: cap(residue.effectiveStatus, textCap),
    };
  }
  return out;
}

function projectCoverageCollision(row: unknown, textCap: number): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  return {
    ...(r.ref != null ? { ref: cap(r.ref, textCap) } : {}),
    ...(r.directHolder != null ? { directHolder: cap(r.directHolder, textCap) } : {}),
    ...(Array.isArray(r.principals) ? { principals: r.principals.slice(0, 4).map((v) => cap(v, textCap)) } : {}),
    ...(Array.isArray(r.workItemHolders)
      ? {
          workItemHolders: r.workItemHolders.slice(0, 4).map((v) => {
            if (!v || typeof v !== 'object') return v;
            const holder = v as Record<string, unknown>;
            return {
              ...(holder.workItemId != null ? { workItemId: cap(holder.workItemId, textCap) } : {}),
              ...(holder.holder != null ? { holder: cap(holder.holder, textCap) } : {}),
            };
          }),
        }
      : {}),
  };
}

function projectCoverageDuplicate(row: unknown, textCap: number): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  return {
    ...(r.ref != null ? { ref: cap(r.ref, textCap) } : {}),
    ...(r.holder != null ? { holder: cap(r.holder, textCap) } : {}),
    ...(Array.isArray(r.workItemIds)
      ? { workItemIds: r.workItemIds.slice(0, 4).map((v) => cap(v, textCap)) }
      : {}),
  };
}

/** Project one assignment-coverage row to the placement fields an orient caller
 * can act on. `fleet:assignments` may return a coverage row with a large `links`
 * array; carrying that nested evidence through `me` is what made the generic
 * result projection amputate the post-compaction recovery block. The standalone
 * assignment shaper already uses this vocabulary for standard rows, but orient
 * also needs the same protection when a degraded/narrow assignment payload has
 * no `agents` array and therefore cannot go through that shaper. */
function projectCoverageRow(row: unknown, textCap: number): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const r = row as Record<string, unknown>;
  const workers = Array.isArray(r.workers)
    ? r.workers.map((worker) => String(worker)).join(',') || null
    : typeof r.workers === 'string'
      ? cap(r.workers, textCap)
      : null;
  return {
    plan: cap(r.plan, textCap) ?? null,
    item: cap(r.item, textCap) ?? null,
    level: cap(r.level, textCap) ?? null,
    workers,
  };
}

/** Apply the nested coverage contract even when the assignment payload is not a
 * full roster object. This is intentionally separate from projectAssignmentObject:
 * the latter requires `agents[]` to rank the caller's row, while coverage must be
 * bounded for every object-shaped `me` payload. */
function projectCoverageTable(me: unknown, tier: TierName): unknown {
  if (!me || typeof me !== 'object' || Array.isArray(me)) return me;
  const r = me as Record<string, unknown>;
  const coverage = Array.isArray(r.coverage) ? (r.coverage as unknown[]) : null;
  const collisions = Array.isArray(r.coverage_collisions)
    ? (r.coverage_collisions as unknown[])
    : null;
  const duplicates = Array.isArray(r.coverage_duplicates)
    ? (r.coverage_duplicates as unknown[])
    : null;
  if (!coverage && !collisions && !duplicates) return me;

  const textCap = tier === 'trimmed' ? 180 : 260;
  const rowCap = tier === 'trimmed' ? 0 : 24;
  const out: Record<string, unknown> = { ...r };
  if (coverage && rowCap === 0) {
    const { coverage: _coverage, ...withoutCoverage } = r;
    delete out.coverage;
    Object.assign(out, {
      ...withoutCoverage,
      coverage_note: `coverage table (${coverage.length} rows) omitted at trimmed tier — payloadTier:"standard"/"full", or narrow with {plan}`,
    });
  } else if (coverage) {
    const total = coverage.length;
    out.coverage = coverage.slice(0, rowCap).map((row) => projectCoverageRow(row, textCap));
    if (total > rowCap) {
      out.coverage_note = `nested orient coverage showing ${rowCap} of ${total}; use fleet:assignments { plan } for the full list`;
    }
  }

  const anomalyCap = tier === 'trimmed' ? 4 : 8;
  if (collisions) {
    const total = collisions.length;
    out.coverage_collisions = collisions
      .slice(0, anomalyCap)
      .map((row) => projectCoverageCollision(row, textCap));
    if (total > anomalyCap) {
      out.coverage_collisions_note = `nested orient coverage collisions showing ${anomalyCap} of ${total}; use fleet:assignments for the full list`;
    }
  }
  if (duplicates) {
    const total = duplicates.length;
    out.coverage_duplicates = duplicates
      .slice(0, anomalyCap)
      .map((row) => projectCoverageDuplicate(row, textCap));
    if (total > anomalyCap) {
      out.coverage_duplicates_note = `nested orient coverage duplicates showing ${anomalyCap} of ${total}; use fleet:assignments for the full list`;
    }
  }
  return out;
}

/**
 * Object-shaped `me` needs a second projection from the canonical assignments
 * shape. `shapeFleetAssignments` caps the standalone read, but its trimmed
 * roster still permits 40 compact rows and its reclaim rows intentionally keep
 * their richer objects. Nested inside orient, that allowance can consume the
 * whole 17KB orient budget before claimable/inbox/recovery are delivered.
 *
 * Keep intervention rows first (including the caller's own row), cap the
 * reclaim/collision lists, and disclose every nested reduction. The standalone
 * fleet:assignments call remains the fetch-pointer for anything omitted here.
 */
function projectAssignmentObject(me: unknown, tier: TierName): unknown {
  if (!me || typeof me !== 'object' || !Array.isArray((me as { agents?: unknown }).agents)) return me;
  const raw = me as Record<string, unknown>;
  const rawAgents = raw.agents as unknown[];
  // Prioritize before the canonical shaper's own 40/80-row slice. Otherwise a
  // dead or self row near the tail can be discarded before this nested orient
  // projection gets the chance to apply its intervention-first ordering.
  const prioritizedRaw = [...rawAgents].sort((a, b) => {
    const aSelf = (a as Record<string, unknown> | null)?.isSelf === true ? -10 : 0;
    const bSelf = (b as Record<string, unknown> | null)?.isSelf === true ? -10 : 0;
    return aSelf + briefMemberRank(a) - (bSelf + briefMemberRank(b));
  });
  const shaped = shapeFleetAssignments({ ...raw, agents: prioritizedRaw }, tier);
  if (!shaped || typeof shaped !== 'object' || !Array.isArray((shaped as { agents?: unknown }).agents)) return shaped;

  const d = shaped as Record<string, unknown>;
  const summary = d.summary && typeof d.summary === 'object' ? (d.summary as Record<string, unknown>) : {};
  const caps =
    tier === 'trimmed'
      ? { agents: 6, alerts: 4, collisions: 4, text: 180, coverage: 12 }
      : { agents: 12, alerts: 8, collisions: 8, text: 260, coverage: 24 };
  const assignmentAgents = d.agents as unknown[];
  const sourceAgents = assignmentAgents.filter(
    (agent: unknown) => (agent as Record<string, unknown> | null)?.agentId !== '(truncated)',
  );
  const rankedAgents = [...sourceAgents].sort((a, b) => {
    const aSelf = (a as Record<string, unknown> | null)?.isSelf === true ? -10 : 0;
    const bSelf = (b as Record<string, unknown> | null)?.isSelf === true ? -10 : 0;
    return aSelf + briefMemberRank(a) - (bSelf + briefMemberRank(b));
  });
  const agents = rankedAgents.slice(0, caps.agents);
  const out: Record<string, unknown> = { ...d, agents };

  const reportedAgents = typeof summary.agents === 'number' ? summary.agents : 0;
  const totalAgents = Math.max(reportedAgents, rawAgents.length, sourceAgents.length);
  if (totalAgents > agents.length) {
    out.agents_truncated = true;
    out.agents_returned = agents.length;
    out.agents_hint = `nested orient roster showing ${agents.length} of ${totalAgents}; use fleet:assignments { agent/plan/harness } for the full roster`;
  }

  const projectAlerts = (key: 'orphaned' | 'stalled', totalKey: 'orphaned_claims' | 'stalled_claims') => {
    const rows = Array.isArray(d[key]) ? d[key] : [];
    // A mismatched summary must not make a non-empty list look fully delivered:
    // use the larger observed population, while still preferring the canonical
    // summary when it is the authoritative (usually much larger) count.
    const reportedTotal = typeof summary[totalKey] === 'number' ? summary[totalKey] : 0;
    const total = Math.max(reportedTotal, rows.length);
    out[key] = rows.slice(0, caps.alerts).map((row) => projectAssignmentAlert(row, caps.text));
    if (total > Math.min(rows.length, caps.alerts)) {
      out[`${key}_note`] =
        `nested orient ${key} showing ${Math.min(rows.length, caps.alerts)} of ${total}; use fleet:assignments for the full list`;
    }
  };
  projectAlerts('orphaned', 'orphaned_claims');
  projectAlerts('stalled', 'stalled_claims');

  if (Array.isArray(d.coverage_collisions)) {
    const total = d.coverage_collisions.length;
    out.coverage_collisions = d.coverage_collisions
      .slice(0, caps.collisions)
      .map((row) => projectCoverageCollision(row, caps.text));
    if (total > caps.collisions) {
      out.coverage_collisions_note = `nested orient coverage collisions showing ${caps.collisions} of ${total}; use fleet:assignments for the full list`;
    }
  }
  if (Array.isArray(d.coverage_duplicates)) {
    const total = d.coverage_duplicates.length;
    out.coverage_duplicates = d.coverage_duplicates
      .slice(0, caps.collisions)
      .map((row) => projectCoverageDuplicate(row, caps.text));
    if (total > caps.collisions) {
      out.coverage_duplicates_note = `nested orient coverage duplicates showing ${caps.collisions} of ${total}; use fleet:assignments for the full list`;
    }
  }
  if (Array.isArray(d.coverage) && d.coverage.length > caps.coverage) {
    out.coverage = d.coverage.slice(0, caps.coverage);
    out.coverage_note = `nested orient coverage showing ${caps.coverage} of ${d.coverage.length}; use fleet:assignments { plan } for the full list`;
  }
  return out;
}

function projectMe(me: unknown, tier: TierName, chars: number): unknown {
  if (me && typeof me === 'object' && !Array.isArray(me)) {
    const projected = Array.isArray((me as { agents?: unknown }).agents) ? projectAssignmentObject(me, tier) : me;
    return projectCoverageTable(projected, tier);
  }
  return trimMe(me, chars);
}

/** A mutable cap set — same keys as a CAPS tier, so a rung can tighten any leg. */
type Caps = { -readonly [K in keyof (typeof CAPS)['trimmed']]: number };

/**
 * EI-19408488769901676 — THE BUDGET THE SHAPER MUST HIT ITSELF.
 *
 * The framework's contract (tooldef/payload-tier.ts) is a two-stage fallback: a result
 * over the orient tool's client-safe ceiling force-applies the smallest declared
 * shaper, and **if that shaped result is STILL over, it falls through to the GENERIC
 * bounded projection** — `projectBoundedPayload`, which knows nothing about orientation
 * and drops whole fields blind, in declaration order, with no notion of what a
 * just-respawned agent needs.
 *
 * That second stage is catastrophic here and the margin is brutal: measured live
 * 2026-08-03 on a post-compaction orient, the trimmed shaper produced **30,812 chars —
 * 812 over the ceiling (2.7%)** — and for missing it by that much the result was cut to
 * 6,360 chars with **44 fields dropped**, including the whole `inbox.entries` array and a
 * `cursor` that was truncated mid-string (so even the re-fetch instruction was unusable).
 * `leaderBrief` was lost the same way before it got a shaper (EI-19314271768708528): the
 * recurring lesson is that REACHING the generic budget pass is the failure, not the tier.
 *
 * Worse, the overshoot was SELF-INFLICTED and aimed at exactly the wrong case. The
 * post-compaction fold below deliberately BEEFS the inbox (cap 5 → 20, summaries 140 →
 * 700) because a just-compacted agent lost its message context — so `afterCompaction`,
 * the one call that most needs a complete picture, is also the one most likely to overshoot,
 * and the blind fallback then discards the very inbox the fold added. The fold defeated
 * itself in precisely the situation it was written for.
 *
 * So the smallest shaper now owns its own budget and NEVER hands work to the generic
 * projector for the normal orient path: `shapeOrient(..., 'trimmed')` walks a ladder
 * of progressively tighter cap sets until it fits. The standard projection remains a
 * looser tier shape; when it exceeds the tool ceiling, the framework deliberately falls
 * back to this bounded trimmed shaper.
 *
 * ⚠ The orient tool deliberately sets its own client-safe ceiling below the shared
 * framework ceiling. Keep this shaper budget below that tool ceiling as well, with
 * enough room for the transport envelope. The ladder is a LAST-RESORT rescue for a
 * payload that would otherwise be rejected or blind-projected — it is not an opinion
 * about the normal size of an orientation. Every char of margin below the tool ceiling
 * is a band in which a payload that would otherwise be served intact gets tightened for
 * no benefit, so the margin is intentionally small and must be measured before widening.
 */
export const SHAPER_BUDGET_CHARS = 17_000;

/** The tightest rung: what orientation still means when almost nothing fits. Also the
 *  per-key clamp for intermediate rungs, so tightening can never drive a cap to 0 and
 *  silently empty a list (an empty list reads as "nothing there", the exact silent-drop
 *  this whole shaper exists to prevent — every rung still leaves the D-004 pointers). */
const FLOOR_CAPS: Caps = {
  claimable: 4,
  title: 60,
  inbox: 3,
  inboxSummary: 100,
  memory: 1,
  memoryText: 120,
  events: 2,
  eventText: 120,
  catchUp: 2,
  meChars: 1_200,
  facts: 4,
  factsBody: 100,
  paneContext: 800,
  briefMembers: 4,
  briefLists: 3,
  briefReason: 120,
  fleetSummaries: 6,
  // EI: `recovery` used to be an UNCAPPED passthrough, which made the ladder
  // mathematically unable to reach budget on the ONE path where `recovery` exists
  // and is the LARGEST field. Measured on a real post-compaction payload: floor
  // came out at 23,786 chars vs a 17,000 budget, with recovery 7,320 of it (30.8%)
  // — larger than the whole 6,786-char overflow. See projectRecovery below.
  recoveryItems: 2,
  recoveryCheckpoint: 400,
  recoveryBody: 200,
};

/** Scale every cap toward FLOOR_CAPS, clamped so no leg drops below the floor. */
function tightenCaps(c: Caps, factor: number): Caps {
  const out = { ...c };
  for (const k of Object.keys(out) as (keyof Caps)[]) {
    out[k] = Math.max(FLOOR_CAPS[k], Math.floor(out[k] * factor));
  }
  return out;
}

const jsonLen = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    // A shaper must never break a call (D-004). An unserializable payload cannot be
    // measured, so treat it as over-budget and let the ladder tighten rather than throw.
    return Number.POSITIVE_INFINITY;
  }
};

interface OrientOmittedLeg {
  leg: string;
  tier: 3 | 4;
  fields: string[];
  recoverVia: string;
}

const tightenedMarker = (rung: string, omitted?: readonly OrientOmittedLeg[]) => ({
  rung,
  budgetChars: SHAPER_BUDGET_CHARS,
  reason:
    omitted && omitted.length > 0
      ? 'orientation still exceeded the shaper budget at floor caps; omitted only declared recoverable optional legs in shared tier-4-then-tier-3 priority order (EI-20213176698128052)'
      : `orientation exceeded the shaper budget at the initial caps; tightened in-shaper rather than falling through to the generic bounded projection (EI-19408488769901676)`,
  more: "payloadTier:'full' for the unshaped result",
});

/**
 * Last-resort floor eviction. Semantic list/body caps have already reached their
 * minimum here, so the only safe remaining lever is the assembler's declared set
 * of recoverable optional legs. Every omission is explicit and names its recovery
 * path; core, recovery, leaderBrief, and laneClaim are not in the candidate data.
 */
function evictOptionalFloorLegs(projected: Record<string, unknown>): Record<string, unknown> {
  const omitted: OrientOmittedLeg[] = [];

  for (const leg of ORIENT_OPTIONAL_EVICTION_PRIORITY) {
    const fields = leg.fields.filter((field) => Object.prototype.hasOwnProperty.call(projected, field));
    if (fields.length === 0) continue;
    for (const field of fields) delete projected[field];
    omitted.push({ leg: leg.name, tier: leg.tier, fields, recoverVia: leg.recoverVia });
    projected.optionalLegsOmitted = {
      reason: 'floor-budget recovery; omissions follow shared orient priority',
      omitted: [...omitted],
      more: "payloadTier:'full' for the complete result",
    };
    projected.shaperTightened = tightenedMarker('floor-optional-eviction', omitted);
    if (jsonLen(projected) <= SHAPER_BUDGET_CHARS) return projected;
  }

  if (omitted.length > 0) {
    projected.optionalLegsOmitted = {
      reason: 'floor-budget recovery; omissions follow shared orient priority',
      omitted,
      more: "payloadTier:'full' for the complete result",
    };
  }
  return projected;
}

/** Re-cap an ALREADY-disclosed excerpt WITHOUT lying about how much is missing.
 *
 *  The upstream recovery fold (compaction-recovery.ts) caps each held item's
 *  checkpoint/body at a FIXED size and attaches a `{ keptChars, totalChars,
 *  withheldChars, more }` disclosure. When a tighter rung re-caps that excerpt, a
 *  naive re-run would recompute `totalChars` from the EXCERPT — reporting "300 of
 *  1,200 withheld" for a checkpoint whose real body is 20,000 chars. That
 *  under-reports the gap, which is a silent-loss regression in the very code that
 *  exists to prevent one. Compose instead: keep the ORIGINAL total and recompute
 *  what is missing against it. */
function recapDisclosed(
  text: unknown,
  prior: unknown,
  max: number,
  more: string | undefined,
): { text: string; truncation?: Record<string, unknown> } | null {
  if (typeof text !== 'string') return null;
  const p = prior && typeof prior === 'object' ? (prior as Record<string, unknown>) : null;
  const originalTotal = typeof p?.totalChars === 'number' ? p.totalChars : text.length;
  const r = capPreservingOperativeDetailed(text, max, more ? { more } : undefined);
  // Nothing was cut here and nothing had been cut upstream ⇒ nothing to disclose.
  if (!r.truncation && !p) return { text: r.text };
  const kept = r.text.length;
  return {
    text: r.text,
    truncation: {
      ...p,
      ...(r.truncation as Record<string, unknown> | undefined),
      keptChars: kept,
      totalChars: originalTotal,
      withheldChars: Math.max(0, originalTotal - kept),
      ...(more ? { more } : {}),
    },
  };
}

/** Bring `recovery` under the ladder.
 *
 *  Why this exists: `recovery` used to be an UNCAPPED passthrough. The passthrough
 *  guarantee (see projectOrient below) is good reasoning — "a tighter rung can only
 *  SHRINK the capped lists, never drop a whole field" — but it made the ladder
 *  MATHEMATICALLY unable to reach budget on the afterCompaction path, the one path
 *  where `recovery` exists and is the largest field. The ladder floored every other
 *  leg and still overflowed, then fell through to the generic bounded projector,
 *  which drops WHOLE FIELDS — destroying the very guarantee the passthrough was
 *  protecting. Exempting `recovery` from the ladder is what got `recovery` dropped.
 *
 *  So: shrink it here instead, keeping the field PRESENT, the operative clause
 *  intact, and every omission disclosed with a fetch pointer (D-004). */
function projectRecovery(rec: unknown, c: Caps): unknown {
  if (!rec || typeof rec !== 'object') return rec;
  const r = rec as Record<string, unknown>;
  if (!Array.isArray(r.checkpoints)) return rec;
  const all = r.checkpoints;
  const kept = all.slice(0, c.recoveryItems);
  const out: Record<string, unknown> = { ...r };
  out.checkpoints = kept.map((e) => {
    if (!e || typeof e !== 'object') return e;
    const h = e as Record<string, unknown>;
    // EI-20451119672468393: keep the re-cap hint harness-qualified — the row's
    // canonical harness may differ from the reading session's scope.
    const more =
      typeof h.id === 'string'
        ? workItemFetchHint(h.id, typeof h.harness === 'string' ? h.harness : null)
        : undefined;
    const ckpt = recapDisclosed(h.checkpoint, h.checkpointTruncated, c.recoveryCheckpoint, more);
    const body = recapDisclosed(h.body, h.bodyTruncated, c.recoveryBody, more);
    const o: Record<string, unknown> = { ...h };
    if (ckpt) {
      o.checkpoint = ckpt.text;
      if (ckpt.truncation) o.checkpointTruncated = ckpt.truncation;
    }
    if (body) {
      o.body = body.text;
      if (body.truncation) o.bodyTruncated = body.truncation;
    }
    return o;
  });
  if (all.length > kept.length) {
    out.checkpointsTruncated = {
      total: all.length,
      shown: kept.length,
      more: 'work_items:list { mine: true }',
    };
  }
  return out;
}

/** Project an OrientResult at EXACTLY the given caps. Unknown fields pass through
 *  untouched — that passthrough is what makes the ladder safe: a tighter rung can only
 *  SHRINK the capped lists, never drop a whole field. So `control`, `self` and any future
 *  top-level key survive every rung, which is precisely the guarantee the generic
 *  projector could not make.
 *
 *  `recovery` is the one field that had to move from "passthrough" to "capped". It is
 *  still never DROPPED — that guarantee is unchanged — but it is now SHRUNK per rung,
 *  because leaving the afterCompaction path's largest field outside the ladder made the
 *  budget unreachable and handed the payload to the generic projector, which drops whole
 *  fields. See projectRecovery. */
function projectOrient(d: Record<string, unknown>, c: Caps, tier: TierName): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d };
  out.payloadTier = tier;

  out.me = projectMe(d.me, tier, c.meChars);

  // The one former passthrough that had to come under the ladder — see projectRecovery.
  if (d.recovery != null) out.recovery = projectRecovery(d.recovery, c);

  if (Array.isArray(d.claimable)) {
    const delivered = d.claimable.length;
    out.claimable = d.claimable.slice(0, c.claimable).map((r) => projectClaimable(r, c.title));
    const shown = Math.min(delivered, c.claimable);
    // EI-20113865649946366 — the claimable list is cut TWICE and only the handler can
    // measure the first cut, so this rung must not overwrite what it was told.
    //
    // `d.claimable.length` is the length of the list the handler HANDED DOWN, already
    // bounded by its own `claimableLimit`. Publishing that as `total` is precisely how
    // orient reported `total: 20` while the oracle's authoritative count was ~1677 —
    // a bounded measurement rendered as a population, which is worse than silence
    // because a confident number does not invite a re-read.
    //
    // The handler emits `claimableTruncated` IFF its own fetch was incomplete, so its
    // ABSENCE is itself informative: the handed-down list is the whole lane, and
    // `delivered` is then a genuine total. Hence the two branches.
    const upstream = d.claimableTruncated as Record<string, unknown> | undefined;
    if (upstream && typeof upstream === 'object') {
      // Carry the authoritative facts; only re-state what THIS rung changed.
      out.claimableTruncated = { ...upstream, shown };
    } else if (delivered > c.claimable) {
      out.claimableTruncated = { total: delivered, shown, more: 'work_items:list (or payloadTier:"full")' };
    }
  }

  // Standing facts are folded VERBATIM and grow unboundedly as agents assert
  // them (the coord:orient 59.8KB overflow, WI-2859). Cap count + body, keeping
  // owner/harness-scope facts first, with a fetch-pointer for the rest.
  //
  // The BODY cap uses the operative-preserving cap, not the bare `cap` — the same
  // move the memory leg already made (EI-20113865649946366: a bare '…' names no
  // fetch path and is indistinguishable from an ellipsis in the text itself). A
  // standing fact is the one payload whose tail is routinely an IMPERATIVE, so the
  // bare cap was severing directives: measured on a live 24-fact fold, FOUR
  // operative clauses sat past the 200-char cut and were delivered as '…' —
  // including "DO NOT retry — the error says so explicitly", whose loss makes an
  // agent retry a call the fact exists to stop. The sibling read path (facts:list)
  // already preserves exactly these clauses, so the two paths disagreed about the
  // same fact, and orient is the one every agent gets on every wake.
  if (Array.isArray(d.facts)) {
    const total = d.facts.length;
    const ranked = [...d.facts].sort((a, b) => factRank(a) - factRank(b));
    let bodiesCut = 0;
    out.facts = ranked.slice(0, c.facts).map((f) => {
      if (!f || typeof f !== 'object') return f;
      const r = f as Record<string, unknown>;
      const shaped = recapDisclosed(r.body, r.bodyTruncated, c.factsBody, FACTS_MORE);
      if (!shaped) return r;
      if (shaped.truncation) bodiesCut += 1;
      return { ...r, body: shaped.text };
    });
    if (total > c.facts) {
      // `droppedByScope` because this drop is RANKED, not random: factRank sorts
      // workspace-scope LAST, so a fold carrying enough harness facts drops EVERY
      // workspace fact. Measured on the same live fold: 12 harness / 12 workspace
      // at a cap of 8 dropped 100% of the workspace scope. A bare {total, shown}
      // reads as "16 random extras"; the truth was "an entire scope class is gone",
      // which is what a reader needs before trusting this as their view of facts.
      out.factsTruncated = {
        total,
        shown: c.facts,
        more: FACTS_MORE,
        droppedByScope: countByScope(ranked.slice(c.facts)),
      };
    }
    // One aggregate rather than a per-fact object: the marker has to be cheap
    // enough that disclosure is not itself the thing that busts the budget.
    if (bodiesCut > 0) out.factsBodiesTruncated = { facts: bodiesCut, cap: c.factsBody, more: FACTS_MORE };
  }

  const inbox = d.inbox as { summary?: unknown; recent?: unknown } | undefined;
  if (inbox && typeof inbox === 'object') {
    // fold #2 (compaction-fold-audit-2026-07-06): a post-compaction orient (recovery
    // block present ⇒ afterCompaction) carries a deliberately BEEFED inbox — a
    // just-compacted agent lost its message context, so the inbox re-cap is relaxed
    // rather than re-truncating away the very entries/bodies the fold added.
    //
    // EI-19408488769901676: that beef now lives in the CAP SET (`shapeOrient`'s first
    // ladder rung) instead of being hardcoded here, so when it overshoots the budget the
    // ladder can walk it back one rung at a time. Previously it was unconditional, which
    // pushed the payload past the hard ceiling and handed the whole result to the generic
    // projector — which then dropped the entire inbox, i.e. strictly WORSE than the
    // un-beefed shape the fold was improving on.
    const inboxCap = c.inbox;
    const inboxSummaryCap = c.inboxSummary;
    const recent = Array.isArray(inbox.recent) ? inbox.recent : [];
    const projectedRecent = recent.slice(-inboxCap).map((e) => projectInboxEntry(e, inboxSummaryCap));
    out.inbox = {
      summary: inbox.summary,
      recent: projectedRecent,
      // EI-18667514339699744: keep `entries` aliased to the SAME projected/capped
      // array as `recent` through tier-shaping too — reconstructing `inbox` here
      // without it would silently re-drop the alias for trimmed/standard sessions
      // (the common fleet-member case) even after coord:orient/coord:inbox added it.
      entries: projectedRecent,
      ...(recent.length > inboxCap
        ? { recentTruncated: { total: recent.length, shown: inboxCap, more: 'coord:inbox' } }
        : {}),
    };
  }

  const memory = d.memory as
    | {
        query?: unknown;
        hits?: unknown[];
        degraded?: unknown;
        degradedReason?: unknown;
        withheld?: unknown;
        filteredLowScore?: unknown;
        withheldBudget?: unknown;
        note?: unknown;
        bodiesTruncated?: unknown;
        scoreScale?: unknown;
      }
    | null
    | undefined;
  if (memory && typeof memory === 'object' && Array.isArray(memory.hits)) {
    const shapedHits = memory.hits.slice(0, c.memory).map((h) => {
      if (!h || typeof h !== 'object') return h;
      const r = h as Record<string, unknown>;
      // EI-20113865649946366: `cap` appends a bare '…', which is not a disclosure — it
      // names no fetch path and is indistinguishable from an ellipsis in the text
      // itself. If THIS rung is what cut the body, raise the same structural flag the
      // handler raises, so a clipped body is never delivered unmarked at either layer.
      const clippedHere = typeof r.memory === 'string' && r.memory.length > c.memoryText;
      return {
        ...r,
        memory: cap(r.memory, c.memoryText),
        ...(clippedHere ? { truncated: true as const } : {}),
      };
    });
    // Recomputed over the hits ACTUALLY delivered by this rung, because both the
    // population and the clipping change here: the handler's count was taken over its
    // own admitted set at its own cap. Carrying its number through unchanged would
    // under-report exactly when this rung clipped more — and a disclosure that is wrong
    // in the unsafe direction is worse than none.
    const clippedDelivered = shapedHits.reduce<number>(
      (n, h) => n + (h && typeof h === 'object' && (h as Record<string, unknown>).truncated === true ? 1 : 0),
      0,
    );
    const upstreamBodies = memory.bodiesTruncated as Record<string, unknown> | undefined;
    out.memory = {
      query: memory.query,
      hits: shapedHits,
      // EI-9031 class: a loud marker the handler raised must survive this rung. Rebuilt
      // rather than spread, so `cap` and `hits` stay the only things this rung restates.
      ...(clippedDelivered > 0
        ? {
            bodiesTruncated: {
              ...(upstreamBodies && typeof upstreamBodies === 'object' ? upstreamBodies : {}),
              hits: clippedDelivered,
              cap: Math.min(c.memoryText, typeof upstreamBodies?.cap === 'number' ? upstreamBodies.cap : c.memoryText),
              more:
                typeof upstreamBodies?.more === 'string'
                  ? upstreamBodies.more
                  : 'memory:search { query } for the full body',
            },
          }
        : {}),
      ...(memory.hits.length > c.memory
        ? { hitsTruncated: { total: memory.hits.length, shown: c.memory, more: 'memory:search' } }
        : {}),
      // EI-9031: carry the LOUD scalar markers through tier-shaping — a trimmed/
      // standard session (a fleet member — the exact case this ticket reports) must
      // still see `degraded` so an empty `hits` isn't read as an informative empty
      // during an embedding-backend outage. `withheld`/`filteredLowScore` are the
      // same class of loud marker and were being silently dropped here too.
      ...(memory.degraded === true ? { degraded: true } : {}),
      ...(typeof memory.degradedReason === 'string' ? { degradedReason: memory.degradedReason } : {}),
      ...(typeof memory.withheld === 'number' ? { withheld: memory.withheld } : {}),
      ...(typeof memory.filteredLowScore === 'number' ? { filteredLowScore: memory.filteredLowScore } : {}),
      // orient-recall-quality P-002/P-003: same loud-marker class — the budget
      // drop count and the non-exhaustive advisory must reach trimmed sessions
      // (fleet members are exactly who acts on them).
      ...(typeof memory.withheldBudget === 'number' ? { withheldBudget: memory.withheldBudget } : {}),
      ...(typeof memory.note === 'string' ? { note: memory.note } : {}),
      ...(memory.scoreScale === 'cosine' ||
      memory.scoreScale === 'rrf' ||
      memory.scoreScale === 'lexical' ||
      memory.scoreScale === 'unknown'
        ? { scoreScale: memory.scoreScale }
        : {}),
    };
  }

  const events = d.planEvents as { total?: number; recent?: unknown[] } | null | undefined;
  if (events && typeof events === 'object' && Array.isArray(events.recent)) {
    const total = events.recent.length;
    out.planEvents = {
      total: events.total,
      recent: events.recent.slice(-c.events).map((e) => projectEventEntry(e, c.eventText)),
      ...(total > c.events ? { recentTruncated: { shown: c.events, more: 'coord:plan-events' } } : {}),
    };
  }

  // P-016 (voice-public-release-readiness-2026-07-12): the papercup pane digest is
  // a rendered markdown block (several KB when the system is busy) — cap by chars
  // with the D-004 fetch-pointer. `deepWork` is already bounded at source (newest
  // capped at 3, short summaries) and passes through untouched.
  if (typeof d.paneContext === 'string' && d.paneContext.length > c.paneContext) {
    out.paneContext = `${d.paneContext.slice(0, c.paneContext)}\n… (trimmed — drill in via curation:feed / curation:state-of-pot / fleet:assignments, or payloadTier:'full')`;
  }

  // EI-19314271768708528: `leaderBrief` had NO shaper, so it reached the budget pass
  // full-fat and was dropped WHOLE — on a monitor wake (the mode that exists to deliver
  // it) the leader was left with `me`, its own one-row assignment view, which reads
  // exactly like a fleet-wide verdict of one live agent and zero stalled. Project it
  // like every other leg instead: `summary` is ~20 scalars carrying every aggregate
  // alert (dead / stalled / idle_with_claimable / unowned_criticals) and is the highest
  // value-per-byte field in the whole result, so it is kept WHOLE and the roster is what
  // yields — with the D-004 count + fetch-pointer.
  const brief = d.leaderBrief as Record<string, unknown> | null | undefined;
  if (brief && typeof brief === 'object') {
    const out2: Record<string, unknown> = { ...brief };
    if (Array.isArray(brief.members)) {
      const total = brief.members.length;
      const ranked = [...brief.members].sort((a, b) => briefMemberRank(a) - briefMemberRank(b));
      out2.members = ranked.slice(0, c.briefMembers).map((m) => projectBriefMember(m, c.title, c.briefReason));
      if (total > c.briefMembers) {
        out2.membersTruncated = {
          total,
          shown: c.briefMembers,
          ranked: 'actionable-first (dead/stalled → pressured/unanswered → idle/benched → healthy)',
          more: 'fleet:leader-brief',
        };
      }
    }
    // The advisory rosters are unbounded work-item lists (18 unowned criticals in the
    // reporting incident); cap with a pointer rather than letting them crowd out members.
    for (const key of ['unownedCriticals', 'abandonedUnclaimed', 'orphaned', 'stalled']) {
      const list = brief[key];
      if (Array.isArray(list) && list.length > c.briefLists) {
        out2[key] = list.slice(0, c.briefLists);
        out2[`${key}Truncated`] = { total: list.length, shown: c.briefLists, more: 'fleet:leader-brief' };
      }
    }
    out.leaderBrief = out2;
  }

  const fleetSummaries = d.fleetSummaries;
  if (Array.isArray(fleetSummaries)) {
    const total = fleetSummaries.length;
    out.fleetSummaries = fleetSummaries
      .slice(0, c.fleetSummaries)
      .map((row) => projectFleetSummary(row, c.briefReason));
    if (total > c.fleetSummaries) {
      out.fleetSummariesTruncated = {
        total,
        shown: c.fleetSummaries,
        more: 'coord:orient { mode: "monitor" } / fleet:leader-brief',
      };
    }
  }

  const catchUp = d.fleetCatchUp as { fleet?: unknown; total?: number; recent?: unknown[] } | null | undefined;
  if (catchUp && typeof catchUp === 'object' && Array.isArray(catchUp.recent)) {
    const total = catchUp.recent.length;
    out.fleetCatchUp = {
      ...catchUp,
      recent: catchUp.recent.slice(-c.catchUp).map((e) => projectEventEntry(e, c.eventText)),
      ...(total > c.catchUp ? { recentTruncated: { shown: c.catchUp, more: 'coord:catch-up' } } : {}),
    };
  }

  return out;
}

/**
 * Tier-project an OrientResult-shaped payload, guaranteeing the result fits
 * `SHAPER_BUDGET_CHARS` so it never reaches the framework's generic bounded projection.
 *
 * Walks a ladder of progressively tighter cap sets and returns the FIRST rung that fits:
 *
 *   0. post-compaction beef (only when `recovery` is present) — the most generous shape,
 *      and the current behaviour, so a payload that already fit is byte-identical.
 *      Ordinary calls start at the plain per-tier caps instead.
 *   1. the plain trimmed caps — walks back the beef rather than the whole payload.
 *   2. half the trimmed caps, floor-clamped.
 *   3. FLOOR_CAPS — the tightest orientation that is still orientation.
 *
 * Rung 0 fitting is the common case, so this costs one `JSON.stringify` on the happy path.
 *
 * Why a ladder and not simply "exempt orient from trimming" (the regression's tempting
 * fix): the hard ceiling is a TRANSPORT limit, not a preference — an over-cap result is
 * rejected or file-dumped by the client, which is worse than any downgrade. The payload
 * genuinely has to shrink. The bug was never that it shrank; it was that the shrinking
 * was done by a projector with no idea which fields carry the orientation. Shrinking
 * HERE keeps that judgement in the one place that has it, and every rung still emits
 * the D-004 counts + fetch-pointers, so nothing is silently dropped.
 */
export function shapeOrient(data: unknown, tier: TierName): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as Record<string, unknown>;
  const base: Caps = { ...CAPS[tier] };
  const afterCompaction = d.recovery != null;

  // The framework's hard-ceiling fallback always selects the smallest declared
  // shaper. Keep the standard projection's established looser shape byte-compatible;
  // only the trimmed shaper must guarantee the client-safe bound.
  if (tier !== 'trimmed') return projectOrient(d, base, tier);

  const ladder: { caps: Caps; rung: string }[] = afterCompaction
    ? [
        {
          caps: { ...base, inbox: Math.max(base.inbox, 20), inboxSummary: Math.max(base.inboxSummary, 700) },
          rung: 'post-compaction',
        },
        { caps: base, rung: tier },
        { caps: tightenCaps(base, 0.5), rung: `${tier}-half` },
        { caps: FLOOR_CAPS, rung: 'floor' },
      ]
    : [
        // Ordinary orient calls still need the client-safe bound when the tool's
        // default/full path is selected after WI-37843's session-tier opt-out.
        { caps: base, rung: tier },
        { caps: tightenCaps(base, 0.5), rung: `${tier}-half` },
        { caps: FLOOR_CAPS, rung: 'floor' },
      ];

  let projected: Record<string, unknown> | undefined;
  for (let i = 0; i < ladder.length; i++) {
    const { caps, rung } = ladder[i];
    projected = projectOrient(d, caps, tier);
    const size = jsonLen(projected);
    if (size <= SHAPER_BUDGET_CHARS) {
      // Only annotate when we actually stepped down, so the common case stays clean.
      if (i > 0) {
        projected.shaperTightened = tightenedMarker(rung);
        // The disclosure is part of the payload too. If adding it crosses the
        // boundary, continue down the ladder instead of returning an over-budget
        // object that merely *claimed* to fit.
        if (jsonLen(projected) > SHAPER_BUDGET_CHARS) continue;
      }
      return projected;
    }
  }

  // Even FLOOR_CAPS overflowed. Enforce the assembler's shared optional-leg
  // priority before conceding: tier 4 is independently re-fetchable and tier 3 is
  // re-delivered by the transition substrate, so disclosed eviction is safer than
  // letting the generic projector drop arbitrary whole fields.
  if (projected) {
    projected = evictOptionalFloorLegs(projected);
    if (jsonLen(projected) <= SHAPER_BUDGET_CHARS) return projected;
    projected.shaperTightened = {
      rung: 'floor',
      budgetChars: SHAPER_BUDGET_CHARS,
      overBudget: true,
      reason:
        'orientation exceeds the shaper budget even after floor caps and every declared recoverable optional leg were removed; protected core/recovery fields remain too large, so the generic bounded projection may still drop whole fields',
      more: "payloadTier:'full' for the unshaped result",
    };
  }
  return projected;
}
