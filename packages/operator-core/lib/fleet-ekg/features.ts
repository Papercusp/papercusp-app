/**
 * features.ts — the Fleet EKG's per-session behavioral embedding
 * (self-learning-frontier-2026-06-12 P-030 / FB-10). PURE — no PG, no LLM.
 *
 * Input: one agent session's completed tool calls (the `phase='post'` rows of
 * harness_shared.agent_activity, time-ordered). Output: a fixed-shape
 * SessionVector — named numeric features plus two categorical distributions
 * (tool-category mix + category bigrams). v1 is deliberately LLM-free: the
 * embedding is hand-named features, so every detected shift can say WHICH
 * behavior moved (drift.ts) and the report stays inspectable.
 *
 * The substrate is agent_activity, NOT tool_invocations: the invocations
 * table's spawn_id is per-call / per-surface (palette, dev-page) for the bulk
 * of traffic and cannot group a session — see
 * agent-insights/fleet-ekg-session-substrate. agent_activity carries the
 * per-CLI worker stream (native Bash/Edit/Read AND mcp__* dispatches) keyed
 * by (owner_id, session_id).
 *
 * NUMERIC_FEATURES is the registry drift.ts iterates — add a feature by
 * adding an extractor here; storage (jsonb) and drift detection pick it up
 * with no schema change.
 */

/** One completed tool call (an agent_activity phase='post' row). */
export interface SessionEvent {
  toolName: string;
  /** 'ok' | 'error' | null (null = outcome unreported — excluded from error rate). */
  status: string | null;
  /** Event time, epoch ms. */
  atMs: number;
}

/** A session's raw event stream plus its identity. */
export interface SessionEvents {
  ownerId: string;
  sessionId: string;
  agent: string | null;
  harnessSlug: string | null;
  /** Time-ordered completed calls. */
  events: SessionEvent[];
}

export interface SessionVector {
  ownerId: string;
  sessionId: string;
  agent: string | null;
  harnessSlug: string | null;
  startedAtMs: number;
  endedAtMs: number;
  eventCount: number;
  /** Named numeric features (NUMERIC_FEATURES keys). */
  features: Record<string, number>;
  /** Tool-category counts (TOOL_CATEGORIES members). */
  toolMix: Record<string, number>;
  /** Consecutive-category bigram counts, keyed "a>b". */
  bigrams: Record<string, number>;
}

/** Sessions below this many completed calls have no "behavior" to embed. */
export const MIN_SESSION_EVENTS = 10;

export const TOOL_CATEGORIES = [
  'bash',
  'read',
  'edit',
  'task',
  'agent',
  'search',
  'locks',
  'coord',
  'mcp',
  'other',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Collapse a raw tool name into its behavioral category. */
export function categorize(toolName: string): ToolCategory {
  const t = toolName.toLowerCase();
  if (t === 'bash' || t === 'bashoutput' || t === 'killshell') return 'bash';
  if (t === 'read' || t === 'glob' || t === 'grep' || t === 'ls' || t === 'notebookread') return 'read';
  if (t === 'edit' || t === 'write' || t === 'multiedit' || t === 'notebookedit') return 'edit';
  if (
    t.startsWith('task') ||
    t === 'todowrite' ||
    t === 'update_plan' ||
    t === 'todo_write' ||
    t === 'exitplanmode' ||
    t === 'enterplanmode'
  ) {
    return 'task';
  }
  if (t === 'agent' || t === 'workflow') return 'agent';
  if (t === 'toolsearch' || t === 'websearch' || t === 'webfetch') return 'search';
  if (t.startsWith('mcp__')) {
    if (t.includes('locks_')) return 'locks';
    if (t.includes('coord_') || t.includes('events_') || t.includes('messages_')) return 'coord';
    return 'mcp';
  }
  return 'other';
}

const quantileOfSorted = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const share = (mix: Record<string, number>, cat: ToolCategory, total: number): number =>
  total > 0 ? (mix[cat] ?? 0) / total : 0;

interface Derived {
  events: SessionEvent[];
  mix: Record<string, number>;
  gapsMs: number[];
}

/**
 * The named numeric feature registry — drift.ts walks these keys. Every
 * extractor must be total (return a finite number for any session with ≥1
 * event); rates are 0..1, times are ms.
 */
export const NUMERIC_FEATURES: Record<string, (d: Derived) => number> = {
  /** Session size — calls completed. */
  eventCount: (d) => d.events.length,
  /** Wall-clock span of the session, ms. */
  durationMs: (d) => (d.events.length > 1 ? d.events[d.events.length - 1].atMs - d.events[0].atMs : 0),
  /** error / (ok + error) — null-status calls excluded. */
  errorRate: (d) => {
    let ok = 0;
    let err = 0;
    for (const e of d.events) {
      if (e.status === 'ok') ok += 1;
      else if (e.status === 'error') err += 1;
    }
    return ok + err > 0 ? err / (ok + err) : 0;
  },
  /** Median gap between consecutive calls, ms — the session's base pace. */
  medianGapMs: (d) => quantileOfSorted([...d.gapsMs].sort((a, b) => a - b), 0.5),
  /** p90 gap, ms — stall/think pauses. */
  p90GapMs: (d) => quantileOfSorted([...d.gapsMs].sort((a, b) => a - b), 0.9),
  /** Coefficient of variation of gaps — bursty vs steady rhythm. */
  burstiness: (d) => {
    if (d.gapsMs.length < 3) return 0;
    const mean = d.gapsMs.reduce((a, b) => a + b, 0) / d.gapsMs.length;
    if (mean <= 0) return 0;
    const variance = d.gapsMs.reduce((a, b) => a + (b - mean) ** 2, 0) / d.gapsMs.length;
    return Math.sqrt(variance) / mean;
  },
  /** Consecutive same-TOOL repeats / transitions — grind/retry rhythm. */
  repeatRate: (d) => {
    if (d.events.length < 2) return 0;
    let repeats = 0;
    for (let i = 1; i < d.events.length; i++) {
      if (d.events[i].toolName === d.events[i - 1].toolName) repeats += 1;
    }
    return repeats / (d.events.length - 1);
  },
  /** Same tool re-invoked immediately after its error / errors — retry reflex. */
  retryAfterErrorRate: (d) => {
    let errors = 0;
    let retried = 0;
    for (let i = 0; i < d.events.length; i++) {
      if (d.events[i].status !== 'error') continue;
      errors += 1;
      if (i + 1 < d.events.length && d.events[i + 1].toolName === d.events[i].toolName) retried += 1;
    }
    return errors > 0 ? retried / errors : 0;
  },
  /** Lock-tool share of all calls — contention pressure. */
  locksShare: (d) => share(d.mix, 'locks', d.events.length),
  /** Edit-category share — how write-heavy the work is. */
  editShare: (d) => share(d.mix, 'edit', d.events.length),
  /** Bash share — how shell-heavy. */
  bashShare: (d) => share(d.mix, 'bash', d.events.length),
  /** Read share — how exploration-heavy. */
  readShare: (d) => share(d.mix, 'read', d.events.length),
  /** Coordination share (coord/events/messages) — substrate chatter. */
  coordShare: (d) => share(d.mix, 'coord', d.events.length),
};

export const NUMERIC_FEATURE_KEYS: readonly string[] = Object.keys(NUMERIC_FEATURES);

/**
 * Embed one session. Returns null when the stream is too small to carry
 * behavior (< MIN_SESSION_EVENTS — counted, so callers can report skips).
 */
export function embedSession(session: SessionEvents, minEvents = MIN_SESSION_EVENTS): SessionVector | null {
  const events = [...session.events].sort((a, b) => a.atMs - b.atMs);
  if (events.length < minEvents) return null;

  const mix: Record<string, number> = {};
  const bigrams: Record<string, number> = {};
  let prevCat: ToolCategory | null = null;
  for (const e of events) {
    const cat = categorize(e.toolName);
    mix[cat] = (mix[cat] ?? 0) + 1;
    if (prevCat !== null) {
      const key = `${prevCat}>${cat}`;
      bigrams[key] = (bigrams[key] ?? 0) + 1;
    }
    prevCat = cat;
  }
  const gapsMs: number[] = [];
  for (let i = 1; i < events.length; i++) gapsMs.push(events[i].atMs - events[i - 1].atMs);

  const derived: Derived = { events, mix, gapsMs };
  const features: Record<string, number> = {};
  for (const [key, extract] of Object.entries(NUMERIC_FEATURES)) {
    const v = extract(derived);
    features[key] = Number.isFinite(v) ? v : 0;
  }

  return {
    ownerId: session.ownerId,
    sessionId: session.sessionId,
    agent: session.agent,
    harnessSlug: session.harnessSlug,
    startedAtMs: events[0].atMs,
    endedAtMs: events[events.length - 1].atMs,
    eventCount: events.length,
    features,
    toolMix: mix,
    bigrams,
  };
}
