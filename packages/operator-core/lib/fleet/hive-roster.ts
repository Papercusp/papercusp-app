/**
 * hive-roster — presence-v2 Phase 3 fold (presence-v2-2026-06-14 P-006/P-015):
 * ONE unified per-agent live-state surface for a Hive. Folds the coord:presence
 * read (identity + the mig-277 last_active_at/agent_role/hive_slug scalars +
 * the P-003 Tier-1 enrichment) together with the fleet:assignments work-detail
 * ({doing,queued,load,orphaned,claims,declaredUnclaimed}). Fold, don't duplicate:
 * fleet_assignment is already a projection-shaped view — this COMPOSES it with
 * presence rather than re-deriving either.
 *
 * MUST preserve the {doing,queued,load,orphaned} shape: the shipped Queen
 * placement survey (local-hive-orchestration P-030) + the B10 member dashboard
 * consume it (D-009#2 / P-015). It does — every HiveRosterEntry extends
 * AgentAssignment unchanged; presence/Tier-1 are additive fields.
 *
 * Composition only — NO edits to su-85dd2's in-flight coord:presence read
 * (P-003): this imports the EXPORTED reads (listPresence + the pure
 * fetchPresenceTier1/deriveLastActive) and folds their output. The pure
 * halves (filterPresenceToHive / foldHiveRoster) unit-test without PG;
 * listHiveRoster is the thin IO wrapper, with a DI seam (readPresence) so
 * su-85dd2's Phase-2 hive-scoped read (incl. federated peers, P-004) drops in.
 */
import { listPresence } from '../agent-tools/coordination/presence';
import {
  deriveLastActive,
  fetchPresenceTier1,
  stripTurnPartLastAt,
  type PresenceTier1Joins,
} from '../agent-tools/coordination/presence-tier1';
import {
  fetchWakeability,
  type SessionState,
  type WakeabilitySignals,
} from '../agent-tools/coordination/presence-wakeability';
import { deriveVerdict } from '../agent-tools/coordination/liveness-oracle';
import { recordedLiveOwnerIds } from '../adv-sessions';
import { listFleetAssignments, groupByAgent, type AgentAssignment } from './assignments';
import { machineFingerprint } from '../identity/device-keychain-id';

/** The presence fields the fold needs — structurally a `PresenceRecord` (local)
 *  or `UnifiedPresenceRecord` (federated). Kept structural so foldHiveRoster
 *  unit-tests without importing the store types. */
export interface FoldPresence {
  ownerId: string;
  ownerLabel: string | null;
  source: string | null;
  intent: string;
  currentPlanSlug: string | null;
  host: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  lastActiveAt: string | null;
  agentRole: string | null;
  potSlug: string | null;
  userId: string | null;
  stale: boolean;
  /** Supervisor-beat pid (WI-3898 P1) — enables the oracle's local kill(pid,0)
   *  probe, exactly like coord:presence (unification P-007). */
  pid?: number | null;
  federated?: boolean;
  /** WI-1495: the machine this session is homed on. A FEDERATED row carries its
   *  announced `shared_session_presence.machine_label` (surfaced on
   *  UnifiedPresenceRecord); a LOCAL row has none on the wire, so the assembly
   *  layer backfills this machine's fingerprint — see foldHiveRoster's
   *  `localMachineLabel`. Lets a roster consumer group/tab by machine. */
  machineLabel?: string | null;
}

/** One agent's unified live-state: the fleet work-detail (AgentAssignment,
 *  shape-preserved) + presence identity + the mig-277 scalars + Tier-1. */
export interface HiveRosterEntry extends AgentAssignment {
  ownerLabel: string | null;
  source: string | null;
  host: string | null;
  startedAt: string | null;
  lastActiveAt: string | null;
  agentRole: string | null;
  potSlug: string | null;
  userId: string | null;
  federated: boolean;
  /** WI-1495: which MACHINE this agent is homed on — the federated peer's
   *  announced machine_label, or this host's fingerprint for a local agent.
   *  `federated` only says local-vs-remote; this says WHICH remote, so a
   *  consumer can group into per-machine tabs and count "across N machines".
   *  null when the row is federated but announced no label. */
  machineLabel: string | null;
  /** Unification P-007: the coordinator-facing verdict, derived by the SAME
   *  liveness oracle as coord:presence / fleet:status — this surface used to
   *  serve heartbeat-only `alive` with no sessionState at all (audit F6).
   *  null for a federated peer / when the wakeability read is unavailable. */
  sessionState: SessionState | null;
  confirmLiveness: boolean | null;
  // ── Tier-1 (P-003) — populated for local agents; null/empty for federated peers
  lastActiveSecAgo: number | null;
  claimedItems: string[];
  model: string | null;
  awaitingEvent: boolean;
  awaitingEventKey: string | null;
  awaitingNote: string | null;
  wakeMode: string | null;
}

const EMPTY_TIER1: PresenceTier1Joins = {
  claimedItems: [],
  model: null,
  awaitingEvent: false,
  awaitingEventKey: null,
  awaitingNote: null,
  wakeMode: 'auto',
};

/** Synthesize a work-detail-empty AgentAssignment for a presence-only agent
 *  (idle, or a federated peer with no local claims). */
function assignmentFromPresence(p: FoldPresence): AgentAssignment {
  return {
    agentId: p.ownerId,
    label: p.ownerLabel,
    name: null,
    present: true,
    alive: !p.stale,
    heartbeatAt: p.heartbeatAt,
    intent: p.intent,
    declaredPlanSlug: p.currentPlanSlug,
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
  };
}

/** Pure: scope a presence list to one Hive. Local rows carry hive_slug (mig 277);
 *  rows with NULL hive_slug (SU / standalone) are included when
 *  `includeUnattributed` (they share the workspace but no Hive home). Federated
 *  peers are kept when their hive_slug matches (already hive-keyed) or unset. */
export function filterPresenceToHive(
  presence: FoldPresence[],
  potSlug: string,
  includeUnattributed: boolean,
): FoldPresence[] {
  return presence.filter(
    (p) => p.potSlug === potSlug || (includeUnattributed && p.potSlug == null),
  );
}

/**
 * PURE fold: one entry per agent across the UNION of presence + assignments,
 * keyed by ownerId. Keeps the fleet work-detail unchanged (shape-preserved for
 * the Queen survey + dashboard) and attaches presence identity + mig-277 scalars
 * + Tier-1. Sort: live first, then orphan-holders, then newest heartbeat.
 */
export function foldHiveRoster(
  presence: FoldPresence[],
  assignments: AgentAssignment[],
  tier1: Map<string, PresenceTier1Joins>,
  nowMs: number,
  wakeability: Map<string, WakeabilitySignals> = new Map(),
  recordedLive: ReadonlySet<string> = new Set<string>(),
  /** WI-1495: this host's machine label, stamped onto LOCAL (non-federated)
   *  rows — federated rows already carry their own announced label. Injected
   *  rather than read from the OS here so the fold stays pure/testable (same
   *  posture as `nowMs`). Defaults to null: every pre-WI-1495 caller keeps its
   *  exact prior behaviour. */
  localMachineLabel: string | null = null,
): HiveRosterEntry[] {
  const presById = new Map(presence.map((p) => [p.ownerId, p]));
  const asgById = new Map(assignments.map((a) => [a.agentId, a]));
  const ids = new Set<string>([...presById.keys(), ...asgById.keys()]);
  const out: HiveRosterEntry[] = [];
  for (const id of ids) {
    const p = presById.get(id) ?? null;
    const base = asgById.get(id) ?? (p ? assignmentFromPresence(p) : null);
    if (!base) continue;
    // Unification P-007: derive the coordinator-facing sessionState via the
    // shared liveness oracle and GATE `alive` on it — this fold used to serve
    // heartbeat-only `alive` (audit F6), so a cleanly-ended session read alive
    // for the ~10-min warm window in the Queen survey + spawn dossier. A row
    // with no wakeability entry keeps heartbeat-derived `alive` + null state.
    const w = wakeability.get(id);
    const tier = tier1.get(id);
    const claimsHeld =
      base.load > 0 ||
      (tier?.claimedItems?.length ?? 0) > 0 ||
      (tier?.workItemClaims?.length ?? 0) > 0;
    const v = w
      ? deriveVerdict(
          {
            ownerId: id,
            heartbeatAt: p?.heartbeatAt ?? base.heartbeatAt,
            stale: p ? p.stale : !base.alive,
            host: p?.host,
            pid: p?.pid,
            claimsHeld,
          },
          w,
          recordedLive,
          nowMs,
        )
      : null;
    const sessionState: SessionState | null = v?.sessionState ?? null;
    const alive =
      sessionState === 'ended' || sessionState === 'suspect' || sessionState === 'draining'
        ? false
        : sessionState === 'recorded'
          ? true
          : base.alive;
    out.push({
      ...base,
      alive,
      // P-008: the RAW freshness signal under its honest name — never gated by
      // the verdict (a warm-dead session is heartbeatFresh:true + ended).
      heartbeatFresh: v?.heartbeatFresh ?? (p ? !p.stale : base.alive),
      sessionState,
      confirmLiveness: v?.confirmLiveness ?? null,
      ownerLabel: p?.ownerLabel ?? base.label,
      source: p?.source ?? null,
      host: p?.host ?? null,
      startedAt: p?.startedAt ?? null,
      lastActiveAt: p?.lastActiveAt ?? null,
      agentRole: p?.agentRole ?? null,
      potSlug: p?.potSlug ?? null,
      userId: p?.userId ?? null,
      federated: Boolean(p?.federated),
      // WI-1495: a federated row's announced label wins; a local row (or a
      // federated row that announced none) falls back to this host's label.
      machineLabel: p?.machineLabel ?? (p?.federated ? null : localMachineLabel),
      // P-011: same combined derivation as coord:presence (one oracle) — the
      // transcript leg's raw timestamp is derivation input, stripped from the row.
      lastActiveSecAgo: deriveLastActive(
        p?.lastActiveAt ?? null,
        tier1.get(id)?.turnPartLastAt ?? null,
        nowMs,
      ).lastActiveSecAgo,
      ...EMPTY_TIER1,
      ...stripTurnPartLastAt(tier1.get(id)),
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.alive) - Number(a.alive) ||
      Number(b.orphaned) - Number(a.orphaned) ||
      (b.heartbeatAt ?? '').localeCompare(a.heartbeatAt ?? ''),
  );
}

/** A lean per-agent snapshot line — the dossier / volatile-tail shape
 *  (directed-wake-honesty-and-spawn-handoff P-021 seam: su-7b271's
 *  assembleSpawnHydration consumes this per-spawn). Drops the heavy arrays
 *  (queued / claims / full work items) for a one-line-per-agent glance, keeping
 *  the coordination-relevant scalars. Pure + bounded by hive size (D-002), so it
 *  is cheap to render on the volatile tail. */
export interface RosterSnapshotLine {
  ownerId: string;
  label: string | null;
  agentRole: string | null;
  alive: boolean;
  /** Seconds since GENUINE activity (last_active_at, D-003) — NOT keepalive heartbeat. */
  lastActiveSecAgo: number | null;
  /** Head-of-line work-item id (doing.id), or null when idle. */
  doing: string | null;
  load: number;
  claimedItems: string[];
  awaitingEvent: boolean;
  federated: boolean;
}

/** Pure: project the full hive roster down to the lean dossier snapshot lines. */
export function toRosterSnapshot(entries: HiveRosterEntry[]): RosterSnapshotLine[] {
  return entries.map((e) => ({
    ownerId: e.agentId,
    label: e.ownerLabel ?? e.label,
    agentRole: e.agentRole,
    alive: e.alive,
    lastActiveSecAgo: e.lastActiveSecAgo,
    doing: e.doing?.id ?? null,
    load: e.load,
    claimedItems: e.claimedItems,
    awaitingEvent: e.awaitingEvent,
    federated: e.federated,
  }));
}

/** Compact relative-age label for a roster line (precomputed seconds → "3m"). */
function fmtRosterAge(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/**
 * Pure: render a roster snapshot to a compact, bounded markdown block — the
 * trusted (local, never-framed) `### Hive peers` body for the directed-wake P-021
 * spawn-hydration seam. Ranks alive + most-recently-active first and caps to
 * `maxPeers` so the block stays small; a non-silent "+N more" tail marks any
 * omission. Returns '' for an empty roster (the seam then omits the section).
 */
export function renderRosterSnapshot(lines: RosterSnapshotLine[], maxPeers = 12): string {
  if (lines.length === 0) return '';
  const ranked = [...lines].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const aa = a.lastActiveSecAgo ?? Number.POSITIVE_INFINITY;
    const bb = b.lastActiveSecAgo ?? Number.POSITIVE_INFINITY;
    return aa - bb;
  });
  const shown = ranked.slice(0, Math.max(0, maxPeers));
  const out = shown.map((p) => {
    const who = p.label ? `${p.label} (${p.ownerId})` : p.ownerId;
    const role = p.agentRole ? ` ${p.agentRole}` : '';
    const state = !p.alive ? 'offline' : p.doing ? `on ${p.doing}` : p.awaitingEvent ? 'awaiting' : 'idle';
    const age = p.lastActiveSecAgo != null ? ` · active ${fmtRosterAge(p.lastActiveSecAgo)} ago` : '';
    return `- ${who}${role} — ${state}${age}`;
  });
  if (ranked.length > shown.length) out.push(`- …+${ranked.length - shown.length} more peer(s)`);
  return out.join('\n');
}

export interface ListHiveRosterOpts {
  potSlug: string;
  workspaceId?: string | null;
  /** Include local agents with NULL hive_slug (SU / standalone) sharing the
   *  workspace. Default true. */
  includeUnattributed?: boolean;
  /** DI seam: the presence source. Defaults to listPresence (LOCAL rows). When
   *  su-85dd2's Phase-2 hive-scoped read (incl. federated peers, P-004) lands,
   *  inject it here so the fold spans the whole hive without a rewrite. */
  readPresence?: (opts: { workspaceId?: string | null }) => Promise<FoldPresence[]>;
}

/**
 * The unified hive-roster read (P-006). Hive-scopes presence, enriches with
 * Tier-1, joins the fleet work-detail, and folds — one read for "who's in this
 * hive and exactly what each is doing".
 */
export async function listHiveRoster(opts: ListHiveRosterOpts): Promise<HiveRosterEntry[]> {
  const { potSlug, workspaceId } = opts;
  const includeUnattributed = opts.includeUnattributed !== false;
  const readPresence = opts.readPresence ?? ((o) => listPresence(o));
  const presenceAll = await readPresence({ workspaceId });
  const presence = filterPresenceToHive(presenceAll, potSlug, includeUnattributed);
  const inHive = new Set(presence.map((p) => p.ownerId));
  const localIds = presence.filter((p) => !p.federated).map((p) => p.ownerId);
  // Wakeability + recorded legs are best-effort (unification P-007): a failed
  // read degrades to the legacy heartbeat-only `alive` + null sessionState,
  // never breaks the roster (the same posture as fleet-roster's bounded legs).
  const [tier1, rows, wakeability, recordedLive] = await Promise.all([
    fetchPresenceTier1(localIds),
    listFleetAssignments({ workspaceId }),
    fetchWakeability(localIds).catch(() => new Map<string, WakeabilitySignals>()),
    recordedLiveOwnerIds(localIds).catch(() => new Set<string>()),
  ]);
  const assignments = groupByAgent(rows).filter((a) => inHive.has(a.agentId));
  // WI-1495: stamp LOCAL rows with this machine's label so the roster can group
  // by machine (federated rows already carry their announced one). Same
  // fingerprint source as adv-roster.ts, so the two rosters agree on the name.
  return foldHiveRoster(
    presence,
    assignments,
    tier1,
    Date.now(),
    wakeability,
    recordedLive,
    machineFingerprint(),
  );
}

/** Convenience: the lean dossier snapshot in one call (listHiveRoster +
 *  toRosterSnapshot) — the per-spawn roster-snapshot input for the directed-wake
 *  P-021 hydration seam. Hive-scoped, so bounded; ~6 small reads per call. */
export async function listHiveRosterSnapshot(opts: ListHiveRosterOpts): Promise<RosterSnapshotLine[]> {
  return toRosterSnapshot(await listHiveRoster(opts));
}
