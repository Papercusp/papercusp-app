/**
 * code-run-batch-nudge.ts — the INLINE "you're firing tool round-trips one at a time; bundle them
 * into one code:run" nudge (code-run-token-frugality, owner directive 2026-06-23; fan-out + felt-cost
 * upgrade, owner directive 2026-06-26).
 *
 * The STRUCTURAL complement to CODE_RUN_NUDGE's prompt prose. The prose tells agents to batch tool
 * calls; this catches them NOT doing it and nudges at the DECISION POINT — the live tool result,
 * read in-context exactly when the wasteful pattern is happening. That beats base-prompt prose for
 * adoption (the prose already existed while code:run adoption was ~0).
 *
 * THREE TRIGGERS (a 2026-06-26 adoption audit showed the original same-tool-only trigger could even
 * FIRE on only ~30% of multi-call SU spawns — it was BLIND to the dominant pattern; the pipeline
 * kind + tools:invoke unwrap + arg prefill landed 2026-07-12, plan code-run-batch-adoption):
 *  - SAME-TOOL: the same tool ≥ BATCH_NUDGE_THRESHOLD× inside the recent window (a `get` per id, a
 *    check per file) → the list-then-fold skeleton (`Promise.all` over `inputs`, WI-2142449),
 *    `inputs` prefilled with the args just seen. Was a sequential `for`-loop until WI-2142449: every
 *    input here is a call ALREADY made with its own already-known literal args (none derived from a
 *    prior call's result in this burst), so the calls are independent by construction — the fixed
 *    skeleton's own advice ("if these are independent…") no longer contradicts the shape it hands
 *    back. A sequential fold on this same premise cost MORE than the one-at-a-time pattern it
 *    corrected the moment any single call took a meaningful share of the script budget (measured:
 *    an 8-call `dev:pipeline_position` burst — ~3-6s/call — blew the 30s budget as a sum, comfortably
 *    inside it as a max).
 *  - PIPELINE: ≥ FANOUT_DISTINCT_THRESHOLD distinct tools AND the same distinctive arg value (an
 *    id/slug) threaded through ≥2 DIFFERENT tools — a chained burst (release → claim → comment on
 *    one object). The old fan-out text mislabeled this "independent", handing the agent a false
 *    exemption ("mine are dependent, so the hint doesn't apply"); the pipeline skeleton shows the
 *    chain sequenced INSIDE one script instead (2026-07-11 release-fleet audit, 8 round-trips).
 *  - FAN-OUT: ≥ FANOUT_DISTINCT_THRESHOLD DISTINCT tools inside the recent window (the
 *    "many-different-reads-once" pattern the old nudge missed) → a Promise.all skeleton over the exact
 *    tools just seen.
 *
 * TOOLS:INVOKE UNWRAP (P-001): a call routed through the tools:invoke wrapper counts as its INNER
 * tool — the same audit showed 3× work_items:release via tools:invoke read as "one distinct tool",
 * silencing the same-tool trigger exactly when it was needed most.
 *
 * WINDOWED, not lifetime: counts are over a sliding NUDGE_WINDOW_MS window of recent calls, so only a
 * BURSTY flurry (the actually-batchable shape) trips it — three calls spread across ten minutes do
 * not. BACKOFF, not one-shot: ignoring a nudge once no longer silences it forever; it re-fires on an
 * exponential call-count cooldown (rarer each time) so a persistent waster keeps getting reminded
 * without spam. FELT COST: the hint leads with the running round-trip count (the token cost an agent
 * never otherwise sees) — making the invisible cost visible in-loop is the lever prose can't pull.
 *
 * TURNS, not raw calls (P-012, agent-operability-clarity-full-audit-2026-07-13): every trigger and
 * every "N round-trips" figure in the hint text is keyed on distinct INFERENCE TURNS (see
 * `clusterTurns`/`TURN_GAP_MS`), not on raw call counts. Several tool calls dispatched from ONE
 * turn (parallel tool_use — exactly what the harness tells agents to do for independent calls) cost
 * a single round-trip; counting them as N would nudge an agent AWAY from that best practice. Only a
 * burst that actually SPANS multiple turns has a round-trip to save.
 *
 * Cheap + safe by construction:
 *  - In-process only (no PG, no network): a per-session ring of recent {tool, at} + a small backoff
 *    counter. The hot path is a push + a window trim on the common call.
 *  - SCOPED to callers who actually HOLD code:run (every built-in role as of 2026-06-25, or a
 *    superuser). A role that can't run code:run can't act on the nudge, so it never sees it.
 *  - EXCLUDES the batch tools themselves (code:* / recipes:*) — nudging "use code:run" on a code:run
 *    call is absurd, and they must not count toward the fan-out distinct-tool tally either.
 *  - Bounded memory: a per-session recent-ring cap + an insertion-order session cap evict the oldest.
 *
 * The boundary the nudge text states matches CODE_RUN_NUDGE exactly: bundle INDEPENDENT or
 * mechanically-chained calls (a script threads one result into the next fine); keep separate only a
 * call whose result you must READ AND REASON ABOUT before the next (judgment mid-flow), since a
 * script cannot pause for the model to think.
 *
 * Flag-gated at the call site, PER KIND, so each trigger has its own runtime kill-switch / A/B knob:
 * the same-tool path under FLAGS.CODE_RUN_BATCH_NUDGE, the newer fan-out path under
 * FLAGS.CODE_RUN_FANOUT_NUDGE; the pipeline kind rides CODE_RUN_FANOUT_NUDGE (same multi-tool
 * trigger family — telemetry records the kind verbatim, so the two stay distinguishable). The gate
 * is only consulted when a hint actually fires (rare), so the per-call cost stays the ring push.
 */
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { DEFAULT_SCRIPT_TIMEOUT_MS } from '@papercusp/tooldef';
import { FOREGROUND_TIMEOUT_CEILING_MS } from './agent-tools/capability/foreground-transport-cap';
import { ROLE_ENVELOPES, matchesAny } from './capability-envelope/policy';
// Reused verbatim (EI-10894): "find the row arrays in a tool payload" is the SAME job the
// empty-mapping detector already does — including the one-hop descent into nested row arrays
// (`{ results: [...] }`, `{ items: [...] }`), which is where most list verbs actually put their
// rows. Re-implementing it here would have forked that traversal and let the two drift.
import { collectCandidateArrays } from './empty-mapping-hint';

/** Same tool this many times inside the window → the same-tool nudge is a candidate. Lowered 3→2
 *  (code-run-adoption directive 2026-06-29): the 2nd identical round-trip already IS the loop — by
 *  the 3rd the cheap calls are spent. Catch it at the earliest point the pattern is unambiguous.
 *  Since P-012 (agent-operability-clarity-full-audit-2026-07-13) this counts distinct INFERENCE
 *  TURNS the tool was called from, not raw calls — see TURN_GAP_MS below. */
export const BATCH_NUDGE_THRESHOLD = 2;

/** This many DISTINCT (non-excluded) tools inside the window → the fan-out nudge is a candidate.
 *  Lowered 4→3 (2026-06-29): three different reads in one burst is already a Promise.all-able fan-out.
 *  Since P-012 this is gated jointly with `distinctTurnsInWindow` (see maybeBatchNudge) — a burst
 *  hitting this many distinct TOOLS but landing inside ONE inference turn (already-parallel dispatch)
 *  must not fire; only a burst that actually SPANS this many separate turns wastes round-trips. */
export const FANOUT_DISTINCT_THRESHOLD = 3;

/**
 * P-012 (agent-operability-clarity-full-audit-2026-07-13): the batching guidance must measure
 * MODEL INFERENCE TURNS — the actual cost driver — not raw downstream tool/RPC count. The harness
 * lets an agent fire several INDEPENDENT tool calls from a single inference turn (parallel
 * tool_use blocks in one assistant message); those calls cost exactly ONE round-trip, same as a
 * single call, because no extra "re-read your whole context" inference happens between them. Only
 * calls that land in SEPARATE turns each pay that re-read cost. Before P-012 this module counted
 * raw calls (`sameToolCount`, `seen.size`) as if every call were its own round-trip, so a caller
 * who correctly followed the "make independent calls in the same response block" guidance and
 * fired 3 parallel reads got told "that's 3 round-trips, fold them into one code:run" — false:
 * they had ALREADY collapsed it to one, and were nudged AWAY from best practice.
 *
 * There is no client-supplied turn id on this path (the MCP transport sees each tool call as its
 * own request), so turns are inferred from timing: two calls recorded this close together (or
 * closer) are treated as dispatched from the SAME turn. The gap needed to separate two GENUINE
 * turns is a live LLM inference round-trip (network + generation) — at minimum several hundred ms,
 * typically 1-3s+ for the models this fleet runs.
 *
 * ⚠ This constant is NOT sufficient on its own, and the reason is measured, not assumed. An earlier
 * revision of this comment claimed parallel dispatch "lands within tens of ms of each other
 * server-side, rarely beyond ~100-200ms even under load"; fleet data refutes that (see the in-flight
 * guard on clusterTurns below — 1,169 same-turn gaps in 4h exceeded this threshold, p50 647ms),
 * because `at` is dispatch as OBSERVED BY THE SERVER and is therefore spread by request queueing.
 * Do not retune this number in response to phantom-turn reports: a sweep over that population showed
 * 400ms is already near-optimal as a threshold, and clusterTurns now separates the causal case
 * (overlapping execution) from the timing case that this constant still handles.
 */
export const TURN_GAP_MS = 400;

/**
 * Assign a 0-based TURN-CLUSTER id to each event, in chronological order: a new turn starts
 * whenever the gap since the previous event exceeds TURN_GAP_MS. `events` need not be pre-sorted
 * (the ring is insertion-order, which is usually but not guaranteedly chronological) — this sorts a
 * local index array by `at`. Pure; shared by the same-tool and fan-out/pipeline triggers so "how
 * many separate round-trips did this burst actually take" is computed exactly once.
 *
 * EI-23762928303536326 — the IN-FLIGHT guard. The gap rule alone is a timing HEURISTIC, and its
 * premise (that one turn's dispatches land within ~100-200ms of each other) fails under fleet load:
 * `at` is server-observed dispatch, so a parallel block's requests are spread by SERVER-side queueing
 * before any handler records them. Measured fleet-wide over 4h (harness_shared.tool_invocations,
 * consecutive calls per coord_owner_id): 1,169 gaps exceeded TURN_GAP_MS *while the previous call was
 * still executing* — p50 gap 647ms against a p50 previous-call duration of 1,473ms. Every one was
 * split into phantom turns, which is exactly backwards: it nags hardest at agents who ARE batching.
 *
 * Raising the constant cannot fix it (the spread is load-dependent and unbounded, and a wider gap
 * merges genuinely sequential turns — a sweep over this same population put total misclassification
 * at 448 for 400ms, 720 for 1500ms and 1005 for 3000ms, so 400 is already near-optimal *as a
 * threshold*). So this adds a CAUSAL test rather than a bigger number: a call dispatched before a
 * previous call in the same cluster had returned cannot begin a new inference turn, because the
 * model had not yet received that result to reason about. Overlap is proof of same-turn dispatch,
 * whatever the clock says.
 *
 * `durationMs` is optional and absent timing degrades EXACTLY to the pre-existing gap rule (with no
 * durations, every end collapses to its own `at`, so the in-flight test can never fire).
 */
export function clusterTurns(events: readonly { at: number; durationMs?: number }[]): number[] {
  const order = events.map((_, i) => i).sort((a, b) => events[a].at - events[b].at);
  const turnOf = new Array<number>(events.length);
  let turn = -1;
  let prevAt: number | undefined;
  /** Latest known END of any call in the CURRENT cluster — the in-flight horizon. */
  let clusterEnd: number | undefined;
  for (const i of order) {
    const at = events[i].at;
    const d = events[i].durationMs;
    const end = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? at + d : at;
    // Still in flight ⇒ the model had not received the earlier result yet ⇒ same turn, regardless
    // of how far apart the two dispatches were observed.
    const stillInFlight = clusterEnd !== undefined && at < clusterEnd;
    const startsNewTurn = prevAt === undefined || (!stillInFlight && at - prevAt > TURN_GAP_MS);
    if (startsNewTurn) turn++;
    turnOf[i] = turn;
    clusterEnd = startsNewTurn || clusterEnd === undefined ? end : Math.max(clusterEnd, end);
    prevAt = at;
  }
  return turnOf;
}

/** Sliding window over which recent calls are counted. Only a bursty flurry (the actually-batchable
 *  shape) trips a trigger; calls spread wider than this are treated as separate, deliberate steps. */
export const NUDGE_WINDOW_MS = 90_000;

/** Per-session cap on the recent-call ring (backstop against a long-lived session growing it). */
const MAX_RECENT_PER_SESSION = 64;

/** How many distinct tools the fan-out skeleton enumerates before it elides the rest. */
const MAX_SKELETON_TOOLS = 6;

/** Cap on the per-call args literal kept for skeleton prefill (P-003). Absolute worst-case memory:
 *  MAX_TRACKED_SESSIONS × MAX_RECENT_PER_SESSION × ~(cap + name) ≈ 4000 × 64 × ~220B ≈ 56MB
 *  ceiling; in practice rings hold a handful of calls (the 90s window trims on every active call). */
const ARGS_RENDER_MAX = 160;

/** How many distinctive scalar arg values per call feed the chained-burst detector (P-002). */
const CHAIN_VALUES_PER_CALL = 8;

/** Arg keys whose values are ambient context (harness, workspace, free-text prose, …), not object
 *  identity — a cross-tool match on these must NOT read as "same object threaded through verbs". */
const CHAIN_SKIP_KEYS: ReadonlySet<string> = new Set<string>([
  'harness',
  'harnessslug',
  'workspace',
  'workspaceid',
  'scope',
  'format',
  'status',
  'state',
  'kind',
  'reason',
  'summary',
  'body',
  'comment',
  'checkpoint',
  'intent',
  'query',
]);

/** Insertion-order cap on tracked sessions (backstop against unbounded growth). */
const MAX_TRACKED_SESSIONS = 4000;

/**
 * Keep advisory state isolated when one stable coordination owner is carried by more than one
 * MCP transport connection. The stable owner remains the first component so telemetry can still
 * be joined back to the caller, while the transport component prevents one connection's recorded
 * arguments (and one-shot guards) from appearing in another connection. A reconnect gets a fresh
 * advisory window by design; coordination/replay state retains continuity elsewhere.
 */
export function advisorySessionKey(stableOwnerKey: string, transportSessionId?: string | null): string {
  const stable = stableOwnerKey.trim();
  const transport = typeof transportSessionId === 'string' ? transportSessionId.trim() : '';
  if (!stable || !transport || transport === stable) return stable;
  return `${stable}::mcp-transport::${transport}`;
}

/** Roles that hold code:run. As of the owner directive 2026-06-25, code:run is open to EVERY
 *  built-in role (run.ts `agentRoles: [...AGENT_ROLES]`), so the nudge audience is the full role
 *  universe — keep this in lockstep with code:run's gate. A superuser caller also qualifies
 *  (handled at the call site via isSuperuser). */
export const CODE_RUN_CAPABLE_ROLES: ReadonlySet<string> = new Set<string>([...AGENT_ROLES]);

/**
 * Can this caller ACT on a "use code:run" nudge? (code-run-self-state-adoption-2026-07-03 P-004.)
 * The old role-membership check alone was dishonest: overwatch/sentinel are envelope-DENIED
 * capability:bash (code:run's gate), so they were nudged — escalating banners included — toward a
 * tool every attempt at which would be refused. Role must be capable AND the role's envelope must
 * not deny the bash capability code:run requires. Superuser is handled by the caller.
 */
export function canRoleActOnCodeRun(role: string): boolean {
  if (!CODE_RUN_CAPABLE_ROLES.has(role)) return false;
  const deny = ROLE_ENVELOPES[role]?.denyCapabilities;
  return !deny || !matchesAny('capability:bash', deny);
}

/** THE PREFERRED DOORS — normalized names whose use IS the adoption we are measuring: batching a
 *  multi-call flow into one routed execution instead of hand-looping. This is the SINGLE SOURCE for
 *  that set. It is exported because `code-run-adoption.ts` and `code-run-nudge-telemetry.ts` both
 *  measure the same doors, and this module is already their shared dependency (both import from
 *  here; it imports from neither), so there is exactly one place to add the next door.
 *
 *  ⚠ It previously was NOT one place. The same set was hand-copied across 9 sites in 3 files — 6
 *  copies of this set and 3 of {@link EXCLUDED_TOOL_NORMS} — and `code-run-adoption.ts` even said so
 *  out loud: "kept in lockstep by the agent-insight doc + the metric test". They had already drifted:
 *  `orchestrate:run` shipped as a first-class door and was absent from every one of them, so
 *  preferred-door usage was silently missing from adoption, from nudge conversion, and from the
 *  rollout telemetry gates. Lockstep-by-documentation is not a mechanism (P-020 / WI-40720).
 *
 *  Normalization strips `:`/`_`/`-` and lowercases, so the verb form (`code:run`) and the MCP form
 *  (`code_run`) both land on the same entry. Keep entries in normalized form. */
export const PREFERRED_DOOR_NORMS: ReadonlySet<string> = new Set<string>([
  'coderun',
  'recipesrun',
  'orchestraterun',
]);

/** Normalized names of the batch/reuse tools themselves — never nudge these (you don't tell a
 *  `code:run` call to "use code:run"), and never count them toward the fan-out tally.
 *
 *  DERIVED from {@link PREFERRED_DOOR_NORMS} plus the non-executing recipe surface, so adding a new
 *  door in one place automatically stops the nudge from firing at it. That derivation is the point:
 *  the two sets drifting apart is precisely how `orchestrate:run` ended up nudgeable. */
export const EXCLUDED_TOOL_NORMS: ReadonlySet<string> = new Set<string>([
  ...PREFERRED_DOOR_NORMS,
  'codetools',
  'recipessearch',
  'recipeslist',
  'recipesget',
  'recipesmerge',
  'recipessweep',
  'recipescandidates',
]);

/** Render a norm set as a SQL literal list for an `IN (...)` predicate — e.g. `'coderun','recipesrun'`.
 *  Lets the SQL predicates in the sibling metric modules interpolate the SAME constant the TypeScript
 *  sets use, instead of restating it. Entries are compile-time literals from the sets above (never
 *  caller input), and each is single-quote-escaped, so this cannot carry injection. Sorted so the
 *  emitted SQL is stable and diffable. */
export function sqlNormList(norms: ReadonlySet<string>): string {
  return [...norms]
    .sort()
    .map((n) => `'${n.replace(/'/g, "''")}'`)
    .join(',');
}

/** Is this RAW tool name one of the preferred doors? Takes the un-normalized name (`code:run`,
 *  `orchestrate_run`, …) and normalizes before testing, so callers never hand-compare against a
 *  string literal. Use this anywhere a code path currently asks `toolName === 'code:run'`: that
 *  literal comparison is the runtime twin of the nine duplicated set copies, and it is why the
 *  MCP post-door backfill enriched code:run alone while recipes:run and orchestrate:run spilled
 *  with no telemetry at all (WI-40720 gap 3). */
export function isPreferredDoor(toolName: string): boolean {
  return PREFERRED_DOOR_NORMS.has(normalize(toolName));
}

const EXCLUDED_NORMALIZED: ReadonlySet<string> = EXCLUDED_TOOL_NORMS;

/** AMBIENT tools — fired by client hooks / status lines / wake plumbing on their own cadence, not
 *  authored by the agent's reasoning, so they are NOT a batchable flow: counting them made the
 *  nudge spray banners at every session (live fires 2026-07-12 were dominated by activity:report /
 *  coord:glance / coord:inbox "bursts" that were pure hook traffic, teaching agents to ignore the
 *  hint). Same denominator discipline as the adoption metric's poller exclusion
 *  (code-run-adoption.ts): a hook firing the same read twice is not an agent hand-loop. Excluded
 *  from recording entirely — they neither trigger a nudge nor count toward any tally. */
const AMBIENT_NORMALIZED: ReadonlySet<string> = new Set<string>([
  'activityreport',
  'activityrecent',
  'coordglance',
  'coordinbox',
]);

/** LOCK-LIFECYCLE tools — an acquire/release (and heartbeat keepalive) is NOT a batchable flow: the
 *  agent's real work happens BETWEEN acquire and release via native (non-MCP) edits, so an
 *  acquire→edit→release→acquire→edit→release cycle reads as a "burst" of repeated acquire/release
 *  round-trips that is serialized by that intervening work and can never be folded into one code:run
 *  loop. (Live fires 2026-07-12, EI-10168: the residual nudge fires after the ambient exclusion were
 *  exactly these lock cycles.) They are also already batch-capable within a SINGLE call —
 *  acquire takes `paths[]`, release takes `ids[]`/`all_mine`, heartbeat takes `lock_ids[]` — so a
 *  code:run loop is never the right advice for them anyway. Excluded from recording entirely, exactly
 *  like the ambient set: they neither trigger a nudge nor count toward any same-tool / fan-out tally. */
const LOCK_LIFECYCLE_NORMALIZED: ReadonlySet<string> = new Set<string>([
  'locksacquire',
  'locksrelease',
  'locksacquiregranular',
  'locksreleasegranular',
  'locksacquireresource',
  'locksreleaseresource',
  'locksheartbeat',
  'locksheartbeatresource',
]);

/** SESSION-LIFECYCLE tools — their calls change the session itself rather than advancing a
 * batchable tool flow. Replaying one from a ready-to-paste skeleton can end/respawn the session
 * again (most dangerously `session:request-compaction`), so exclude every session lifecycle call
 * before it enters the recent-call ring. */
const SESSION_LIFECYCLE_NORMALIZED: ReadonlySet<string> = new Set<string>([
  'sessioncarrydrill',
  'sessionend',
  'sessionrequestcompaction',
]);

/** One recorded call in the sliding window. */
interface RecentCall {
  tool: string;
  at: number;
  /** Bounded, template-literal-safe literal of the call's args (P-003) — pasted into skeletons. */
  argsRender?: string;
  /** Distinctive scalar arg values (ids/slugs) — the chained-burst signal (P-002). */
  argValues?: string[];
  /** Measured wall time of this call (EI-21254965187146713). What makes the fold advice CHECKABLE:
   *  without it the hint can only assert that folding is cheaper, and for slow children it is not. */
  durationMs?: number;
}

interface SessionState {
  /** Chronological ring of recent calls, trimmed to NUDGE_WINDOW_MS and capped. */
  recent: RecentCall[];
  /** How many nudges have already fired this session (drives the exponential cooldown). */
  nudgeCount: number;
  /** Calls recorded since the last nudge fired (the cooldown is measured in calls). */
  callsSinceNudge: number;
  /** Whether any nudge has fired this session (the first one has no cooldown). */
  everNudged: boolean;
  /** ms timestamp of the last SUCCESSFUL coord:orient this session (orient-dedup, P-009). */
  lastOrientAt?: number;
  /** subsumed tools already orient-dedup-nudged this session (one-shot guard, P-009). */
  orientDedupNudged: Set<string>;
  /** ms timestamp of the last code:run / recipes:run this session — the caller is ALREADY
   *  batching, so the PREDICTIVE hint stays quiet for a while (EI-10894). */
  lastCodeRunAt?: number;
  /** list-shaped tools already preempt-nudged this session (one-shot per tool, EI-10894). */
  preemptNudged: Set<string>;
  /** how many predictive hints have fired this session (hard per-session cap, EI-10894). */
  preemptCount: number;
  /** ms timestamp of the last pipeline DOOR read this session (state-plane nudge, P-008). */
  lastDoorAt?: number;
  /** the door tool that produced `lastDoorAt` — named back to the agent in the advisory. */
  lastDoorTool?: string;
  /** ms timestamp of the last state:read this session (P-008). A re-read AFTER `lastDoorAt`
   *  is what the act/quote rule is looking for; ordering is the whole point. */
  lastPlaneReadAt?: number;
  /** turn-START timestamps of door reads, for poll-loop detection (P-008). Kept separate from
   *  `recent`, which is trimmed to NUDGE_WINDOW_MS (90s) — far shorter than a poll loop. */
  doorTurnStarts: number[];
  /** ms timestamp of the last state:subscribe this session (P-008) — an agent that already
   *  subscribed inside the poll window made the RIGHT call and must not be nudged for it. */
  lastPlaneSubscribeAt?: number;
  /** state-plane rules already fired this session (one-shot per rule, P-008). */
  statePlaneNudged: Set<string>;
}

const sessions = new Map<string, SessionState>();

/** Get (or lazily create, with insertion-order eviction) the per-session tracking state. The ONE
 *  shared map both nudges read/write, so orient timing and the recent-call ring live together. */
function getOrCreateSession(sessionKey: string): SessionState {
  let st = sessions.get(sessionKey);
  if (!st) {
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    st = {
      recent: [],
      nudgeCount: 0,
      callsSinceNudge: 0,
      everNudged: false,
      orientDedupNudged: new Set(),
      preemptNudged: new Set(),
      preemptCount: 0,
      doorTurnStarts: [],
      statePlaneNudged: new Set(),
    };
    sessions.set(sessionKey, st);
  }
  return st;
}

function normalize(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `wake-queue` / `set_status` → `wakeQueue` / `setStatus` (the code:run facade's JS-identifier keys). */
function camelSegment(segment: string): string {
  return segment.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

function camelVerb(verb: string): string {
  return camelSegment(verb);
}

/** Render a `tools.…` facade call for `toolName(<argExpr>)`. Prefers the typed `tools.ns.verb(arg)`
 *  form; falls back to the always-valid `tools.call('ns:verb', arg)` escape hatch when the name does
 *  not cleanly split into JS identifiers. `argExpr` is the literal argument source — e.g. the loop
 *  var `a`, or a fill-in placeholder comment for the fan-out skeleton. */
function facadeCall(toolName: string, argExpr: string): string {
  const ci = toolName.indexOf(':');
  if (ci > 0) {
    const ns = toolName.slice(0, ci);
    const verb = camelVerb(toolName.slice(ci + 1));
    const ident = /^[A-Za-z_$][\w$]*$/;
    const camelNs = camelSegment(ns);
    if (ident.test(camelNs) && ident.test(verb)) return `tools.${camelNs}.${verb}(${argExpr})`;
  }
  return `tools.call(${JSON.stringify(toolName)}, ${argExpr})`;
}

/** Bounded, template-literal-safe literal of a call's args for skeleton prefill (P-003). Returns
 *  undefined for empty/unrenderable args so skeletons fall back to a fill-in placeholder. */
function renderArgs(args: unknown): string | undefined {
  if (args == null) return undefined;
  let json: string;
  try {
    json = JSON.stringify(args) ?? '';
  } catch {
    return undefined;
  }
  if (json === '' || json === '{}' || json === 'null') return undefined;
  // Keep the skeleton pasteable into a code:run template literal: escape backticks + ${.
  json = json.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  if (json.length > ARGS_RENDER_MAX) {
    json = `${json.slice(0, ARGS_RENDER_MAX)} /* …truncated — fill in the rest */`;
  }
  return json;
}

/** Distinctive scalar values (ids/slugs — length 4..80, ambient-context keys skipped) from an args
 *  object, depth ≤ 2, bounded — the P-002 chained-burst signal. */
function chainValues(v: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= CHAIN_VALUES_PER_CALL || v == null) return out;
  if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v);
    if (s.length >= 4 && s.length <= 80) out.push(s);
    return out;
  }
  if (depth >= 2 || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    for (const x of v) {
      chainValues(x, depth + 1, out);
      if (out.length >= CHAIN_VALUES_PER_CALL) break;
    }
    return out;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (CHAIN_SKIP_KEYS.has(k.toLowerCase())) continue;
    chainValues(x, depth + 1, out);
    if (out.length >= CHAIN_VALUES_PER_CALL) break;
  }
  return out;
}

/** True when the same distinctive arg value appears in ≥2 DIFFERENT tools' calls in the window —
 *  one object threaded through several verbs (release → claim → comment) = a chained pipeline. */
function isChainedBurst(recent: RecentCall[]): boolean {
  const firstToolByValue = new Map<string, string>();
  for (const c of recent) {
    if (!c.argValues) continue;
    for (const v of c.argValues) {
      const first = firstToolByValue.get(v);
      if (first === undefined) firstToolByValue.set(v, c.tool);
      else if (first !== c.tool) return true;
    }
  }
  return false;
}

const TOOLS_INVOKE_NORMALIZED = 'toolsinvoke';

/** P-001: a call routed through the tools:invoke wrapper is, for batching purposes, a call to its
 *  INNER tool — 3× work_items:release via tools:invoke is a same-tool loop, not "one distinct
 *  tool" (the 2026-07-11 release-fleet burst hid exactly this way). Malformed wrapper args fall
 *  back to the wrapper name. */
function effectiveCall(toolName: string, args: unknown): { tool: string; args: unknown } {
  if (
    normalize(toolName) === TOOLS_INVOKE_NORMALIZED &&
    args !== null &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const inner = (args as { name?: unknown }).name;
    if (typeof inner === 'string' && inner.trim().length > 0) {
      return { tool: inner.trim(), args: (args as { args?: unknown }).args };
    }
  }
  return { tool: toolName, args };
}

/** The same-tool list-then-fold skeleton: `Promise.all` the ONE repeated call over `inputs` —
 *  prefilled with the args of the calls just made (P-003), so acting on it is extending a list, not
 *  authoring.
 *
 *  WI-2142449: this was a sequential `for`-loop until every input here was recognized as
 *  independent BY CONSTRUCTION — each is a call already made with its own already-known literal
 *  args, never one derived from a sibling's result in this burst (a genuinely cursor-chained
 *  sequence could not be expressed as this fixed `inputs` list either way). A serial fold on that
 *  premise only ever cost more: for `dev:pipeline_position` (~3-6s/call) an 8-call burst summed
 *  past the 30s script budget while its max sat comfortably inside it.
 *
 *  Per-branch `.catch` (EI-21712103510622160's pattern, same as {@link fanoutSkeleton}) so one bad
 *  input cannot discard results already fetched for the others. */
function sameToolSkeleton(toolName: string, recent: RecentCall[], timeoutSec?: number): string {
  const renders = recent
    .filter((c) => c.tool === toolName && c.argsRender !== undefined)
    .map((c) => c.argsRender as string)
    .slice(-MAX_SKELETON_TOOLS);
  const inputs =
    renders.length > 0
      ? `[\n${renders.map((r) => `    ${r},`).join('\n')}\n    /* …the NEXT ${toolName} args go here — extend this list, not another solo call */\n  ]`
      : `[/* the args for each ${toolName} call */]`;
  return codeRunCall(
    `  const inputs = ${inputs};\n` +
      `  const out = await Promise.all(\n` +
      `    inputs.map((a) => ${facadeCall(toolName, 'a')}.catch((e) => ({ error: String(e) }))),\n` +
      '  );\n' +
      '  return out;\n',
    timeoutSec,
  );
}

/** The fan-out skeleton: a Promise.all over the EXACT distinct tools just seen, each prefilled with
 *  its last call's args (P-003) — acting on it is a paste, not authoring from scratch.
 *
 *  EI-21712103510622160 (independently corroborated by EI-21546546359149278): each branch is
 *  wrapped so ONE bad call cannot discard the others. A bare `Promise.all` is fail-FAST, and this
 *  skeleton is emitted for exactly the case where that is wrong — INDEPENDENT reads. The measured
 *  filing: one branch omitted a required arg, the server returned a typed `invalid_input`, the
 *  rejection propagated out of `Promise.all`, and every sibling read that had already SUCCEEDED
 *  was discarded with it — the script never reached its `return`, and only the script's return
 *  re-enters context. The agent then re-ran the whole batch to recover reads it had already paid
 *  for. Independence is the argument FOR isolating branch failures, not against it.
 *
 *  Isolated per-branch rather than by switching to `Promise.allSettled`, deliberately: allSettled
 *  would wrap every bind in a `{ status, value }` envelope the caller must then unwrap, changing
 *  the destructuring shape of a skeleton whose whole value is that it is paste-ready. This keeps
 *  `const [r0, r1] = await Promise.all([...])` intact — each bind is either the result or
 *  `{ error }`. Nothing is hidden: a real child failure is still recorded as a `childFailure` on
 *  the run envelope, so the typed rejection remains visible where triage reads it. */
function fanoutSkeleton(distinctTools: string[], recent: RecentCall[], timeoutSec?: number): string {
  const lastRender = new Map<string, string>();
  for (const c of recent) {
    if (c.argsRender !== undefined) lastRender.set(c.tool, c.argsRender);
  }
  const shown = distinctTools.slice(0, MAX_SKELETON_TOOLS);
  const binds = shown.map((_t, i) => `r${i}`).join(', ');
  const lines = shown
    .map((t) => `    ${facadeCall(t, lastRender.get(t) ?? '/* args */')}.catch((e) => ({ error: String(e) })),`)
    .join('\n');
  const elided = distinctTools.length > shown.length ? `    /* …and ${distinctTools.length - shown.length} more */\n` : '';
  return codeRunCall(
    `  const [${binds}] = await Promise.all([\n` + lines + '\n' + elided + '  ]);\n' + `  return { ${binds} };\n`,
    timeoutSec,
  );
}

/** The pipeline skeleton (P-002): the burst's calls IN ORDER inside one script. A script threads
 *  one result into the next (and can branch on it), so a dependent-but-mechanical chain is still
 *  ONE round-trip — only a genuine read-and-REASON gate earns a separate call. */
function pipelineSkeleton(recent: RecentCall[], timeoutSec?: number): string {
  const shown = recent.slice(-MAX_SKELETON_TOOLS);
  const binds = shown.map((_c, i) => `r${i}`);
  const lines = shown
    .map((c, i) => `  const ${binds[i]} = await ${facadeCall(c.tool, c.argsRender ?? '/* args */')};`)
    .join('\n');
  return codeRunCall(lines + '\n' + `  return { ${binds.join(', ')} };\n`, timeoutSec);
}

/**
 * Fixed allowance for what the fold costs BEYOND the child calls themselves — worker boot, script
 * parse, dispatch binding, result serialization. Deliberately a flat number rather than a
 * percentage: the overhead does not scale with how slow the children are.
 */
const FOLD_OVERHEAD_MS = 2_000;

/** Verdict on whether the fold this hint is about to recommend can actually finish.
 *  - `fits`     — inside the default script budget; emit the skeleton unchanged.
 *  - `raise`    — needs an explicit `timeoutSec`, which the skeleton then carries.
 *  - `overruns` — cannot finish even at the foreground ceiling; say nothing at all.
 *  - `unknown`  — no call in the burst was timed; behave exactly as before the gate existed. */
type FoldBudgetVerdict = 'fits' | 'raise' | 'overruns' | 'unknown';

interface FoldBudget {
  verdict: FoldBudgetVerdict;
  /** Floor on the fold's wall time, in ms — see `projectFoldCostMs`. Absent when `unknown`. */
  projectedMs?: number;
  /** The `timeoutSec` the skeleton must carry for the fold to fit. Only set on `raise`. */
  timeoutSec?: number;
}

/**
 * A FLOOR on what the recommended fold would cost, measured from the calls actually observed.
 *
 * A floor, not an estimate, and the distinction is the whole reason the gate is conservative: the
 * same-tool skeleton's own text invites the agent to EXTEND the list ("the NEXT args go here"), so
 * the real script is at least this long and usually longer. Untimed calls contribute nothing, which
 * pushes the floor down — so a burst with partial timing is judged on the part we measured and can
 * only ever under-estimate, never over-estimate, the risk of recommending it.
 *
 * Shape follows the skeleton each kind emits: `pipeline` awaits in sequence (sum); `same-tool`
 * (WI-2142449) and `fanout` are both a Promise.all (max — the script waits for the slowest branch).
 */
function projectFoldCostMs(kind: BatchNudgeKind, recent: readonly RecentCall[], toolName: string): number | undefined {
  const timed = (calls: readonly RecentCall[]): number[] =>
    calls.map((c) => c.durationMs).filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0);

  if (kind === 'same-tool') {
    // Promise.all (sameToolSkeleton, WI-2142449): all inputs fold concurrently, so the script waits
    // for the SLOWEST one, not their sum.
    const ds = timed(recent.filter((c) => c.tool === toolName).slice(-MAX_SKELETON_TOOLS));
    return ds.length ? Math.max(...ds) : undefined;
  }
  if (kind === 'pipeline') {
    const ds = timed(recent.slice(-MAX_SKELETON_TOOLS));
    return ds.length ? ds.reduce((a, b) => a + b, 0) : undefined;
  }
  // fan-out: Promise.all, so the script waits for the SLOWEST branch, not their sum. One branch per
  // distinct tool — its most recent timed call.
  const lastByTool = new Map<string, number>();
  for (const c of recent) {
    if (typeof c.durationMs === 'number' && Number.isFinite(c.durationMs) && c.durationMs >= 0) {
      lastByTool.set(c.tool, c.durationMs);
    }
  }
  const branches = [...lastByTool.values()].slice(0, MAX_SKELETON_TOOLS);
  return branches.length ? Math.max(...branches) : undefined;
}

/**
 * Decide whether to recommend the fold at all, and under what budget.
 *
 * EI-21254965187146713 is the reason this exists. The hint is persuasive by design — it prefills the
 * agent's own arguments and escalates on repetition — and it recommended chaining `testing:run`
 * calls inside a script whose budget was HALF what the dispatch stack grants a single child
 * (`exec.tool.timeoutSec ?? 60` vs a 30s script). The agent complied, the script was killed at 30s,
 * four dispatches were spent for nothing, and the work was finished with the individual calls the
 * hint had discouraged. Complying cost strictly more than ignoring it.
 *
 * Note what is NOT the fix: a list of known-slow tools. The mismatch is not special to `testing:run`
 * — 60s is the DEFAULT allowance for every tool that declares none, so any child that uses a
 * meaningful share of its own budget breaks the same way. A hand-maintained exclusion list would
 * also have to be right about tools nobody has measured yet. Measured duration answers for every
 * tool, including the next one, and cannot go stale.
 */
function assessFoldBudget(kind: BatchNudgeKind, recent: readonly RecentCall[], toolName: string): FoldBudget {
  const projectedMs = projectFoldCostMs(kind, recent, toolName);
  if (projectedMs === undefined) return { verdict: 'unknown' };
  const needed = projectedMs + FOLD_OVERHEAD_MS;
  if (needed <= DEFAULT_SCRIPT_TIMEOUT_MS) return { verdict: 'fits', projectedMs };
  if (needed <= FOREGROUND_TIMEOUT_CEILING_MS) {
    return { verdict: 'raise', projectedMs, timeoutSec: Math.ceil(needed / 1000) };
  }
  return { verdict: 'overruns', projectedMs };
}

/** Wrap a script body as the `code:run { … }` call to paste, carrying `timeoutSec` only when the
 *  measured burst needs one. Emitting it unconditionally would be worse than useless: a default-
 *  budget fold that displays an explicit budget teaches that the arg is always required. */
function codeRunCall(scriptBody: string, timeoutSec?: number): string {
  const args = timeoutSec ? `timeoutSec: ${timeoutSec}, script: ` : 'script: ';
  return `code:run { ${args}\`\n${scriptBody}\` }`;
}

const TRAILER =
  `Only the script's return re-enters context, so return what you'll need next. Or reuse a recipe ` +
  `(recipes:search { query }). Keep a call separate ONLY when you must read its result and DECIDE ` +
  `before the next (a script can't pause for you to think).`;

/** How many calls must pass before the NEXT nudge may fire, given how many have already fired this
 *  session. Exponential backoff (4 → 8 → 16 → 32 → 64, capped) so ignoring a nudge once does not
 *  silence it forever, but a persistent waster is reminded ever more sparingly rather than spammed. */
function cooldownCalls(nudgesAlreadyFired: number): number {
  const BASE = 4;
  const CAP = 64;
  return Math.min(BASE * 2 ** Math.max(0, nudgesAlreadyFired - 1), CAP);
}

/** Escalation banner prepended to a nudge based on how many have ALREADY fired this session (code-run
 *  -adoption directive 2026-06-29). The cooldown makes repeats rarer; this makes the ones that DO fire
 *  progressively firmer — a caller still firing calls one at a time after several reminders needs a
 *  stronger push, not the same neutral tip. `n` is the post-increment nudgeCount (1 = first fire), so
 *  level 1 stays the original neutral message and only persistent wasters see the louder banners. */
function escalationPrefix(n: number): string {
  if (n <= 1) return '';
  if (n === 2) return '(2nd reminder this session) ';
  if (n === 3)
    return (
      '⚠️ 3rd reminder this session — you keep firing tool calls one at a time. Please bundle the rest ' +
      'of this burst into a single code:run. '
    );
  return (
    `🚨 ${n}× reminded this session — this is a persistent one-at-a-time pattern that is burning tokens. ` +
    'Default to code:run for these calls now; keep one separate ONLY if you must read its result and ' +
    'reason before the next. '
  );
}

export type BatchNudgeKind = 'same-tool' | 'fanout' | 'pipeline' | 'preempt';

export interface BatchNudgeResult {
  /** The hint text to attach to the tool result (no `[batch-hint]` prefix — the call site adds it). */
  text: string;
  /** Copy-paste-ready code:run replay reconstructed from the calls that triggered this hint.
   * Reactive hints include the real recorded arguments; predictive preempt hints omit this because
   * the per-row verb is intentionally unknown at prediction time. */
  suggestedScript?: string;
  /** Which trigger fired — drives which feature flag gates it at the call site ('pipeline' rides
   *  the fan-out flag; telemetry records the kind verbatim, keeping the two distinguishable). */
  kind: BatchNudgeKind;
  /** The tool the trigger keyed on — the INNER tool for a tools:invoke-routed call (P-001), so
   *  telemetry attributes the fire to the real verb, not the wrapper. */
  tool: string;
}

export interface BatchNudgeInput {
  /** Advisory session key — stable owner plus the MCP transport identity when available. */
  sessionKey: string;
  /** The tool just called (MCP or verb form). */
  toolName: string;
  /** The call's raw arguments object — unwraps tools:invoke (P-001) and prefills skeletons (P-003). */
  args?: unknown;
  /** Whether the caller can actually run code:run (canRoleActOnCodeRun(role) OR superuser). */
  canCodeRun: boolean;
  /**
   * Whether code:run is in the session's LIVE advertised tool surface (P-004). A seeded session
   * whose surface lacks it can still act — via tools:find activation or tools:invoke — but the
   * hint must TEACH that path instead of advising a tool the client can't call directly.
   * Default true (full-catalog sessions).
   */
  codeRunInSurface?: boolean;
  /**
   * Measured wall time of the call just completed (EI-21254965187146713). The handler already
   * computes this one statement away for telemetry. Without it the hint can only ASSERT that
   * folding is cheaper; with it the hint can check, and decline to recommend a fold that would be
   * killed by the script budget. Optional: absent timing degrades to the pre-gate behaviour.
   */
  durationMs?: number;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

/** The activate-first path appended when code:run is not in the caller's live surface (P-004). */
const ACTIVATE_PATH_NOTE =
  `\nNote: code:run is not in your loaded tool list yet — activate it first with ` +
  `tools:find("code:run") (adds it to your surface), or run the same script without loading via ` +
  `tools:invoke { name: "code:run", args: { script } }.`;

/**
 * Record a tool call in the session's sliding window and, when a same-tool / pipeline / fan-out
 * burst is detected (and the backoff cooldown has elapsed), return a nudge steering the caller to
 * bundle the calls into one `code:run`. Returns null otherwise. Never throws. Excluded/incapable
 * callers short-circuit to null with no state — they can never produce a useful nudge.
 */
export function maybeBatchNudge(input: BatchNudgeInput): BatchNudgeResult | null {
  const { sessionKey, canCodeRun } = input;
  if (!canCodeRun || !sessionKey || !input.toolName) return null;
  // P-001: unwrap a tools:invoke-routed call to its INNER tool BEFORE exclusion + recording, so a
  // wrapper-routed burst trips the same triggers a direct burst would (and tools:invoke{name:
  // 'code:run'} stays excluded exactly like a direct code:run call).
  const { tool: toolName, args } = effectiveCall(input.toolName, input.args);
  const normalized = normalize(toolName);
  if (
    EXCLUDED_NORMALIZED.has(normalized) ||
    AMBIENT_NORMALIZED.has(normalized) ||
    LOCK_LIFECYCLE_NORMALIZED.has(normalized) ||
    SESSION_LIFECYCLE_NORMALIZED.has(normalized)
  )
    return null;
  const now = input.now ?? Date.now();

  const st = getOrCreateSession(sessionKey);

  // Record this call, then trim the ring to the window + cap (the only common-path side effects).
  const argValues = chainValues(args);
  st.recent.push({
    tool: toolName,
    at: now,
    argsRender: renderArgs(args),
    argValues: argValues.length > 0 ? argValues : undefined,
    durationMs:
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
        ? input.durationMs
        : undefined,
  });
  st.callsSinceNudge += 1;
  const cutoff = now - NUDGE_WINDOW_MS;
  let drop = 0;
  while (drop < st.recent.length && st.recent[drop].at < cutoff) drop++;
  if (drop > 0) st.recent.splice(0, drop);
  if (st.recent.length > MAX_RECENT_PER_SESSION) {
    st.recent.splice(0, st.recent.length - MAX_RECENT_PER_SESSION);
  }

  // Window stats: distinct tools (first-seen order) + total recent calls — still raw-call counts,
  // used only for the "N tool calls total" context, never for the trigger/cost math below.
  const seen = new Set<string>();
  const distinctOrder: string[] = [];
  for (const c of st.recent) {
    if (!seen.has(c.tool)) {
      seen.add(c.tool);
      distinctOrder.push(c.tool);
    }
  }
  const totalRecent = st.recent.length;

  // P-012: the trigger + the "N round-trips" cost text are keyed on INFERENCE TURNS, not raw
  // calls — several calls dispatched from ONE turn (parallel tool_use) cost a single round-trip,
  // same as one call, so they must count as one. turnOf[i] is the turn cluster for st.recent[i].
  const turnOf = clusterTurns(st.recent);
  const toolTurns = new Set<number>();
  const allTurns = new Set<number>();
  for (let i = 0; i < st.recent.length; i++) {
    allTurns.add(turnOf[i]);
    if (st.recent[i].tool === toolName) toolTurns.add(turnOf[i]);
  }
  const sameToolTurns = toolTurns.size;
  const distinctTurnsInWindow = allTurns.size;

  // Pick a trigger. Same-tool wins ties (its loop skeleton is the more precise fix); a multi-tool
  // burst splits into PIPELINE (the same id/slug threaded through different verbs — chained) vs
  // FAN-OUT (independent reads), so the text never mislabels a chain as "independent" (P-002).
  // The fan-out/pipeline gate requires BOTH ≥N distinct tools AND ≥N distinct TURNS — a burst that
  // hits the tool-diversity bar but landed inside one inference turn (already collapsed to one
  // round-trip by parallel dispatch) has nothing left to fix and must stay silent (P-012).
  let kind: BatchNudgeKind | null = null;
  if (sameToolTurns >= BATCH_NUDGE_THRESHOLD) kind = 'same-tool';
  else if (seen.size >= FANOUT_DISTINCT_THRESHOLD && distinctTurnsInWindow >= FANOUT_DISTINCT_THRESHOLD)
    kind = isChainedBurst(st.recent) ? 'pipeline' : 'fanout';
  if (!kind) return null;

  // BUDGET GATE (EI-21254965187146713) — before the backoff, deliberately. A fold we decline to
  // recommend must not consume the cooldown: the caller did nothing wrong, and burning their quota
  // here would silence the NEXT burst, which may well be foldable.
  const budget = assessFoldBudget(kind, st.recent, toolName);
  if (budget.verdict === 'overruns') return null;
  const foldTimeoutSec = budget.timeoutSec;

  // Backoff gate: the first nudge fires immediately; later ones wait out an exponential cooldown.
  if (st.everNudged && st.callsSinceNudge < cooldownCalls(st.nudgeCount)) return null;

  st.everNudged = true;
  st.nudgeCount += 1;
  st.callsSinceNudge = 0;

  const windowS = Math.round(NUDGE_WINDOW_MS / 1000);
  const banner = escalationPrefix(st.nudgeCount);
  const activate = input.codeRunInSurface === false ? ACTIVATE_PATH_NOTE : '';
  // Named only when the measured burst forced it, so the reason the arg is there travels with it.
  // WI-2142449: same-tool and fanout fold as Promise.all (max — the slowest branch), pipeline folds
  // sequentially (sum) — the wording must match, or "measured together" reads as a sum when the
  // skeleton it describes waits for only the slowest one.
  const measuredAs = kind === 'pipeline' ? 'These calls measured' : 'The SLOWEST of these calls measured';
  const budgetNote = foldTimeoutSec
    ? `\n${measuredAs} ~${Math.round((budget.projectedMs ?? 0) / 1000)}s, past code:run's ` +
      `${DEFAULT_SCRIPT_TIMEOUT_MS / 1000}s default script budget — the skeleton carries the timeoutSec that fits. ` +
      `Adding more calls to it may not fit: split them across two code:run calls rather than raising it further ` +
      `(${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s is the foreground ceiling).`
    : '';
  if (kind === 'same-tool') {
    const burst = totalRecent > sameToolTurns ? ` (${totalRecent} tool calls total this burst)` : '';
    const suggestedScript = sameToolSkeleton(toolName, st.recent, foldTimeoutSec);
    const text =
      `${banner}you've called "${toolName}" from ${sameToolTurns}× separate turns in the last ~${windowS}s${burst} — ` +
      `that's ${sameToolTurns} separate round-trips, each re-reading your whole context. Each call already carries ` +
      `its own known args, so these are independent by construction — fold them into ONE code:run: Promise.all ` +
      `over the inputs, ready-to-paste skeleton, \`inputs\` prefilled from this burst (extend it instead of firing ` +
      `another solo call). If a NEXT call's args must come from one of these results, sequence just that one ` +
      `separately instead of adding it to this list:\n` +
      `${suggestedScript}\n${TRAILER}${budgetNote}${activate}`;
    return { text, suggestedScript, kind, tool: toolName };
  }
  if (kind === 'pipeline') {
    const suggestedScript = pipelineSkeleton(st.recent, foldTimeoutSec);
    const text =
      `${banner}you've made ${totalRecent} individual tool calls across ${seen.size} different tools spanning ` +
      `${distinctTurnsInWindow} separate turns in the last ~${windowS}s — that's ~${distinctTurnsInWindow} ` +
      `round-trips, each re-reading your whole context. These calls thread ` +
      `the SAME object through different verbs — a CHAINED pipeline, and dependence does NOT mean ` +
      `one-call-per-turn: a script threads one result into the next (and can branch on it). Sequence the chain ` +
      `INSIDE one code:run — this burst as one round-trip (args prefilled):\n` +
      `${suggestedScript}\n${TRAILER}${budgetNote}${activate}`;
    return { text, suggestedScript, kind, tool: toolName };
  }
  // fan-out
  const suggestedScript = fanoutSkeleton(distinctOrder, st.recent, foldTimeoutSec);
  const text =
    `${banner}you've made ${totalRecent} individual tool calls across ${seen.size} different tools spanning ` +
    `${distinctTurnsInWindow} separate turns in the last ~${windowS}s — that's ~${distinctTurnsInWindow} ` +
    `round-trips, each re-reading your whole context. Collapse the burst ` +
    `into ONE code:run — Promise.all when the calls are independent, sequential awaits when one feeds the ` +
    `next — ready-to-paste skeleton (args prefilled from your last calls):\n` +
    `${suggestedScript}\n${TRAILER}${budgetNote}${activate}`;
  return { text, suggestedScript, kind, tool: toolName };
}

/** A subsumed re-fetch within this window after a successful coord:orient → the soft dedup nudge.
 *  Conservative (2 min) so a genuine LATER re-check in a long spawn is never nudged. */
export const ORIENT_DEDUP_WINDOW_MS = 120_000;

/** Normalized name → the human label for the slice of orient's payload this tool re-fetches. orient
 *  returns plan-events + inbox + a mem0 recall (for `intent`) AND declares intent in one round-trip,
 *  so calling any of these RIGHT AFTER a successful orient is a duplicate of what it already handed
 *  back. Keyed by `normalize()` so both the verb form and the MCP form match. */
const ORIENT_SUBSUMED_NORMALIZED: ReadonlyMap<string, string> = new Map<string, string>([
  ['coordplanevents', 'the recent plan-events delta'],
  ['coordinbox', 'your unread inbox summary'],
  ['memorysearch', 'a mem0 recall for your intent'],
  ['coorddeclareintent', 'your declared intent'],
]);

const ORIENT_NORMALIZED = 'coordorient';

export interface OrientDedupInput {
  /** Stable per-session key — the handler's replayOwnerKey (uiClientId ?? spawnId). */
  sessionKey: string;
  /** The tool just SUCCESSFULLY called (MCP or verb form). */
  toolName: string;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * P-009 (agent-tooling-token-efficiency): a SOFT, one-shot nudge — never a block — when an agent
 * calls coord:plan-events / coord:inbox / memory:search / coord:declare-intent SHORTLY AFTER a
 * successful coord:orient in the same spawn, since orient's single round-trip already returned (and,
 * for intent, already declared) exactly that. Points the agent back at orient's payload. Conservative
 * by construction: recorded only on a successful orient, fires once per (session, subsumed-tool), and
 * only inside ORIENT_DEDUP_WINDOW_MS of the orient — a genuine later re-check is left alone. Shares
 * the SAME per-session map as the batch nudge. Role-agnostic (every agent role uses orient). Never
 * throws. Returns null when there's nothing to say.
 */
export function maybeOrientDedupNudge(input: OrientDedupInput): string | null {
  const { sessionKey, toolName } = input;
  if (!sessionKey || !toolName) return null;
  const now = input.now ?? Date.now();
  const norm = normalize(toolName);

  // Record the orient itself (and never nudge it). This is the only side effect on the common path.
  if (norm === ORIENT_NORMALIZED) {
    getOrCreateSession(sessionKey).lastOrientAt = now;
    return null;
  }

  const label = ORIENT_SUBSUMED_NORMALIZED.get(norm);
  if (!label) return null; // not a tool orient subsumes — nothing to dedup

  const st = sessions.get(sessionKey);
  if (!st || st.lastOrientAt === undefined) return null; // no orient this session ⇒ a fresh fetch
  if (now - st.lastOrientAt > ORIENT_DEDUP_WINDOW_MS) return null; // too late ⇒ a deliberate re-check
  if (st.orientDedupNudged.has(norm)) return null; // one-shot per (session, tool)
  st.orientDedupNudged.add(norm);

  return (
    `coord:orient already returned ${label} this turn — reuse orient's result instead of re-fetching. ` +
    `Call "${toolName}" again only for a detail orient deliberately bounds (e.g. full bodies, or a ` +
    `different query/scope).`
  );
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * PREDICTIVE fan-out hint (EI-10894) — fire BEFORE the round-trips are paid, not after.
 *
 * Every trigger above is REACTIVE by construction: each keys on a burst of calls ALREADY MADE
 * (≥2 same-tool, ≥3 distinct tools, inside a 90s window). By the time the cheapest of them can
 * possibly fire, the agent has already paid two round-trips — and the nudge's own escalation
 * ladder ("2nd reminder… 3rd reminder…") is an admission that we are billing the agent for the
 * lesson. The waste is charged in full and THEN explained.
 *
 * But the waste is VISIBLE ONE CALL EARLIER, in a place we already hold: the list verb's own
 * result. `work_items:list` returning 12 rows, `sessions:search` returning 20 hits — that result
 * IS the fan-out about to happen. The per-row calls are the agent's obvious next move, and we can
 * see the whole set before a single one is fired. So say it THERE, attached to the list result,
 * with the ids already extracted: at that moment the cost of batching is zero (the agent has not
 * written the first solo call yet), whereas the reactive nudge asks it to abandon a loop it has
 * already started.
 *
 * The bar for firing is deliberately higher than the reactive triggers', because this hint is a
 * PREDICTION and can therefore be WRONG in a way they cannot: an agent that lists 12 rows and
 * simply reads them owes nothing. A false accusation is not free — it is exactly how a nudge
 * teaches agents to tune nudges out (the live 2026-07-12 fires that were pure hook traffic are
 * the cautionary case). So:
 *
 *   - LIST-SHAPED verbs only, by name (list / search / find / items / feed / catalog) — not "any
 *     result that happens to contain an array". coord:orient's payload holds several id-bearing
 *     arrays and is nobody's fan-out.
 *   - The rows must look ADDRESSABLE: ≥ LIST_FANOUT_MIN_ROWS object rows, and ≥80% of them
 *     carrying the same identifier key (id / slug / …). A row set you cannot address per-row
 *     cannot become a per-row fan-out.
 *   - QUIET when the caller is already batching: a code:run in the last 10 minutes suppresses it
 *     entirely. An agent that reaches for code:run does not need to be told about code:run.
 *   - ONE-SHOT per (session, tool), and a hard per-session cap. The reactive nudges escalate
 *     because they fire on proof; this one fires on a guess, so it never escalates and never nags.
 *   - The text OWNS its own conditionality — "if you were only reading the list, ignore this" —
 *     so a wrong fire costs the agent one line, not its trust in the hint.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** Rows in a list result before the predictive hint is a candidate. ">5 rows" (EI-10894): at 5 or
 *  fewer, a hand-loop is a defensible choice; past that it is strictly round-trips burned. */
export const LIST_FANOUT_MIN_ROWS = 6;

/** Fraction of rows that must carry the SAME identifier key before the set counts as addressable. */
export const LIST_FANOUT_ID_RATIO = 0.8;

/** A code:run inside this window ⇒ the caller is already batching; the predictive hint stays quiet. */
export const CODE_RUN_RECENT_MS = 600_000;

/** Hard per-session cap on predictive hints. It fires on a PREDICTION, so it must never nag. */
export const MAX_PREEMPT_PER_SESSION = 3;

/** How many ids the skeleton lists inline before eliding the rest. */
const MAX_PREEMPT_IDS = 12;

/** Normalized names of the batch tools whose USE means "this caller is already batching".
 *  Derived from {@link PREFERRED_DOOR_NORMS} so a newly-shipped door counts as batching on day one
 *  rather than when someone remembers to update a second copy. */
const BATCHING_NORMALIZED: ReadonlySet<string> = PREFERRED_DOOR_NORMS;

/** Verb suffixes that mark a LIST-SHAPED read — one whose rows are the natural unit of a
 *  follow-up call. Matched against the normalized (punctuation-stripped) tool name, so both
 *  `work_items:list` and `work_items_list` land on `workitemslist`. */
const LIST_SHAPED_SUFFIXES: readonly string[] = ['list', 'search', 'find', 'items', 'feed', 'catalog'];

/** List-shaped by NAME but never a per-row fan-out in practice — the hits are read inline, not
 *  re-fetched one by one. Excluded so the hint spends its (capped) fires where they can land. */
const NEVER_PREEMPT_NORMALIZED: ReadonlySet<string> = new Set<string>([
  'memorysearch', // recall hits ARE the answer; nobody calls a verb per hit
  'toolsfind', // returns schemas — the payload is the point
]);

/** Identifier-ish keys, in preference order: the thing a per-row follow-up call would key on. */
const ID_KEYS: readonly string[] = ['id', 'slug', 'session_id', 'sessionId', 'key', 'ref', 'path', 'name'];

function isListShaped(normalized: string): boolean {
  if (NEVER_PREEMPT_NORMALIZED.has(normalized)) return false;
  return LIST_SHAPED_SUFFIXES.some((s) => normalized.endsWith(s));
}

/** A usable identifier value: a non-blank scalar short enough to be an id/slug, not a prose blob. */
function idValue(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length < 2 || s.length > 120) return null;
  return s;
}

/** The best (key, values) the rows can be addressed by, or null when they cannot. Requires the
 *  SAME key present on ≥ LIST_FANOUT_ID_RATIO of the object rows — a set where only a third of
 *  rows carry an id is not a fan-out target, it is a heterogeneous blob. */
function addressableBy(rows: unknown[]): { key: string; values: string[]; rowCount: number } | null {
  const objectRows = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as Record<
    string,
    unknown
  >[];
  if (objectRows.length < LIST_FANOUT_MIN_ROWS) return null;

  for (const key of ID_KEYS) {
    const values: string[] = [];
    for (const row of objectRows) {
      const v = idValue(row[key]);
      if (v !== null) values.push(v);
    }
    if (values.length / objectRows.length >= LIST_FANOUT_ID_RATIO) {
      return { key, values, rowCount: objectRows.length };
    }
  }
  return null;
}

/** The predictive skeleton: the ids ALREADY EXTRACTED from the result the agent is holding, so
 *  acting on the hint is filling in one verb name — not transcribing twelve ids by hand. The
 *  per-row verb is a placeholder ON PURPOSE: we know the row set, we do NOT know what the agent
 *  means to do with it, and guessing a verb it did not want is how a helpful skeleton becomes a
 *  wrong one. Naming what we cannot know beats confidently inventing it. */
function preemptSkeleton(key: string, values: string[]): string {
  const shown = values.slice(0, MAX_PREEMPT_IDS);
  const elided = values.length > shown.length ? `,\n    /* …and ${values.length - shown.length} more */` : '';
  const plural = `${key}s`;
  return (
    'code:run { script: `\n' +
    `  const ${plural} = [\n    ${shown.map((v) => JSON.stringify(v)).join(', ')}${elided}\n  ];\n` +
    `  const out = await Promise.all(${plural}.map((${key}) => tools.call('<the per-row verb>', { ${key} })));\n` +
    '  return out; // only what you return re-enters context — project it down to what you need\n' +
    '` }'
  );
}

export interface ListFanoutPreemptInput {
  /** Advisory session key — stable owner plus the MCP transport identity when available. */
  sessionKey: string;
  /** The tool that just returned (MCP or verb form). */
  toolName: string;
  /** The call's raw arguments — used ONLY to unwrap a tools:invoke-routed call to its inner tool
   *  (P-001), so `tools:invoke { name:'work_items:list' }` is judged as the list verb it really is
   *  and a wrapper-routed code:run still registers as "this caller is batching". */
  args?: unknown;
  /**
   * The tool's parsed result payload — the rows we predict a fan-out over — supplied LAZILY.
   *
   * A thunk, not a value, because the caller sits on the MCP hot path and materializing the
   * payload means JSON.parse-ing the whole tool result. Every cheap gate (batching-recently,
   * list-shaped, one-shot, cap) is checked FIRST and the vast majority of calls return before this
   * is ever invoked, so the common path stays a couple of set lookups. A throwing thunk (a
   * non-JSON body) is treated as "nothing to judge", never as an error.
   */
  payload: () => unknown;
  /** Whether the caller can actually run code:run (canRoleActOnCodeRun(role) OR superuser). */
  canCodeRun: boolean;
  /** Whether code:run is in the session's live advertised surface (P-004); default true. */
  codeRunInSurface?: boolean;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * The PREDICTIVE trigger. Call on EVERY successful tool result (it self-selects): it records
 * code:run usage, ignores everything that is not a list-shaped read, and returns a hint only when
 * a list verb has just handed back an addressable row set big enough that a per-row loop would be
 * strictly wasteful. Pure w.r.t. the tool outcome; never throws.
 */
export function maybeListFanoutPreempt(input: ListFanoutPreemptInput): BatchNudgeResult | null {
  const { sessionKey, canCodeRun } = input;
  if (!sessionKey || !input.toolName) return null;
  const now = input.now ?? Date.now();
  const { tool: toolName } = effectiveCall(input.toolName, input.args);
  const normalized = normalize(toolName);

  // Record the batching itself FIRST — before any exclusion can short-circuit — so "this caller
  // already uses code:run" is observed even though code:run is (rightly) excluded everywhere else.
  if (BATCHING_NORMALIZED.has(normalized)) {
    getOrCreateSession(sessionKey).lastCodeRunAt = now;
    return null;
  }
  if (!canCodeRun) return null;
  if (!isListShaped(normalized)) return null;
  if (
    EXCLUDED_NORMALIZED.has(normalized) ||
    AMBIENT_NORMALIZED.has(normalized) ||
    LOCK_LIFECYCLE_NORMALIZED.has(normalized)
  )
    return null;

  const st = sessions.get(sessionKey);
  // Already batching ⇒ say nothing. The agent has demonstrated the behavior the hint teaches.
  if (st?.lastCodeRunAt !== undefined && now - st.lastCodeRunAt < CODE_RUN_RECENT_MS) return null;
  if (st?.preemptNudged.has(normalized)) return null; // one-shot per (session, tool)
  if (st !== undefined && st.preemptCount >= MAX_PREEMPT_PER_SESSION) return null;

  // Judge the payload: the biggest addressable row set anywhere in it (one hop, via the shared
  // collector — `{ results: [...] }` / `{ items: [...] }` is the common list shape). Only NOW is
  // the payload materialized — every gate above ran without parsing anything.
  let payload: unknown;
  try {
    payload = input.payload();
  } catch {
    return null; // non-JSON / unparseable body ⇒ nothing to judge. Advisory only.
  }
  let best: { key: string; values: string[]; rowCount: number } | null = null;
  for (const candidate of collectCandidateArrays(payload)) {
    const verdict = addressableBy(candidate);
    if (verdict && (!best || verdict.rowCount > best.rowCount)) best = verdict;
  }
  if (!best) return null;

  // Only NOW take the session slot — a call that produced no hint must not burn the cap.
  const state = getOrCreateSession(sessionKey);
  state.preemptNudged.add(normalized);
  state.preemptCount += 1;

  const activate = input.codeRunInSurface === false ? ACTIVATE_PATH_NOTE : '';
  const text =
    `"${toolName}" just returned ${best.rowCount} rows. If your next move is a call PER ROW, that is ` +
    `${best.rowCount} more round-trips — each one re-reading your whole context — and you have not paid ` +
    `any of them yet. Fan them out inside ONE code:run instead; the \`${best.key}\` values are already ` +
    `extracted from this result, so this is a paste, not a transcription:\n` +
    `${preemptSkeleton(best.key, best.values)}\n` +
    `If you were only reading the list, ignore this. ${TRAILER}${activate}`;
  return { text, kind: 'preempt', tool: toolName };
}

/** Test-only: clear the in-process session tracking between cases. */
/* ────────────────────────────────────────────────────────────────────────────────────────────
 * STATE-PLANE nudges (plan state-plane-adoption-2026-08-02, P-008).
 *
 * ⚠ P-008's TEXT SAID to extend the bash-substitution registry
 * (`lib/bash-substitution/pairs/`) to tool-to-tool rows. Scoping that against the tree
 * REFUTED it, and building it there would have been a parallel mechanism on the wrong
 * substrate. That registry matches a `bashPattern: RegExp` against ONE normalised bash
 * atom: it is stateless and single-atom by construction. Neither state-plane rule is
 * expressible that way — the act/quote rule fires on tool call N conditioned on tool call
 * N-k (a door read with no re-read since), and the poll rule needs a turn history. THIS
 * file is already the stateful tool-to-tool advisory plane (batch, orient-dedup,
 * list-fanout-preempt), already wired at the MCP result seam in `_mcp-handler.ts`, and
 * already keyed per session. So the ITEM'S INTENT — "reuse the audited mechanism rather
 * than inventing a new adoption lever" — is honoured by landing here; only its named
 * location was stale.
 *
 * WHY BOTHER: measured 2026-08-08 on the re-scoped metric (D-030), ACT/QUOTE adoption is
 * 15/888 = 1.7% and WAIT is 2/38 = 5.3%. Promotion by prose has asymptoted — CLAUDE.md has
 * carried the "RE-READ it, don't copy it" instruction for weeks. A result-time advisory is
 * the next tier up the D-001 ladder (see-also, measured 3.4x lift), and unlike prose it
 * fires at the MOMENT of the mistake.
 *
 * Both rules are SOFT and one-shot per session. They never block: an agent that genuinely
 * wants the door value is not wrong, and a false positive here costs a line of text.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** The pipeline DOORS whose values go stale under you. */
const DOOR_NORMALIZED: ReadonlySet<string> = new Set([
  'devpipelineposition',
  'releasecheckpointrun',
]);

/** The plane's re-read surface. */
const PLANE_READ_NORMALIZED = 'stateread';
/** The plane's push surface. */
const PLANE_SUBSCRIBE_NORMALIZED = 'statesubscribe';

/**
 * Durable writes where a stale pipeline value becomes a confidently wrong report an hour
 * later. This is the enumeration of CLAUDE.md's "quote it into a message, a plan, or a
 * work-item", and it MATCHES `QUOTE_SINK_TOOLS` in scout/state-plane-adoption.ts — the
 * metric and the nudge must target the same moments or one will report on behaviour the
 * other never prompted.
 */
const QUOTE_SINK_NORMALIZED: ReadonlySet<string> = new Set([
  'coordsend',
  'coordescalate',
  'planssetnow',
  'plansadddecision',
  'workitemscomment',
  'workitemscheckpoint',
  'workitemscomplete',
  'factsassert',
]);

/** A door value this old is no longer plausibly what the agent is about to quote. */
export const DOOR_VALUE_FRESH_MS = 10 * 60_000;
/** Door reads across this many separate TURNS inside the window read as a poll loop. */
export const DOOR_POLL_TURN_THRESHOLD = 3;
/** Window over which repeated door reads are read as ONE poll loop. */
export const DOOR_POLL_WINDOW_MS = 30 * 60_000;

export interface StatePlaneNudgeInput {
  /** Advisory session key — stable owner plus the MCP transport identity when available. */
  sessionKey: string;
  /** The tool just SUCCESSFULLY called (MCP or verb form). */
  toolName: string;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * Returns advisory text, or null when there is nothing to say.
 *
 * Recording a door read / plane read is the only side effect on the common path — the same
 * shape as `maybeOrientDedupNudge`, which records the orient and nudges nothing.
 */
export function maybeStatePlaneNudge(input: StatePlaneNudgeInput): string | null {
  const { sessionKey, toolName } = input;
  if (!sessionKey || !toolName) return null;
  const now = input.now ?? Date.now();
  const norm = normalize(toolName);

  if (norm === PLANE_READ_NORMALIZED) {
    getOrCreateSession(sessionKey).lastPlaneReadAt = now;
    return null;
  }

  if (DOOR_NORMALIZED.has(norm)) {
    const st = getOrCreateSession(sessionKey);
    st.lastDoorAt = now;
    st.lastDoorTool = toolName;

    // A door read starting a NEW turn is a poll tick; several of them is a poll loop.
    const last = st.doorTurnStarts[st.doorTurnStarts.length - 1];
    if (last === undefined || now - last > TURN_GAP_MS) st.doorTurnStarts.push(now);
    st.doorTurnStarts = st.doorTurnStarts.filter((t) => now - t <= DOOR_POLL_WINDOW_MS);

    if (
      st.doorTurnStarts.length >= DOOR_POLL_TURN_THRESHOLD &&
      !st.statePlaneNudged.has('wait')
    ) {
      // Already subscribed inside this window ⇒ the agent made the right call; stay quiet.
      if (st.lastPlaneSubscribeAt !== undefined && now - st.lastPlaneSubscribeAt <= DOOR_POLL_WINDOW_MS) {
        return null;
      }
      st.statePlaneNudged.add('wait');
      return (
        `you've read ${toolName} across ${st.doorTurnStarts.length} separate turns in the last ` +
        `${Math.round(DOOR_POLL_WINDOW_MS / 60_000)}min — that's a poll loop. ` +
        `state:subscribe { cell } PUSHES the change instead: you get woken when the value moves, ` +
        `rather than paying a round-trip per check to find it unchanged. ` +
        `Cells: gate.greenCheckpoint.verdict · gate.greenCheckpoint.candidate · deploy.3070.sha · ` +
        `git.mainBehindStaging · git.pipelinePosition (state:read {} lists them).`
      );
    }
    return null;
  }

  if (norm === PLANE_SUBSCRIBE_NORMALIZED) {
    getOrCreateSession(sessionKey).lastPlaneSubscribeAt = now;
    return null;
  }

  if (!QUOTE_SINK_NORMALIZED.has(norm)) return null;

  const st = sessions.get(sessionKey);
  if (!st || st.lastDoorAt === undefined) return null; // no pipeline value in hand
  if (now - st.lastDoorAt > DOOR_VALUE_FRESH_MS) return null; // gone stale ⇒ writing about something else
  // The ordering IS the rule: a re-read BEFORE the door call re-read nothing.
  if (st.lastPlaneReadAt !== undefined && st.lastPlaneReadAt > st.lastDoorAt) return null;
  if (st.statePlaneNudged.has('act-quote')) return null; // one-shot per session
  st.statePlaneNudged.add('act-quote');

  return (
    `you're about to commit a durable write ("${toolName}") holding a value from ` +
    `${st.lastDoorTool ?? 'a pipeline door'} read ${Math.round((now - st.lastDoorAt) / 1000)}s ago, ` +
    `and you have not re-read it since. Those values (candidate sha, gate verdict, deploy sha, ` +
    `main-behind-staging) change under you mid-turn — a transcribed copy is how a correct ` +
    `observation becomes a confidently wrong report an hour later. ` +
    `RE-READ before you quote: state:read { cell, as } — same resolver, so it is a re-read, ` +
    `never a second source of truth.`
  );
}

export function _resetBatchNudgeState(): void {
  sessions.clear();
}
