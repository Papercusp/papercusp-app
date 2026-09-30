/**
 * The roster's pure logic — fleet grouping and ordering, activity-liveness and
 * thinking predicates, display-name resolution, machine grouping, and the
 * session-action availability rules.
 *
 * Every function here is PURE and host-free: no fetch, no React, no operator
 * import. Lifted verbatim from AgentsRunningPill.tsx (P-001 / D-005) with two
 * deliberate seams, each defaulted so the operator's behavior is byte-identical:
 *
 *   · `displayName` takes an optional `agentLabel` normalizer instead of a bound
 *     lexicon, so a host with no lexicon (the portal) still gets a correct name.
 *   · `thinkingStreamUrl` takes an optional `basePath`, so a cross-origin host
 *     (the portal) can point the same URLs at the operator it talks to. The
 *     default `''` reproduces the same-origin strings exactly.
 */
import { LIVE_MS, LIVE_TURN_MS, type FleetGroup, type Liveness, type MachineTab, type RosterAgent } from './types';

/** Whether an agent's terminal window can be focused. True when we have a stored
 *  X11 `windowId` (a direct target) OR an `advSessionId` — the host's focus
 *  endpoint resolves the window from the session row / its title fragment in that
 *  case, so the "Focus window" affordance is offered for a live session even
 *  before its windowId is resolved. A resolution miss surfaces as a graceful
 *  "focus failed", never a crash. pid alone is NOT enough (sibling terminals
 *  share one server pid). Pure — exported for tests. */
export function canFocusWindow<T extends Partial<Pick<RosterAgent, 'windowId' | 'advSessionId'>>>(a: T): boolean {
  return Boolean(a.windowId) || a.advSessionId != null;
}

/** The session id to fork/resume this agent's terminal into a NEW window —
 *  `<agent-cli> -r <id>` only accepts claude + omp session ids; codex's rollout
 *  resume is a different mechanism, so it is deliberately excluded here rather
 *  than passing an id that would silently fail. null ⇒ no Fork/Resume action
 *  shown (never a dead button). Pure — exported for tests. */
export function resumableSessionId(
  a: Partial<Pick<RosterAgent, 'agent' | 'sessionId' | 'ompThreadId'>>,
): string | null {
  if (a.agent === 'codex') return null;
  return a.sessionId ?? a.ompThreadId ?? null;
}

/** Whether an agent's session can be FORKED into a new session — `--fork-session`
 *  is claude-only; omp has no fork command. Gates the Fork button for BOTH active
 *  and inactive sessions: forking BRANCHES a fresh session from the transcript,
 *  safe whether or not the source is still running. Resume-in-place (no fork)
 *  remains available for any non-codex backend regardless. Pure. */
export function canForkSession(a: Partial<Pick<RosterAgent, 'agent'>>): boolean {
  return a.agent === 'claude';
}

/** Whether an agent has a viewable thinking stream — a spawned run's log, a
 *  claude session's transcript, a codex session's rollout (keyed by its session
 *  row id), or an omp session's thread jsonl. Pure — exported for tests.
 *
 *  `thinkingResolvable === false` VETOES the affordance: the server resolved the
 *  interactive claude session's transcript and found none (a parked/ended agent
 *  whose transcript is gone), so opening the pane would show an empty
 *  "waiting/stalled" state. Gating here turns that into an honest "unavailable"
 *  note instead of a misleading empty modal. The veto is safe — it only fires
 *  when the stream WOULD be empty; a live session's transcript always resolves,
 *  so a working pane is never hidden. */
export function hasThinking(
  // Every field below is read defensively (`&&` / `!= null` / `=== false`), so the
  // handles are genuinely OPTIONAL — a caller with only a `sessionId`, or only a
  // `runId`, is a valid input. A bare `Pick` made all of them REQUIRED, which is
  // why partial call-sites (real ones pass a full RosterAgent) had to be forced.
  a: Partial<Pick<RosterAgent, 'runId' | 'harnessSlug' | 'sessionId' | 'agent' | 'advSessionId' | 'ompThreadId' | 'thinkingResolvable'>>,
): boolean {
  if (a.thinkingResolvable === false) return false;
  return Boolean(
    (a.runId && a.harnessSlug)
    || a.sessionId
    || (a.agent === 'codex' && a.advSessionId != null)
    || a.ompThreadId,
  );
}

/** Canonical transcript-freshness read with one payload-skew fallback. */
export function isTranscriptFresh(
  a: Pick<RosterAgent, 'transcriptFresh' | 'thinking'>,
): boolean {
  return a.transcriptFresh ?? a.thinking ?? false;
}

/** The stream URL for an agent's thinking: the run-log stream when it has a run,
 *  else the interactive-session transcript endpoint keyed per backend (claude
 *  sessionId · codex session-row id · omp thread id); null when none. Pure.
 *
 *  `basePath` prefixes every URL so a CROSS-ORIGIN host (the portal, which is not
 *  served from the operator) can point these at the operator it talks to. It
 *  defaults to `''`, which reproduces the operator's own same-origin strings
 *  byte-for-byte — the extraction must not move the desktop's URLs.
 *
 *  The claude leg gets the agent's `ownerId` as a hint so the backend jumps
 *  straight to that session's isolation dir instead of sweeping all of them.
 *
 *  It also passes `ended=1` whenever the server already told us
 *  (`thinkingResolvable === false`) that no on-disk transcript exists for this
 *  session. Without it the backend cannot distinguish "a live agent that hasn't
 *  taken its first turn yet" (keep polling) from "an ended agent whose transcript
 *  was archived + deleted" (rematerialize from the archive) — and always took the
 *  former branch, so a parked/ended session's history silently never loaded even
 *  though the archive held it. `ended` is omitted (not `0`) when resolvable — the
 *  backend treats its absence as "don't know", same as before. */
export function thinkingStreamUrl(
  // Every field is read defensively (truthy / `!= null` / `=== false`), so all
  // handles are genuinely OPTIONAL — a caller with only a `sessionId`, or only a
  // `runId`, is valid (real call-sites pass a full RosterAgent). A bare `Pick`
  // made them all REQUIRED, forcing partial call-sites (matches hasThinking).
  a: Partial<
    Pick<
      RosterAgent,
      'ownerId' | 'runId' | 'harnessSlug' | 'sessionId' | 'agent' | 'advSessionId' | 'ompThreadId' | 'thinkingResolvable'
    >
  >,
  opts?: { basePath?: string },
): string | null {
  const base = opts?.basePath ?? '';
  if (a.runId && a.harnessSlug) {
    return `${base}/api/harness/${encodeURIComponent(a.harnessSlug)}/agents/${encodeURIComponent(a.runId)}/stream?phase=staging`;
  }
  /* The BACKEND legs come first, because `sessionId` is not a claude tell. A
     codex session row carries its rollout/thread uuid in `session_id` (237 of 257
     live codex rows did when this was measured), so a sessionId-first order sent
     every one of them to the claude leg — `sessionId=<codex uuid>`, which the
     claude resolver cannot resolve, for a guaranteed empty pane. */
  if (a.agent === 'codex' && a.advSessionId != null) {
    return `${base}/api/adv/session/thinking?codexSessionKey=${encodeURIComponent(String(a.advSessionId))}`;
  }
  if (a.ompThreadId) {
    // The session-row id names the per-session omp home the transcript actually
    // lives in; without it the route searches the shared ~/.omp home a
    // psu-launched omp agent never writes to.
    const key = a.advSessionId != null ? `&ompSessionKey=${encodeURIComponent(String(a.advSessionId))}` : '';
    return `${base}/api/adv/session/thinking?ompThreadId=${encodeURIComponent(a.ompThreadId)}${key}`;
  }
  if (a.sessionId) {
    const owner = a.ownerId ? `&owner=${encodeURIComponent(a.ownerId)}` : '';
    const ended = a.thinkingResolvable === false ? '&ended=1' : '';
    return `${base}/api/adv/session/thinking?sessionId=${encodeURIComponent(a.sessionId)}${owner}${ended}`;
  }
  return null;
}

/** Compact "time since" for the roster's last-active pill: 3s / 2m / 4h / 2d.
 *  Empty for a missing/invalid timestamp; a slightly-future ts (clock skew)
 *  clamps to 0s. Pure — exported for tests. */
export function fmtCompactAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Session-lifecycle states in which the shared server oracle has ruled the
 * process GONE. `RosterAgent.sessionState` is the authoritative verdict where a
 * host supplies it (the repo's liveness-semantics rule: heartbeat freshness is
 * process keepalive, never "taking turns"), so a row in one of these states is
 * not running whatever its `lastActiveAt` or `loopArmed` say.
 *
 * Deliberately NOT in the set: `parked` / `draining` (wakeable, possibly
 * mid-cadence — activity timing decides), and `recorded`, which is
 * authoritatively ALIVE per the session log — a console/autonomous agent that
 * is simply not coord-wakeable. Treating `recorded` as dead would grey out
 * every console agent. Unknown / absent values fall through to activity timing.
 */
const GONE_SESSION_STATES: ReadonlySet<string> = new Set(['ended', 'suspect']);

/** Whether the oracle's `sessionState` says this session is gone. Pure. */
export function isSessionGone(a: Pick<RosterAgent, 'sessionState'>): boolean {
  return typeof a.sessionState === 'string' && GONE_SESSION_STATES.has(a.sessionState);
}

/**
 * The liveness to DISPLAY for a running agent — derived from GENUINE activity
 * (`lastActiveAt`, a real turn / tool dispatch), never the 60s keepalive
 * heartbeat and never a merely-armed loop:
 *   · live  — took a turn within the last minute (LIVE_MS): actively working.
 *   · idle  — took a turn within LIVE_TURN_MS (10m): alive but between turns /
 *             mid-reasoning, or a loop waiting for its next wake.
 *   · stale — no genuine turn in LIVE_TURN_MS: NOT live — a wedged/killed session,
 *             or an armed loop that has stopped firing.
 *
 * `loopArmed` is deliberately NOT a liveness signal here. A HEALTHY loop keeps
 * `lastActiveAt` fresh on its own cadence (so it reads live/idle without help);
 * an armed-but-not-firing loop is exactly the warm-dead session this must report
 * as stale. An earlier "loop armed ⇒ live" short-circuit painted a KILLED
 * loop-armed session green — owner-reported: "it thought you were still live even
 * though you didn't have a turn in a few hours".
 *
 * A missing/blank/unparseable `lastActiveAt` (older/pending rows that never
 * stamped it) is `stale`, never a keepalive-derived "live" (the owner's standing
 * rule — the keepalive heartbeat is not evidence of taking turns).
 *
 * `sessionState`, where the host supplies it, is the shared oracle's
 * AUTHORITATIVE lifecycle verdict and is consulted FIRST (see `isSessionGone`):
 * a session the oracle has ruled gone renders stale however recent its last
 * turn — the just-died case, where the last real turn was seconds ago and the
 * keepalive is still arriving, which activity timing alone paints green for a
 * minute and amber for ten. Pure.
 */
export function activityLiveness(
  a: Pick<RosterAgent, 'lastActiveAt' | 'sessionState'>,
  nowMs: number,
): Liveness {
  if (isSessionGone(a)) return 'stale';
  const iso = a.lastActiveAt ?? null;
  if (!iso) return 'stale';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'stale';
  const age = nowMs - t;
  if (age < LIVE_MS) return 'live';
  if (age < LIVE_TURN_MS) return 'idle';
  return 'stale';
}

/** The tooltip for an agent's activity-liveness dot — the honest state plus,
 *  when a loop is armed, whether it is still firing (fresh) or has stalled
 *  (stale). Pure — exported for tests. */
export function activityLivenessTitle(
  a: Pick<RosterAgent, 'lastActiveAt' | 'loopArmed' | 'sessionState'>,
  nowMs: number,
): string {
  if (isSessionGone(a)) {
    const why = a.sessionState === 'ended' ? 'session ended' : 'process gone (suspect)';
    return `stale — ${why}${a.loopArmed ? ' (loop armed but the session is gone)' : ''}`;
  }
  const state = activityLiveness(a, nowMs);
  if (state === 'live') return `live — took a turn in the last minute${a.loopArmed ? ' · loop armed' : ''}`;
  if (state === 'idle') return `idle — no turn in the last minute${a.loopArmed ? ' · loop armed' : ''}`;
  return a.loopArmed
    ? 'stale — no turn in over 10m (loop armed but not firing)'
    : 'stale — no turn in over 10m';
}

/** Distinct machines represented in the roster — local machines by their label,
 *  a still-unlabeled local row folded under one "__local__" bucket, federated rows
 *  by their machineLabel. Used for the "across N machines" pill count. Pure. */
export function distinctMachineCount(
  agents: readonly Pick<RosterAgent, 'machineLabel' | 'isLocal'>[],
): number {
  const set = new Set<string>();
  for (const a of agents) {
    set.add(a.machineLabel ?? (a.isLocal === false ? '__remote__' : '__local__'));
  }
  return set.size;
}

/** The machine-grouping key for an agent (matches distinctMachineCount). Pure. */
export function machineKey(a: Pick<RosterAgent, 'machineLabel' | 'isLocal'>): string {
  return a.machineLabel ?? (a.isLocal === false ? '__remote__' : '__local__');
}

/**
 * Per-machine tabs for the roster: THIS machine first (labeled "Local"), then each
 * remote machine in the shared hive, alphabetical by label. `count` = agents on that
 * machine. Empty/one-machine setups produce ≤1 tab (the caller then hides the bar).
 * Pure — exported for tests.
 */
export function machineTabs(agents: readonly RosterAgent[]): MachineTab[] {
  const byKey = new Map<string, MachineTab>();
  for (const a of agents) {
    const key = machineKey(a);
    const isLocal = a.isLocal !== false;
    const label = isLocal ? 'Local' : (a.machineLabel ?? 'Remote');
    const t = byKey.get(key) ?? { key, label, isLocal, count: 0 };
    t.count += 1;
    byKey.set(key, t);
  }
  return [...byKey.values()].sort((x, y) =>
    x.isLocal !== y.isLocal ? (x.isLocal ? -1 : 1) : x.label.localeCompare(y.label),
  );
}

/** A short, recognizable owner id — `su-5577c5df-…` → `su-5577c`; a long id is
 *  truncated. Pure — exported for tests. */
export function shortOwner(id: string): string {
  const m = id.match(/^([a-z]+-[0-9a-f]{5,8})/i);
  if (m) return m[1];
  return id.length > 16 ? `${id.slice(0, 15)}…` : id;
}

/** The row's display NAME: the human owner-label, else a short owner id. NEVER the
 *  agent TYPE (claude/codex/omp) — that's the backend, not a name (it is shown as a
 *  chip in the detail instead).
 *
 *  `agentLabel` is the host's optional label normalizer (the operator binds its
 *  lexicon through it, so stored cast words render as the brand's vocabulary). A
 *  host without one — the portal — gets the raw stored label, which is already a
 *  human name. Pure — exported for tests. */
export function displayName(
  a: Pick<RosterAgent, 'label' | 'ownerId'>,
  agentLabel?: (raw: string) => string,
): string {
  const label = a.label?.trim();
  return label && label.length > 0
    ? (agentLabel ? agentLabel(label) : label)
    : shortOwner(a.ownerId);
}

/**
 * Whether a roster entry belongs on the BROADER active/wakeable roster — present
 * (not heartbeat-stale) OR loop-armed. A loop-armed agent keeps working on a
 * cadence even while parked between wakes, so broader fleet/ask surfaces retain
 * it even if its presence heartbeat has gone stale.
 *
 * The "agents running" pill deliberately does NOT use this broader predicate:
 * its wording promises agents running right now, so it filters on the server's
 * authoritative `sessionState === 'live'` verdict instead. Pure — exported for
 * the roster surfaces that intentionally include parked/wakeable agents.
 *
 * The oracle's verdict still bounds it from above: a session it has ruled gone
 * (`isSessionGone`) is not wakeable, so neither a still-fresh `liveness` nor an
 * armed-but-orphaned loop can keep it on the roster.
 */
export function isRunningAgent(
  a: Pick<RosterAgent, 'liveness' | 'loopArmed' | 'sessionState'>,
): boolean {
  if (isSessionGone(a)) return false;
  return a.liveness !== 'stale' || Boolean(a.loopArmed);
}

/**
 * Group agents by fleet, fleeted groups first (alphabetical by slug), the
 * "No fleet" group last. Within a group, preserve input order (the roster is
 * already newest-heartbeat first). Pure — exported for tests.
 */
export function groupByFleet(agents: readonly RosterAgent[]): FleetGroup[] {
  const byFleet = new Map<string, FleetGroup>();
  for (const a of agents) {
    const slug = a.fleetSlug && a.fleetSlug.trim() ? a.fleetSlug : null;
    const key = slug ?? ' no-fleet';
    let g = byFleet.get(key);
    if (!g) {
      g = { slug, color: slug ? a.fleetColor ?? null : null, agents: [] };
      byFleet.set(key, g);
    }
    g.agents.push(a);
  }
  return [...byFleet.values()].sort((x, y) => {
    if ((x.slug === null) !== (y.slug === null)) return x.slug === null ? 1 : -1; // No fleet last
    if (x.slug === null) return 0;
    return x.slug.localeCompare(y.slug!);
  });
}

/**
 * The roster's SEARCH/FILTER pass — the substring match a host runs over the
 * roster it already holds, before (or instead of) any server-side transcript
 * search. Matches the fields a human actually types: the display name, the owner
 * id, the declared intent, the work-item, the plan slug, the fleet, and the
 * backend. Case-insensitive; a blank query returns the input unchanged (same
 * identity, so a memoized caller does not re-render).
 *
 * Pure and host-free — a host that ALSO has a server search leg unions this
 * instant result with it, exactly as the operator's pill does.
 */
export function filterRoster(
  agents: readonly RosterAgent[],
  query: string,
  agentLabel?: (raw: string) => string,
): readonly RosterAgent[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) => {
    const haystack = [
      displayName(a, agentLabel),
      a.ownerId,
      a.intent,
      a.feature ?? '',
      a.currentPlanSlug ?? '',
      a.fleetSlug ?? '',
      a.agent ?? '',
      a.role ?? '',
      a.machineLabel ?? '',
    ];
    return haystack.some((h) => h.toLowerCase().includes(q));
  });
}
