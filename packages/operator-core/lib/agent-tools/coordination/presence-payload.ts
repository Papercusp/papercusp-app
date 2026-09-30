/**
 * presence-payload.ts — the two-lane partition of a coord:presence roster row
 * (presence-v2-2026-06-14 P-009 / D-005 / D-006).
 *
 * Every enriched roster row is split into three lanes:
 *
 *   - IDENTITY  — stable for the life of the session (ownerId, label, role,
 *                 host, model, hive, started_at, …). Byte-stable across reads,
 *                 so it forms the cacheable PREFIX of the read-once snapshot
 *                 (D-006: prompt caching matches prefixes — the win is the
 *                 identity block never churning).
 *   - STATE     — discrete transitions peers ACT on (intent, plan, files,
 *                 claimed lane, blocked-on/await, wakeMode, revoked). IDENTITY ∪
 *                 STATE is the DELTA-ELIGIBLE payload (D-005 lane 1): a change in
 *                 either is what rides [coord+N] as a delta (identity rarely
 *                 changes, but a re-host / role-resolve legitimately can).
 *   - LIVENESS  — continuous signals (lastActiveSecAgo, stale). Snapshot + SSE
 *                 ONLY; NEVER injected as a [coord+N] delta (D-005 lane 2 / D-008
 *                 — injecting heartbeat churn is exactly the notify-storm we
 *                 guard against). Recomputed fresh each read.
 *
 * Byte-stability (D-006): the raw per-row timestamps (heartbeatAt / lastActiveAt)
 * are kept OUT of the emitted payload — heartbeat especially churns every read
 * (the 60s keepalive bumps it) and would break the byte-stable prefix. Their
 * signal survives as the derived `lastActiveSecAgo` (a LIVENESS scalar) plus the
 * single roster-level `as_of` stamp (P-005). startedAt is a timestamp but is
 * stable per session, so it stays in IDENTITY.
 *
 * P-008's delta channel diffs `deltaEligibleProjection` (identity+state, NO
 * liveness) so liveness churn never produces a delta; the snapshot read emits
 * `toStableRosterRow` (identity+state + the one liveness scalar worth carrying).
 * The guards in presence-payload.test.ts assert the partition covers every
 * emitted field, the lanes are disjoint, and liveness stays out of the delta
 * lane.
 */

import type { UnifiedPresenceRecord } from './federated-presence';
import { formatIdleAge, type LastActiveSource, type PresenceTier1Joins } from './presence-tier1';
import type { SessionState } from './presence-wakeability';
import type { ContextPressureBucket } from './context-pressure';
import type { SelfWakeSource } from './presence-selfwake';

/**
 * The self-referential placeholder a presence declare writes when an agent is
 * live but has declared no real intent (see the coord-hook + locks/enrich-busy).
 * It is a NON-signal on the roster — "(active — see coord:presence…)" read AS an
 * intent is circular and misleads the Queen/peers into thinking a real intent
 * exists. `toStableRosterRow` normalizes it to `null` on the READ side (P-004) so
 * the roster shows an honest "no declared intent" without touching the write path
 * (enrich-busy still relies on the written sentinel to detect the no-intent case).
 * Canonical here so every reader shares ONE string (was duplicated in enrich-busy).
 */
export const PLACEHOLDER_INTENT = '(active — see coord:presence for current work)';

/**
 * True when an intent string is a LIFECYCLE LABEL — the name of the hook or dispatch step that
 * happened to take a lock ('PreToolUse:Edit', 'capability:write') — rather than a declaration of
 * WHAT the agent is changing. Blank and {@link PLACEHOLDER_INTENT} count too: all three mean the
 * same thing to a consumer, "no usable intent here, look elsewhere".
 *
 * Canonical here, beside PLACEHOLDER_INTENT and for the same reason (EI-20055604348536487). The
 * predicate had independently grown THREE copies that did not agree — `isUninformativeLockIntent`
 * (locks/enrich-busy.ts) covered `capability:` and the placeholder, `isGenericLockIntent`
 * (harness/git-sync/git-sync-action.ts) covered neither, and the lock hook has a third in Python.
 * Two surfaces resolving one projection two ways is the divergence D-038 axis 5 forbids, and this
 * is the union: the narrower copies each classified a real sentinel as usable intent.
 *
 * ⚠ The regexes are ANCHORED to the label's own prefix, never a substring search — an agent whose
 * DECLARED intent legitimately discusses the hook ("stop PreToolUse:Edit leaking into the ledger",
 * which is literally the intent that produced this function) must not be classified as a sentinel.
 */
export function isLifecycleIntent(intent: string | null | undefined): boolean {
  const s = (intent ?? '').trim();
  if (!s || s === PLACEHOLDER_INTENT) return true;
  return /^(?:Pre|Post)ToolUse:/i.test(s) || /^capability:/i.test(s);
}

/**
 * A coord:presence roster row at the point it is emitted: the unified
 * local+federated record, plus the derived `lastActiveSecAgo`, the coordinator
 * wakeability signals (`sessionState` / `wakeable`, P-001), and the (local-only)
 * Tier-1 join scalars from `mergeTier1`. All are optional so a raw (un-enriched)
 * stale record — or a federated row with no local wakeability join — is also a
 * valid input; `partitionPresenceRow` reads every field defensively.
 */
export type RosterRow = UnifiedPresenceRecord &
  Partial<
    {
      lastActiveSecAgo: number | null;
      /** P-011: which activity source produced lastActiveSecAgo — 'presence'
       *  (coord_presence.last_active_at, the tool-dispatch path) or 'turn-parts'
       *  (freshest assistant transcript part, which sees the native-tool/streaming
       *  work the presence path misses). null = no reading at all. */
      lastActiveSource: LastActiveSource | null;
      /** Derived from lastActiveSecAgo: the declared intent is stale (the agent
       *  is process-alive but genuinely idle past the threshold). null = unknown. */
      intentStale: boolean | null;
      /** Seconds since the CURRENT `intent` string was declared (EI-8988) —
       *  distinct from lastActiveSecAgo, which also moves on activity that never
       *  touches the intent text. null = unknown (federated/never-declared). */
      intentAgeSec: number | null;
      /** Derived: the agent is genuinely active (fresh lastActiveSecAgo) but its
       *  intent TEXT is old (intentAgeSec past the divergence threshold) — a
       *  declared-vs-derived drift signal distinct from intentStale (which only
       *  fires when the agent is ALSO idle). null = unknown. */
      intentDivergent: boolean | null;
      /** P-001: live | parked | ended (null for a federated/unknown row). */
      sessionState: SessionState | null;
      /** P-001: a live inbox-wake await exists → a wake will be delivered. */
      wakeable: boolean | null;
      /** WI-4400: stale-ish takeover read — verify with coord:send wake:'required'
       * before assuming the owner is dead or alive. null = liveness unknown. */
      confirmLiveness: boolean | null;
      /** EI-19407725333778711: an active engine loop will re-wake this owner.
       * null = the self-wake enrichment was not measured. */
      loopArmed: boolean | null;
      /** EI-19407725333778711: the strongest unprompted wake source, or `none`
       * when the measured owner has no loop or standing wake await. */
      selfWake: SelfWakeSource | null;
      /**
       * EI-22805550006169069: a scheduled self-wake is armed for this owner — an
       * ACTIVE, non-stalled engine loop with a known future fire, or a turn in
       * flight right now. The SAME signal `coord:send`'s wake result already
       * reports as `recipient_dormant_scheduled`, mirrored here deliberately so
       * the two surfaces read with the same word (`classifyDormantSchedule` is
       * the one shared derivation — inbox-wake.ts).
       *
       * Why it exists: every other field on this row was individually ACCURATE
       * for an agent that was merely DORMANT BETWEEN LOOP FIRES — `sessionState`
       * 'ended', `wakeable` false, `claims` 0, `lastActiveSecAgo` null — because
       * its session really had ended and it really held no claim. The row was not
       * wrong, it was INCOMPLETE, and a reader cannot repair incompleteness by
       * reading more carefully: it is byte-identical to a genuinely dead agent,
       * which is what invites a wrongful reclaim/relaunch. This field is the one
       * datum that separates "gone" from "back at nextFireAt".
       *
       * `false` = MEASURED, nothing will self-wake this owner. `null` = NOT
       * MEASURED (a federated row, or the best-effort loop read degraded) — never
       * collapse it to `false`, exactly as `selfWake`/`loopArmed` must not be.
       */
      dormantScheduled: boolean | null;
      /**
       * ISO timestamp of that scheduled fire — when a message actually gets seen,
       * with NO respawn needed. `null` while the loop is PARKED (a turn is in
       * flight right now, so the fire is imminent rather than at a known future
       * time) and null when `dormantScheduled` is not true; read the pair
       * together, never this field alone.
       */
      nextFireAt: string | null;
      /** P-007 (fleet-deltas-leader-primitives-2026-07-10): the coarse per-member
       *  context-pressure bucket (ok|high|critical), derived from the SAME watchdog-
       *  cached (context_tokens, compaction_limit) the ambient gauge bands on — a
       *  CONTINUOUS, churning signal (advances every watchdog sweep), so it lives in
       *  LIVENESS like sessionState/wakeable, never delta-eligible. null = unknown
       *  (untracked owner / federated peer), never coerced to 'ok'. */
      contextPressure: ContextPressureBucket | null;
      /** Seconds since the watchdog cached the context reading behind
       * contextPressure. null = provenance unavailable. Kept adjacent to the
       * bucket so consumers can distinguish a recent reading from one near the
       * staleness cutoff without another read. */
      contextPressureAgeSec: number | null;
      /** This session is CURRENTLY on the desktop — a live OS window on the
       *  user's screen (derived live via wmctrl + adv_sessions.window_id; owner
       *  decision 2026-06-29). true ⇒ hard-exempt from the idle-session reaper
       *  and the target for "assign these to the agent on the desktop". null for a
       *  federated/unknown row (its windows live on its home box). */
      onDesktop: boolean | null;
      /** A human is CURRENTLY viewing this session's terminal in the operator
       *  web/Tauri PTY panel (pty-viewer-heartbeat.ts). true ⇒ hard-exempt from the
       *  idle-session reaper even with NO OS window — the deferred sibling of
       *  onDesktop for the panel-viewed case. null for a federated/unknown row. */
      viewerAttached: boolean | null;
      /** named-su-agent-fleets P-005: the agent's named-fleet slug (the SOFT
       *  coord_presence membership label, joined in via fetchPresenceFleet — it does
       *  NOT ride the base PresenceRecord the way hive_slug does). Absent ⇒ no fleet. */
      fleetSlug: string | null;
      /** named-su-agent-fleets P-005: role within the fleet ('leader' | 'member'). */
      fleetRole: string | null;
      /** EI-22072194984361823: the fleet's CONTROL state alongside its name —
       *  'active' | 'winding-down' (agent-fleets-store.getFleetControlStates).
       *  `fleet` was presented as an identity label with a hidden capability
       *  consequence: a MEMBER of a winding-down fleet cannot acquire new work
       *  (fleet-scope-admission.ts fleetControlWindDownRefusal) even though every
       *  other presence signal reads live/wakeable. Present only alongside
       *  fleetSlug (same no-null-spam convention); absent for a non-fleet agent
       *  or when the batched control-state read failed (fail-soft — never
       *  fabricates a gate that may not exist). */
      fleetControlState: 'active' | 'winding-down' | null;
      /** EI-22072194984361823: convenience boolean a router can filter on
       *  directly, derived from fleetControlState + fleetRole. false ONLY for a
       *  fleet MEMBER (never a leader — the winding-down gate is member-only,
       *  see resolveFleetScopeContext) whose fleet is winding-down. Present only
       *  alongside fleetSlug; a non-fleet agent has no entry (it is never gated
       *  by this at all, which is what its absence means — same convention as
       *  fleetSlug itself). */
      canAcquireWork: boolean;
    } & PresenceTier1Joins
  >;

/** IDENTITY lane — stable for the life of the session. */
export const PRESENCE_IDENTITY_FIELDS = [
  'ownerId',
  'ownerLabel',
  'workspaceId',
  'source',
  'host',
  'pid',
  'startedAt',
  'agentRole',
  'potSlug',
  'fleetSlug',
  'fleetRole',
  // EI-22072194984361823: grouped with fleetSlug/fleetRole (same lane, same
  // present-only-for-fleet-members convention) — see the field doc comments
  // on RosterRow above for why a control-state flip belongs beside the
  // membership fields it qualifies rather than in LIVENESS (it is a discrete,
  // rare transition a router acts on, not a continuous signal).
  'fleetControlState',
  'canAcquireWork',
  'model',
  'userId',
  'federated',
  'devicePubkey',
  'harnessSlug',
] as const satisfies readonly (keyof RosterRow)[];

/** STATE lane — discrete transitions; the delta-eligible payload (with IDENTITY). */
export const PRESENCE_STATE_FIELDS = [
  'intent',
  // EI-8988: when `intent` was last declared — stable (byte-identical) until the
  // intent text itself changes, exactly like `intent`, so it belongs beside it in
  // STATE, not LIVENESS (unlike the derived intentAgeSec, which churns every read).
  'intentDeclaredAt',
  'currentPlanSlug',
  'currentView',
  'currentFiles',
  'claimedItems',
  // Unified plan-item + work-item occupancy count. The work-item ids remain
  // off the compact row; this keeps claim presence visible without merging id
  // spaces into the plan-local `claimedItems` lane.
  'claimCount',
  // EI-20200393414409502: plan-QUALIFIED refs (`<slug>#<item>`) for the plan items an
  // agent occupies through held, non-terminal work-items. It is emitted (unlike its
  // sibling join `workItemClaims`, which is deliberately not) because the coupling
  // derivation reads STABILIZED rows — `deriveCouplings` is handed `snapshot.active`,
  // i.e. the output of `toStableRosterRow`, so a field absent from this list is not
  // "cheaper", it is INVISIBLE to the derivation no matter what the producer joins.
  // The producer omits it when empty, so the common row is unchanged on the wire.
  'claimedPlanItemRefs',
  'awaitingEvent',
  'awaitingEventKey',
  'awaitingNote',
  'wakeMode',
  'revoked',
] as const satisfies readonly (keyof RosterRow)[];

/** LIVENESS lane — continuous; snapshot + SSE only, NEVER injected as a delta.
 *  `sessionState` / `wakeable` (P-001) live here, not in the delta-eligible set,
 *  because they are derived from continuous liveness signals (heartbeat freshness
 *  + activity recency) — a live↔parked flip on every turn-park is exactly the
 *  churn the delta channel must not carry. A coordinator reads them from the
 *  snapshot (coord:presence), which is their use case. */
export const PRESENCE_LIVENESS_FIELDS = [
  'lastActiveSecAgo',
  // P-011: provenance of the reading above — moves with it, same lane, never a delta.
  'lastActiveSource',
  'intentStale',
  // EI-8988: both derived from a churning "seconds since" clock, same lane as
  // lastActiveSecAgo/intentStale — never delta-eligible.
  'intentAgeSec',
  'intentDivergent',
  'stale',
  'sessionState',
  'wakeable',
  'confirmLiveness',
  'loopArmed',
  'selfWake',
  // EI-22805550006169069: the forward-looking half of the same liveness question
  // sessionState/wakeable answer backward-looking, derived every read from the
  // loop's own schedule — continuous (nextFireAt advances on every fire), so it
  // belongs in LIVENESS and must never ride the byte-stable [coord+N] delta.
  'dormantScheduled',
  'nextFireAt',
  // P-007: derived every read from the watchdog-cached tokens/limit — continuous,
  // same lane as sessionState/wakeable, never a [coord+N] delta.
  'contextPressure',
  'contextPressureAgeSec',
  // Derived live from the OS window list each read — a continuous external
  // signal, so it lives in LIVENESS (snapshot-only, never a [coord+N] delta:
  // open/close-window churn must not ride the byte-stable delta channel).
  'onDesktop',
  // Same lane as onDesktop: a continuous external signal (a human watching the PTY
  // panel), so it's snapshot-only and never rides the byte-stable [coord+N] delta.
  'viewerAttached',
] as const satisfies readonly (keyof RosterRow)[];

/**
 * Fields deliberately DROPPED from the emitted roster payload. Listed so the
 * coverage guard treats them as intentionally unclassified, not an oversight.
 * heartbeatAt/lastActiveAt churn every read and would break byte-stability;
 * capabilityTags (WI-1546) is a DG-3 shard-scheduling detail — irrelevant to
 * a coord:presence roster viewer and not worth its bytes on the lean row.
 * `tty` follows the capabilityTags precedent: a device path like /dev/pts/5 is
 * meaningful ONLY on the machine that owns it, so it is bytes no remote roster
 * viewer can act on. Its one consumer (tools/mark-terminal.ts) reads the
 * presence ROW from the store directly and never goes through this partition,
 * so dropping it here costs that path nothing. Deliberately NOT in IDENTITY:
 * IDENTITY ∪ STATE is the delta-eligible set, and a local device path has no
 * business riding every peer's [coord+N] delta.
 */
export const PRESENCE_DROPPED_FIELDS = [
  'heartbeatAt',
  'lastActiveAt',
  'capabilityTags',
  'tty',
  // P-011: derivation input only (the raw transcript-part timestamp behind
  // lastActiveSecAgo/lastActiveSource). mergeTier1 strips it before the join spread
  // for exactly the reason lastActiveAt is dropped: raw churning timestamps do not
  // belong on the emitted row — the derived scalar + provenance carry the signal.
  'turnPartLastAt',
] as const satisfies readonly (keyof RosterRow)[];

/** The delta-eligible field set (D-005 lane 1) = IDENTITY ∪ STATE. A change in
 *  any of these is what may ride [coord+N]; LIVENESS is disjoint and never a
 *  delta. */
export const PRESENCE_DELTA_FIELDS: readonly (keyof RosterRow)[] = [
  ...PRESENCE_IDENTITY_FIELDS,
  ...PRESENCE_STATE_FIELDS,
];

/**
 * Canonical key order for the raw/full coord:presence row.
 *
 * `partitionPresenceRow` intentionally omits fields that a source cannot
 * measure (for example, local Tier-1 joins on a federated row). That is the
 * right internal representation, but it is not a safe wire shape: a mixed
 * local/federated roster otherwise contains disjoint key sets, so a caller
 * filtering on an optional field silently drops one population. Full-tier
 * output fills these core fields with `null`; handler-only overlays are added
 * from the response's observed key union below.
 *
 * `stale` is deliberately absent: the active/stale split carries that signal
 * structurally, and the stable row has never emitted it.
 */
export const PRESENCE_FULL_ROW_FIELDS = [
  ...PRESENCE_IDENTITY_FIELDS,
  ...PRESENCE_STATE_FIELDS,
  'lastActiveSecAgo',
  'lastActiveSource',
  'intentStale',
  'intentAgeSec',
  'intentDivergent',
  'sessionState',
  'wakeable',
  'confirmLiveness',
  'loopArmed',
  'selfWake',
  'dormantScheduled',
  'nextFireAt',
  'contextPressure',
  'contextPressureAgeSec',
  'onDesktop',
  'viewerAttached',
] as const;

const PRESENCE_FULL_ROW_FIELD_SET = new Set<string>(PRESENCE_FULL_ROW_FIELDS);

/**
 * Normalize the raw/full wire rows to one key set without inventing values.
 *
 * Core presence fields are always present (with `null` when unmeasured).
 * Optional response overlays (`modes`, `parkedOn`, `heldFiles`, `cursor`,
 * `isSelf`, and future additions) are discovered from the complete response
 * and filled with `null` on rows that do not carry them. `undefined` is also
 * normalized because JSON serialization would otherwise omit it and recreate
 * the mixed-shape defect.
 */
export function normalizeFullPresenceRows(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const overlayFields = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!PRESENCE_FULL_ROW_FIELD_SET.has(key)) overlayFields.add(key);
    }
  }
  const keys = [...PRESENCE_FULL_ROW_FIELDS, ...[...overlayFields].sort()];
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const key of keys) {
      const value = row[key];
      normalized[key] = value === undefined ? null : value;
    }
    return normalized;
  });
}

export interface PartitionedPresenceRow {
  /** Stable identity block (byte-stable across reads). */
  identity: Partial<RosterRow>;
  /** Discrete-transition state block (delta-eligible with identity). */
  state: Partial<RosterRow>;
  /** Continuous liveness block (snapshot-only, never a delta). */
  liveness: Partial<RosterRow>;
}

/** Copy the present, defined `fields` of `row` into a fresh object, preserving
 *  the field-set's order (deterministic key order → byte-stable serialization).
 *  A field absent on the row (e.g. a federated row has no `model`) is omitted,
 *  not emitted as `undefined`. */
function pick<K extends keyof RosterRow>(
  row: RosterRow,
  fields: readonly K[],
): Partial<Pick<RosterRow, K>> {
  const out: Partial<Pick<RosterRow, K>> = {};
  for (const k of fields) {
    if (k in row && row[k] !== undefined) {
      (out as Record<K, unknown>)[k] = row[k];
    }
  }
  return out;
}

/** Split a roster row into its identity / state / liveness lanes (D-005/D-006). */
export function partitionPresenceRow(row: RosterRow): PartitionedPresenceRow {
  return {
    identity: pick(row, PRESENCE_IDENTITY_FIELDS),
    state: pick(row, PRESENCE_STATE_FIELDS),
    liveness: pick(row, PRESENCE_LIVENESS_FIELDS),
  };
}

/**
 * The delta-eligible projection (P-008 input): identity + state ONLY. P-008
 * diffs this between snapshots so liveness churn never produces a [coord+N]
 * delta. Key order is identity-then-state → deterministic.
 */
export function deltaEligibleProjection(row: RosterRow): Partial<RosterRow> {
  const { identity, state } = partitionPresenceRow(row);
  return { ...identity, ...state };
}

/**
 * The lean, byte-stable roster row the coord:presence tool emits: the
 * delta-eligible projection (identity + state) plus the one liveness scalar
 * worth carrying in a snapshot, `lastActiveSecAgo`. Its identity+state portion
 * is byte-identical across reads of an unchanged agent (no raw timestamps, one
 * roster `as_of`); only `lastActiveSecAgo` moves, and that is the liveness lane
 * which the delta channel ignores. `stale` is conveyed structurally (the active
 * vs stale array), so it is not re-emitted per row.
 */
export function toStableRosterRow(row: RosterRow): Record<string, unknown> {
  const { identity, state, liveness } = partitionPresenceRow(row);
  const out: Record<string, unknown> = {
    ...identity,
    ...state,
    lastActiveSecAgo: (liveness.lastActiveSecAgo as number | null | undefined) ?? null,
    // P-011: provenance of lastActiveSecAgo — 'turn-parts' means the transcript leg
    // improved on the presence record's reading. Always present for a reader.
    lastActiveSource: (liveness.lastActiveSource as LastActiveSource | null | undefined) ?? null,
    // Stale-ownership signal: TRUE ⇒ this agent's declared intent/lane is NOT being
    // actively progressed (idle past the threshold though its process still beats),
    // so a reader must not treat its work as "handled". Always present for a reader.
    intentStale: (liveness.intentStale as boolean | null | undefined) ?? null,
    // EI-8988: declared-vs-derived divergence signal, always present for a reader.
    intentAgeSec: (liveness.intentAgeSec as number | null | undefined) ?? null,
    intentDivergent: (liveness.intentDivergent as boolean | null | undefined) ?? null,
    // P-001: the coordinator's "can I hand this agent work?" signals. Emitted as
    // explicit nulls for a federated/unknown row (its await lives on its home
    // instance, so we cannot derive them locally) rather than omitted, so the
    // field is always present for a reader.
    sessionState: (liveness.sessionState as SessionState | null | undefined) ?? null,
    wakeable: (liveness.wakeable as boolean | null | undefined) ?? null,
    // WI-4400: this is intentionally a liveness-lane field, not a durable state
    // transition. Readers must confirm a draining/suspect candidate by sending
    // coord:send { wake:'required' } and inspecting its wake result.
    confirmLiveness: (liveness.confirmLiveness as boolean | null | undefined) ?? null,
    // EI-19407725333778711: a missing enrichment is UNKNOWN, not evidence that
    // the owner has no self-wake source.
    loopArmed: (liveness.loopArmed as boolean | null | undefined) ?? null,
    selfWake: (liveness.selfWake as SelfWakeSource | null | undefined) ?? null,
    // P-007: always present for a reader (null = unknown), like sessionState/wakeable.
    contextPressure: (liveness.contextPressure as ContextPressureBucket | null | undefined) ?? null,
    contextPressureAgeSec: (liveness.contextPressureAgeSec as number | null | undefined) ?? null,
    // "On the desktop right now" — always emitted (null when un-derived, e.g. a
    // federated row), so a reader can always filter "agents on the desktop".
    onDesktop: (liveness.onDesktop as boolean | null | undefined) ?? null,
    // "A human is viewing this session's PTY panel right now" — always emitted (null
    // when un-derived, e.g. a federated row), so a reader can always filter it.
    viewerAttached: (liveness.viewerAttached as boolean | null | undefined) ?? null,
  };
  // P-004: the self-referential placeholder intent is a non-signal — normalize it to
  // null so a reader (and the Queen) never mistakes it for a real declared intent.
  if (out.intent === PLACEHOLDER_INTENT) out.intent = null;
  // EI-9696: bake staleness INTO the intent string readers consume. A stale
  // declared intent renders in confident present tense ("UNPAUSE fleet — resume
  // drain") hours after the agent's last real activity, and the adjacent
  // intentStale boolean + raw-seconds lastActiveSecAgo were demonstrably read
  // past (a reader took ~20 parked agents for active editors). Prefixing the
  // string itself makes that misread impossible. Applied HERE (emit-side
  // projection only), never upstream: the etag + [coord+N] delta channel diff
  // the RAW rows, so the minute-churning age never breaks the byte-stable
  // delta contract (D-005/D-006).
  if (out.intentStale === true && typeof out.intent === 'string' && out.intent) {
    const age = out.lastActiveSecAgo;
    out.intent =
      typeof age === 'number' ? `[idle ${formatIdleAge(age)}] ${out.intent}` : `[idle] ${out.intent}`;
  }
  return out;
}
