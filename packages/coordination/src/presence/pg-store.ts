/**
 * pg-store.ts — PgPresenceStore: the production presence store over an
 * injected postgres-js handle.
 *
 * The SQL is kept VERBATIM from the operator's original presence.ts
 * (schema-qualified `harness_shared.coord_presence` + the
 * `power_user_sessions` roster LEFT JOIN) — zero behavior change, and no
 * schema-qualified-identifier interpolation (the hazard the rate-limit
 * extraction flagged). The two host couplings are injected: the org PG
 * handle (`getSql`) and the table bootstrap (`ensureSchema`). A
 * different schema is a sibling store satisfying `PresenceStore`, not a
 * config knob here.
 */

import type { Sql } from 'postgres';
import {
  PRESENCE_STALE_MS,
  type PresenceIdentity,
  type PresenceInput,
  type PresenceStore,
  type PresenceRecord,
  type PresenceListOptions,
} from '@papercusp/pubsub-substrate/presence';

export interface PgPresenceStoreOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => Sql;
  /** Ensure harness_shared.coord_presence exists before first use. */
  ensureSchema: () => Promise<void>;
}

interface CoordPresenceDbRow {
  owner_id: string;
  owner_label: string;
  workspace_id: string;
  source: string;
  intent: string;
  current_plan_slug: string | null;
  current_files: unknown;
  host: string;
  pid: number | null;
  tty: string | null;
  started_at: string;
  heartbeat_at: string;
  last_active_at: string | null;
  intent_declared_at: string | null;
  agent_role: string | null;
  pot_slug: string | null;
  capability_tags: unknown;
  compaction_limit: number | null;
  compaction_limit_explicit: boolean | null;
  context_tokens: number | null;
  context_estimated_at: string | null;
  user_id: string | null;
  revoked_at: string | null;
}

/**
 * Normalize a `current_files` jsonb column to `string[]`. postgres-js
 * returns jsonb as a PARSED array under the binary protocol but as a raw
 * JSON STRING under the text protocol (`prepare: false`, which the org
 * handle uses for cheap cold reconnects) — so we must handle both, or
 * currentFiles silently drops to `[]`. (The pre-extraction presence.ts
 * only handled the array case; the dual-impl conformance suite caught it.)
 */
function parseFiles(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRecord(r: CoordPresenceDbRow, now: number): PresenceRecord {
  const files = parseFiles(r.current_files);
  // Same dual text/binary-protocol shape as current_files (see parseFiles) —
  // capability_tags is also a jsonb array column.
  const capabilityTags = parseFiles(r.capability_tags);
  return {
    ownerId: r.owner_id,
    ownerLabel: r.owner_label,
    workspaceId: r.workspace_id,
    source: r.source,
    intent: r.intent,
    currentPlanSlug: r.current_plan_slug,
    currentFiles: files,
    host: r.host,
    pid: r.pid,
    tty: r.tty,
    startedAt: r.started_at,
    heartbeatAt: r.heartbeat_at,
    lastActiveAt: r.last_active_at,
    intentDeclaredAt: r.intent_declared_at,
    agentRole: r.agent_role,
    potSlug: r.pot_slug,
    capabilityTags,
    compactionLimit: r.compaction_limit,
    compactionLimitExplicit: r.compaction_limit_explicit ?? false,
    contextTokens: r.context_tokens,
    contextEstimatedAt: r.context_estimated_at,
    stale: now - new Date(r.heartbeat_at).getTime() > PRESENCE_STALE_MS,
    userId: r.user_id,
    revoked: r.revoked_at != null,
  };
}

export class PgPresenceStore implements PresenceStore {
  constructor(private readonly opts: PgPresenceStoreOptions) {}

  async write(identity: PresenceIdentity, input: PresenceInput = {}): Promise<string | null> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // A declared write IS genuine activity, so bump last_active_at + heartbeat.
    // agent_role / pot_slug are populate-once-then-keep: COALESCE(EXCLUDED, existing)
    // so a write that omits them (passes null) never WIPES a previously-resolved
    // value (D-004).
    //
    // EI-18776963284535761: `currentFiles` is OMITTED-MEANS-UNTOUCHED, distinct from
    // BOTH neighbours above — an explicit `[]` still CLEARS (matching declare-intent's
    // `items` lane semantics, which document exactly this), while an omitted field
    // preserves. The old `?? []` made omission a CLEAR, and since `coord:orient` — the
    // mandated every-wake bootstrap — re-declares intent WITHOUT current_files, every
    // wake silently wiped it: measured 113 live presence rows, 0 populated. Three
    // collision-avoidance consumers (locks enrich-busy `holder_focused`, place_batch's
    // touch-set exclusion, git-sync derived attribution) read that column, so all three
    // were reading a permanently-dead signal. NULL is the "untouched" sentinel on the
    // wire because the column is NOT NULL, so it can never be a legitimate value.
    const filesJson = input.currentFiles === undefined ? null : JSON.stringify(input.currentFiles);
    // EI-23110847647700079: return the PREVIOUS intent from this same SQL
    // statement. coord:declare-intent used to issue a separate get() before
    // this upsert solely for advisory pivot detection. Under shared-pool delay
    // that extra read exceeded its 1500ms wrapper, emitted a process-wide
    // warning, and red-pinned otherwise-correct installed-PUI acceptance. A
    // materialized pre-image CTE preserves the old value under the statement's
    // single snapshot; the data-modifying CTE still performs exactly one
    // essential upsert. Existing callers may ignore the returned value.
    const rows = await sql<{ previous_intent: string | null }[]>`
      WITH previous AS MATERIALIZED (
        SELECT intent
          FROM harness_shared.coord_presence
         WHERE owner_id = ${identity.ownerId}
      ), upsert AS (
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, intent,
         current_plan_slug, current_files, host, pid, tty,
         agent_role, pot_slug, capability_tags, heartbeat_at, last_active_at, intent_declared_at)
      VALUES (
        ${identity.ownerId}, ${identity.ownerLabel},
        ${identity.workspaceId ?? 'default'}, ${identity.source},
        ${input.intent ?? ''}, ${input.currentPlanSlug ?? null},
        COALESCE(${filesJson}::text::jsonb, '[]'::jsonb),
        ${input.host ?? ''}, ${input.pid ?? null}, ${input.tty ?? null},
        ${input.agentRole ?? null}, ${input.potSlug ?? null},
        ${JSON.stringify(input.capabilityTags ?? [])}::text::jsonb,
        now(), now(), now()
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        owner_label       = EXCLUDED.owner_label,
        workspace_id      = EXCLUDED.workspace_id,
        source            = EXCLUDED.source,
        intent            = EXCLUDED.intent,
        current_plan_slug = EXCLUDED.current_plan_slug,
        -- omitted ⇒ untouched, explicit [] ⇒ clear (EI-18776963284535761). Reads the
        -- parameter directly rather than EXCLUDED, because the VALUES row already
        -- COALESCEd the omitted case to '[]' to satisfy the NOT NULL column.
        current_files     = COALESCE(${filesJson}::text::jsonb, harness_shared.coord_presence.current_files),
        host              = EXCLUDED.host,
        pid               = EXCLUDED.pid,
        -- Same "always set from this write's resolved value" rule as host/pid
        -- above — every current write() caller passes tty as undefined (only the
        -- supervisor beat's touchHeartbeat call genuinely knows it), so this
        -- resets to NULL here and the next beat (<=60s) repopulates it, exactly
        -- like host/pid's existing reset-then-repopulate cadence.
        tty               = EXCLUDED.tty,
        -- EI-19418749207847685: a carry-respawn REUSES the ownerId but starts a NEW
        -- process, so any cached context estimate describes a session that no longer
        -- exists. AGE alone cannot catch this — the estimate can be only minutes old
        -- (well inside CONTEXT_ESTIMATE_STALE_MS) and still be the DEAD session's, so
        -- deriveContextPressure asserts a bucket from it with full confidence.
        -- Observed live: a session respawned at 4% context read 'critical' for ~12
        -- minutes, which is the cue the playbook says to self-compact on — i.e. the
        -- stale value drives a fresh context to discard itself, then respawn and read
        -- 'critical' again. Invalidate on the identity change itself: a CHANGED pid
        -- means the estimate is not about this process. NULL is the honest "unknown"
        -- deriveContextPressure already contracts for (never coerced to 'ok'), and the
        -- watchdog's next sweep refills it with this session's real usage.
        -- Guarded on EXCLUDED.pid IS NOT NULL so a caller that doesn't know its own
        -- pid never invalidates a valid estimate (same preserve-on-omission rule as
        -- touchHeartbeat's pid/host handling).
        context_tokens    = CASE
          WHEN EXCLUDED.pid IS NOT NULL
           AND EXCLUDED.pid IS DISTINCT FROM harness_shared.coord_presence.pid
            THEN NULL
          ELSE harness_shared.coord_presence.context_tokens
        END,
        context_estimated_at = CASE
          WHEN EXCLUDED.pid IS NOT NULL
           AND EXCLUDED.pid IS DISTINCT FROM harness_shared.coord_presence.pid
            THEN NULL
          ELSE harness_shared.coord_presence.context_estimated_at
        END,
        agent_role        = COALESCE(EXCLUDED.agent_role, harness_shared.coord_presence.agent_role),
        pot_slug          = COALESCE(EXCLUDED.pot_slug, harness_shared.coord_presence.pot_slug),
        -- populate-once-then-keep, same family as agent_role/pot_slug: an
        -- omitted/empty capabilityTags on this write (serializes to '[]')
        -- must not clobber a previously-detected tag set.
        capability_tags   = COALESCE(
                               NULLIF(EXCLUDED.capability_tags, '[]'::jsonb),
                               harness_shared.coord_presence.capability_tags
                             ),
        heartbeat_at      = now(),
        last_active_at    = now(),
        -- EI-8988: only advance when the intent TEXT actually changes — a
        -- re-declare of the same string (or a row from before this column
        -- existed) must not look like a fresh declaration.
        intent_declared_at = CASE
          WHEN EXCLUDED.intent IS DISTINCT FROM harness_shared.coord_presence.intent
            THEN now()
          ELSE COALESCE(harness_shared.coord_presence.intent_declared_at, now())
        END
      RETURNING 1
      )
      SELECT previous.intent AS previous_intent
        FROM upsert
        LEFT JOIN previous ON TRUE
    `;
    return rows[0]?.previous_intent ?? null;
  }

  async touchHeartbeat(
    ownerId: string,
    liveness?: { pid?: number | null; host?: string | null; tty?: string | null },
  ): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // KEEPALIVE only — never bumps last_active_at (D-003): the 60s supervisor
    // beat keeps the process "alive" without implying activity.
    //
    // WI-3898 P1 (+ EI-19948333346987654 for tty): pid/host/tty are set ONLY
    // when the caller actually reported them this beat — an omitted field is
    // left UNTOUCHED, never clobbered to null/''. (Unlike write()'s ON
    // CONFLICT, which unconditionally sets EXCLUDED.host/EXCLUDED.pid/
    // EXCLUDED.tty — that's fine there because write() always carries a
    // caller-resolved value; here a bare keepalive from a caller that
    // doesn't know its own pid/tty must not erase a value a prior liveness
    // beat recorded.)
    const pid = liveness?.pid;
    const host = liveness?.host;
    const tty = liveness?.tty;
    // EI-19418749207847685 — see write()'s ON CONFLICT for the full rationale. A
    // CHANGED pid means the cached context estimate belongs to a process that no
    // longer exists (a carry-respawn reuses the ownerId), so clear it rather than
    // let deriveContextPressure assert a DEAD session's bucket with full confidence
    // — its age-based staleness guard cannot see this, because the estimate is
    // genuinely recent, just not about this process.
    const invalidateEstimateOnPidChange = (newPid: number) => sql`
               context_tokens = CASE WHEN coord_presence.pid IS DISTINCT FROM ${newPid}
                                     THEN NULL ELSE coord_presence.context_tokens END,
               context_estimated_at = CASE WHEN coord_presence.pid IS DISTINCT FROM ${newPid}
                                     THEN NULL ELSE coord_presence.context_estimated_at END`;
    // Build the SET clause from only the fields actually reported this beat —
    // composed via postgres-js fragment nesting (already relied on above for
    // invalidateEstimateOnPidChange) rather than a hand-enumerated branch per
    // combination, which would need 8 arms once tty joins pid/host.
    const assignments = [sql`heartbeat_at = now()`];
    if (pid != null) assignments.push(sql`pid = ${pid}`);
    if (host != null) assignments.push(sql`host = ${host}`);
    if (tty != null) assignments.push(sql`tty = ${tty}`);
    if (pid != null) assignments.push(invalidateEstimateOnPidChange(pid));
    let setClause = assignments[0];
    for (let i = 1; i < assignments.length; i++) setClause = sql`${setClause}, ${assignments[i]}`;
    await sql`
      UPDATE harness_shared.coord_presence
         SET ${setClause}
       WHERE owner_id = ${ownerId}
    `;
  }

  async touchActivity(ownerId: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // ACTIVITY path (e.g. tool dispatch) — bumps last_active_at AND heartbeat
    // (D-003). No-op when no row exists, like touchHeartbeat.
    await sql`
      UPDATE harness_shared.coord_presence
         SET heartbeat_at = now(), last_active_at = now()
       WHERE owner_id = ${ownerId}
    `;
  }

  async setCompactionLimit(ownerId: string, limit: number, opts: { explicit?: boolean } = {}): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Per-session SOFT compaction target in tokens (agent-managed-compaction-2026-07-01).
    // Omitted provenance is a derived repair: update the value while preserving
    // whether a prior runtime write was explicit. A supplied boolean is an
    // authoritative seed/override provenance transition.
    //
    // EI-23739064535335014: a derived repair must ALSO leave an explicitly-chosen
    // VALUE alone, not just the provenance flag. Without the guard below, a
    // default-derived write (a model-default seed, a watchdog recompute) overwrote a
    // limit the agent had just set via config:set-compaction-limit while preserving
    // compaction_limit_explicit=true — leaving a row that LIES: it claims the agent
    // chose the number while holding the default. Observed live: an agent set 600000,
    // got ok:true, and one cadence tick later the gauge denominator and the compaction
    // watchdog were both back on 250000 with explicit still true — so the session was
    // force-compacted against a limit it had explicitly raised, losing its context for
    // no work. An explicit choice now wins until the agent changes it or an
    // authoritative write supplies provenance (either branch below still sets both).
    // `IS NOT TRUE` (not `= false`) so a NULL/never-set provenance still accepts the
    // derived write.
    if (opts.explicit === undefined) {
      await sql`
        UPDATE harness_shared.coord_presence
           SET compaction_limit = ${limit}
         WHERE owner_id = ${ownerId}
           AND compaction_limit_explicit IS NOT TRUE
      `;
    } else {
      await sql`
        UPDATE harness_shared.coord_presence
           SET compaction_limit = ${limit}, compaction_limit_explicit = ${opts.explicit}
         WHERE owner_id = ${ownerId}
      `;
    }
  }

  async setContextEstimate(ownerId: string, tokens: number): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Cached context-size estimate (agent-managed-compaction P-007/P-009) — written
    // by the compaction-compliance watchdog on a cadence, read by the inbox usage
    // signal. No-op when no row exists.
    await sql`
      UPDATE harness_shared.coord_presence
         SET context_tokens = ${tokens}, context_estimated_at = now()
       WHERE owner_id = ${ownerId}
    `;
  }

  async clearContextEstimate(ownerId: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // A carry-respawn keeps the coord ownerId while replacing the native
    // session. Until the successor transcript is positively re-anchored, NULL
    // is the only honest cached reading; the watchdog repopulates it on its next
    // pass. No-op when the owner has no presence row, like the setters above.
    await sql`
      UPDATE harness_shared.coord_presence
         SET context_tokens = NULL, context_estimated_at = NULL
       WHERE owner_id = ${ownerId}
    `;
  }

  async heartbeat(identity: PresenceIdentity): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Create-if-absent (intent/files/plan default empty) + bump heartbeat.
    // A coord:inbox read IS genuine activity (D-003), so this ALSO bumps
    // last_active_at. On conflict, refresh only identity columns + the two
    // timestamps — declared intent/current_files/current_plan_slug/host/pid
    // (and agent_role/hive_slug) are PRESERVED.
    await sql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, heartbeat_at, last_active_at)
      VALUES (
        ${identity.ownerId}, ${identity.ownerLabel},
        ${identity.workspaceId ?? 'default'}, ${identity.source}, now(), now()
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        owner_label    = EXCLUDED.owner_label,
        workspace_id   = EXCLUDED.workspace_id,
        source         = EXCLUDED.source,
        heartbeat_at   = now(),
        last_active_at = now()
    `;
  }

  async clear(ownerId: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      DELETE FROM harness_shared.coord_presence WHERE owner_id = ${ownerId}
    `;
  }

  async list(
    opts: PresenceListOptions = {},
  ): Promise<PresenceRecord[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const ws = opts.workspaceId ?? null;
    const hive = opts.potSlug ?? null;
    const ownerIds = [...new Set((opts.ownerIds ?? []).filter((ownerId) => ownerId.length > 0))];
    // Targeted coord:presence reads must be bounded at the storage boundary.
    // Keep the public selector semantics (exact id/label or substring either
    // way) while letting exact owner ids use the primary-key index.
    const ownerFilter =
      ownerIds.length === 0
        ? sql``
        : sql`
         AND (
           cp.owner_id = ANY(${ownerIds}::text[])
           OR cp.owner_label = ANY(${ownerIds}::text[])
           OR EXISTS (
             SELECT 1
               FROM unnest(${ownerIds}::text[]) AS requested(owner)
              WHERE strpos(cp.owner_id, requested.owner) > 0
                 OR strpos(requested.owner, cp.owner_id) > 0
                 OR strpos(cp.owner_label, requested.owner) > 0
                 OR strpos(requested.owner, cp.owner_label) > 0
           )
         )`;
    const rows = await sql<CoordPresenceDbRow[]>`
      SELECT cp.owner_id, cp.owner_label, cp.workspace_id, cp.source,
             cp.intent, cp.current_plan_slug, cp.current_files,
             cp.host, cp.pid, cp.tty, cp.started_at, cp.heartbeat_at,
             cp.last_active_at, cp.intent_declared_at, cp.agent_role, cp.pot_slug, cp.capability_tags, cp.compaction_limit, cp.compaction_limit_explicit,
             cp.context_tokens, cp.context_estimated_at,
             pus.user_id, pus.revoked_at
        FROM harness_shared.coord_presence cp
        LEFT JOIN harness_shared.power_user_sessions pus
          ON pus.auth_session_id = cp.owner_id
       WHERE ${ws == null ? sql`TRUE` : sql`cp.workspace_id = ${ws}`}
         AND ${hive == null ? sql`TRUE` : sql`cp.pot_slug = ${hive}`}
         ${ownerFilter}
       ORDER BY cp.owner_id
    `;
    const now = Date.now();
    return rows.map((r) => toRecord(r, now));
  }

  async get(ownerId: string, sqlOverride?: Sql): Promise<PresenceRecord | null> {
    await this.opts.ensureSchema();
    const sql = sqlOverride ?? this.opts.getSql();
    const rows = await sql<CoordPresenceDbRow[]>`
      SELECT cp.owner_id, cp.owner_label, cp.workspace_id, cp.source,
             cp.intent, cp.current_plan_slug, cp.current_files,
             cp.host, cp.pid, cp.tty, cp.started_at, cp.heartbeat_at,
             cp.last_active_at, cp.intent_declared_at, cp.agent_role, cp.pot_slug, cp.capability_tags, cp.compaction_limit, cp.compaction_limit_explicit,
             cp.context_tokens, cp.context_estimated_at,
             pus.user_id, pus.revoked_at
        FROM harness_shared.coord_presence cp
        LEFT JOIN harness_shared.power_user_sessions pus
          ON pus.auth_session_id = cp.owner_id
       WHERE cp.owner_id = ${ownerId}
    `;
    return rows.length > 0 ? toRecord(rows[0], Date.now()) : null;
  }

  async sweepStale(maxAgeMs: number): Promise<number> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const secs = Math.max(1, Math.floor(maxAgeMs / 1000));
    // Interval bound as a text param + cast — the getOrgPg client serializes
    // jsonb/object params oppositely to a fresh pool, but a plain text interval
    // is safe either way.
    const rows = await sql<{ owner_id: string }[]>`
      DELETE FROM harness_shared.coord_presence
       WHERE heartbeat_at < now() - ${`${secs} seconds`}::interval
      RETURNING owner_id
    `;
    return rows.length;
  }
}

/**
 * Bootstrap `harness_shared.coord_presence` for tests / fresh test rigs —
 * the presence analog of `ensureCoordEventLogTable`. The CREATE mirrors
 * `000-baseline.sql`; the `ADD COLUMN IF NOT EXISTS` block mirrors the
 * presence-v2 migration (`277-coord-presence-v2-columns.sql`) so a table left
 * over from before those columns existed (the `getTestPg` container is reused
 * across files AND runs) is migrated IN PLACE rather than left stale. This is
 * the one place the test schema is defined, kept beside the `PgPresenceStore`
 * SQL that consumes it — so a new column the store reads is added HERE in the
 * same change, never re-drifting across hand-rolled per-test DDL (the recurring
 * "column does not exist" failure class). Pre-alpha, test-only: no production
 * data on this path, so the in-place column add is safe.
 *
 * Production schema is owned by the migrations; this never runs there.
 */
export async function ensureCoordPresenceTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
      owner_id          text        NOT NULL PRIMARY KEY,
      owner_label       text        NOT NULL DEFAULT '',
      workspace_id      text        NOT NULL,
      source            text        NOT NULL DEFAULT '',
      intent            text        NOT NULL DEFAULT '',
      current_plan_slug text,
      current_files     jsonb       NOT NULL DEFAULT '[]'::jsonb,
      host              text        NOT NULL DEFAULT '',
      pid               integer,
      tty               text,
      started_at        timestamptz NOT NULL DEFAULT now(),
      heartbeat_at      timestamptz NOT NULL DEFAULT now(),
      last_active_at    timestamptz,
      agent_role        text,
      pot_slug          text,
      capability_tags   jsonb       NOT NULL DEFAULT '[]'::jsonb,
      compaction_limit  integer,
      compaction_limit_explicit boolean NOT NULL DEFAULT false,
      context_tokens    integer,
      context_estimated_at timestamptz
    )
  `;
  // presence-v2 (migration 277) columns the store reads/writes — added in place
  // for a pre-v2 table left in the reused test container. intent_declared_at
  // (EI-8988) added the same way.
  await sql`
    ALTER TABLE harness_shared.coord_presence
      ADD COLUMN IF NOT EXISTS last_active_at   timestamptz,
      ADD COLUMN IF NOT EXISTS tty              text,
      ADD COLUMN IF NOT EXISTS agent_role       text,
      ADD COLUMN IF NOT EXISTS pot_slug         text,
      ADD COLUMN IF NOT EXISTS capability_tags  jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS compaction_limit integer,
      ADD COLUMN IF NOT EXISTS compaction_limit_explicit boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS context_tokens   integer,
      ADD COLUMN IF NOT EXISTS context_estimated_at timestamptz,
      ADD COLUMN IF NOT EXISTS intent_declared_at timestamptz
  `;
  // Keep every COMMENT in its own statement. postgres-js and poolers may use the
  // extended-query protocol even when a caller asks for prepare:false, and that
  // protocol rejects a payload containing multiple commands. Combining these
  // three comments made the canonical bootstrap fail after the table existed,
  // which in turn caused the real-PG isolation suite to skip as "unreachable".
  await sql`
    COMMENT ON TABLE harness_shared.coord_presence IS
      'Live coordination state projection. Rows are TTL-reaped; absence means reaped or never-present, not absence at a historical time. Use append-only event/history records for historical claims.'
  `;
  await sql`
    COMMENT ON COLUMN harness_shared.coord_presence.owner_id IS
      'Current live-state key. A missing owner row is not evidence that the owner was absent at an earlier time; coord_presence is TTL-reaped.'
  `;
  await sql`
    COMMENT ON COLUMN harness_shared.coord_presence.heartbeat_at IS
      'Last observed heartbeat for the current live projection. This is not a historical presence record; rows are TTL-reaped after inactivity.'
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.power_user_sessions (
      auth_session_id TEXT        NOT NULL PRIMARY KEY,
      workspace_id    TEXT        NOT NULL,
      user_id         TEXT        NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at      TIMESTAMPTZ
    )
  `;
  // owner_activity (owner-presence-human-turn-signal-2026-07-11 P-001): a
  // backend-agnostic "the human just took a turn" signal, one row per workspace.
  // power_user_sessions.last_seen_at is bumped ONLY by the OMP/web token-refresh
  // chain, so it is blind to a human who drives an agent over the CLI/desktop pty
  // channel — the owner types, but readOwnerPresence still reads `absent`. The psu
  // pty-host stamps this row on every human keystroke (onStdin; socket-injected
  // agent wakes take a separate path, so this only ever reflects a real person at
  // the keyboard — covers claude/codex/omp uniformly). readOwnerPresence ORs this
  // in alongside last_seen_at so an owner-initiated turn counts as present.
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.owner_activity (
      workspace_id       TEXT        NOT NULL PRIMARY KEY,
      last_human_turn_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}
