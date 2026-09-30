/**
 * types.ts — the PresenceStore seam: live agent presence (L1).
 *
 * Kept SEPARATE from CoordEventLog by design (D-009): presence is a
 * mutable single-row-per-owner table (upsert / heartbeat / delete /
 * roster-join), NOT an append-only log. It shares the coord identity
 * vocabulary, not a storage interface.
 *
 * The production impl is PG (`PgPresenceStore`, over an injected PgHandle);
 * `InMemoryPresenceStore` is the test double + swappability proof.
 */

/** A session whose heartbeat is older than this is treated as dead. */
export const PRESENCE_STALE_MS = 10 * 60 * 1000;

/**
 * The identity fields a presence write needs. Structurally satisfied by
 * the host's `AgentIdentity` (which stays host-side). `userId` is
 * roster-derived in PG (ignored on write there) but carried by the
 * in-memory double.
 */
export interface PresenceIdentity {
  ownerId: string;
  ownerLabel: string;
  source: string;
  workspaceId: string | null;
  userId?: string | null;
}

/** Mutable work-state an agent declares about itself. */
export interface PresenceInput {
  intent?: string;
  currentPlanSlug?: string | null;
  currentFiles?: string[];
  /** Omit to preserve the durable ambient-retrieval fence; [] clears it. */
  ambientExcludedRefs?: string[];
  host?: string;
  pid?: number | null;
  /** The terminal device path this session's launcher OWNS (e.g. `/dev/pts/21`),
   *  self-reported by the psu supervisor beat — the same process that resolves
   *  `PAPERCUSP_TTY` at launch (resolveOwnedTtyPath in psu-launcher.mjs). null/absent
   *  for a headless launch (no terminal owned). Like `host`/`pid`, only the beat's
   *  own call site can honestly report this (WI-3898 P1 sibling) — every other
   *  caller must leave it unset rather than guess. EI-19948333346987654: this is
   *  what makes "which terminal does session X own" a single presence read
   *  instead of a /proc ancestry walk, and sidesteps the Wayland wmctrl/xdotool
   *  blindness entirely (an OSC write to the device path needs no window-manager
   *  query at all). */
  tty?: string | null;
  /** Durable role (human/su/bee/principal/…), resolved host-side. Preserved on
   *  a later write that omits it (so it's a populate-once-then-keep field). */
  agentRole?: string | null;
  /** The agent's home Hive slug, resolved host-side (null = standalone). Also
   *  preserved across writes that omit it. */
  potSlug?: string | null;
  /** This machine's DG-3 shard-scheduling capability tags (platform/deps/DB —
   *  e.g. 'node'/'docker'/'pg'; see pot-git/gate/scheduling.ts's
   *  shardRequiredTags vocabulary). Resolved host-side (detectMachineCapabilityTags),
   *  populate-once-then-keep like agentRole/potSlug: an omitted/empty value on a
   *  later write PRESERVES whatever was already recorded, never clobbers to []. */
  capabilityTags?: string[];
}

export interface PresenceRecord {
  ownerId: string;
  ownerLabel: string;
  workspaceId: string;
  source: string;
  intent: string;
  currentPlanSlug: string | null;
  currentFiles: string[];
  host: string;
  pid: number | null;
  /** The terminal device path this session owns (see PresenceInput.tty). null
   *  when never reported (headless, or pre-tty-column rows). */
  tty: string | null;
  startedAt: string;
  heartbeatAt: string;
  /** Last GENUINE-activity timestamp (tool dispatch / declare-intent / inbox) —
   *  distinct from heartbeatAt, which the 60s keepalive bumps (D-003). null
   *  until the row's first activity write (pre-existing rows). */
  lastActiveAt: string | null;
  /** When the CURRENT `intent` STRING was declared — distinct from lastActiveAt,
   *  which also bumps on activity that never touches the intent text (tool
   *  dispatch via touchActivity, an inbox-read heartbeat). Only a `write()` whose
   *  intent value actually CHANGES advances this; a re-write with the same text,
   *  touchHeartbeat/touchActivity/heartbeat never do. This is what lets a reader
   *  tell "genuinely busy, stale intent text" (fresh activity, old
   *  intentDeclaredAt — EI-8988's drift case) apart from "actually idle" (both
   *  old). null until the row's first write. */
  intentDeclaredAt: string | null;
  /** Durable agent role (human/su/bee/principal/…). null when unresolved. */
  agentRole: string | null;
  /** The agent's home Hive slug (null = standalone / no hive). */
  potSlug: string | null;
  /** This machine's DG-3 capability tags (platform/deps/DB), populate-once-then-kept.
   *  [] when never resolved (pre-existing rows, or a store that doesn't carry it). */
  capabilityTags: string[];
  /** Per-session SOFT compaction limit in tokens (agent-managed-compaction).
   *  null/undefined ⇒ use the per-model default. Set via config:set-compaction-limit.
   *  Optional: only the PG store (live presence) carries it; roster/snapshot
   *  transforms may omit it. */
  compactionLimit?: number | null;
  /** True when compactionLimit was deliberately set at runtime, rather than
   *  derived/seeding by the watchdog. Optional for roster/snapshot projections
   *  that do not carry the live provenance column. */
  compactionLimitExplicit?: boolean;
  /** Cached context-size estimate in tokens + when it was taken. The
   *  compaction-compliance watchdog writes these on a cadence (off the hot path);
   *  the coord:inbox usage signal reads them vs compactionLimit. */
  contextTokens?: number | null;
  contextEstimatedAt?: string | null;
  /** heartbeat older than PRESENCE_STALE_MS — the session is dead. */
  stale: boolean;
  /** Durable roster field — null for a non-roster (superuser) agent. */
  userId: string | null;
  /** True iff a roster row exists and is revoked. */
  revoked: boolean;
}

/** Optional read filters shared by the swappable presence-store implementations. */
export interface PresenceListOptions {
  workspaceId?: string | null;
  potSlug?: string | null;
  /** Bounded targeted selectors; exact ids, labels, and substring matches are supported. */
  ownerIds?: readonly string[];
}

export interface PresenceStore {
  /** Upsert the caller's presence row to exactly this state; bumps heartbeat
   *  AND last_active_at (a write is genuine activity). Returns the intent that
   *  existed immediately before this write, or null when no row existed. This
   *  lets callers compare intent pivots without a separate pre-write read. */
  write(identity: PresenceIdentity, input?: PresenceInput): Promise<string | null>;
  /** Bump heartbeat ONLY (no-op if the row does not exist) — the keepalive
   *  path. last_active_at is deliberately NOT touched (D-003): the 60s
   *  supervisor beat means "process alive", not "active".
   *
   *  `liveness` (WI-3898 P1): when the CALLER genuinely runs as the agent's
   *  own OS process (e.g. the psu launcher's supervisor beat — the process
   *  whose death IS the session's death), it may report its own pid/host
   *  here so a later same-machine reader can verify liveness via a local
   *  `kill(pid, 0)` probe. Omitted fields are left UNCHANGED (never
   *  clobbered with null) — only pass what you can genuinely vouch for. */
  touchHeartbeat(
    ownerId: string,
    liveness?: { pid?: number | null; host?: string | null; tty?: string | null },
  ): Promise<void>;
  /** Bump last_active_at AND heartbeat (no-op if the row does not exist) — the
   *  ACTIVITY path (e.g. tool dispatch). The genuine-activity counterpart of
   *  touchHeartbeat (D-003). */
  touchActivity(ownerId: string): Promise<void>;
  /** Ensure a row exists + bump heartbeat WITHOUT clobbering a declared
   *  intent/files/plan (unlike write). The read-driven liveness signal —
   *  every coord:inbox read is evidence the agent is alive, so it keeps a
   *  fresh presence row for every active agent even before it declares an
   *  intent. */
  heartbeat(identity: PresenceIdentity): Promise<void>;
  /** Remove the caller's presence row. */
  clear(ownerId: string): Promise<void>;
  /** List presence in deterministic ownerId order (presence-v2 P-005 / D-006 —
   *  cache- and diff-stable), optionally scoped to a workspace and/or a Hive
   *  (potSlug — the P-004 hive-scoped read; null/omitted = no hive filter).
   *  `ownerIds` is a bounded targeted selector list. Implementations may push
   *  it into their storage query; selectors preserve the public owner lookup's
   *  exact, label, and substring matching semantics. */
  list(opts?: PresenceListOptions): Promise<PresenceRecord[]>;
  /** Read one presence record by owner id, or null. */
  get(ownerId: string): Promise<PresenceRecord | null>;
  /** Delete presence rows whose heartbeat is older than maxAgeMs — true dead
   *  sessions, well past PRESENCE_STALE_MS. Keeps the table from accumulating
   *  hundreds of long-ended sessions (the coord:presence overflow source).
   *  Returns the number of rows removed. */
  sweepStale(maxAgeMs: number): Promise<number>;
}
