/**
 * scan.ts — the Fleet EKG's PG + alarm glue
 * (self-learning-frontier-2026-06-12 P-030 / FB-10).
 *
 * One tick = embed → compare → attribute → persist → alarm:
 *
 *   1. EMBED: read recent completed tool calls from
 *      harness_shared.agent_activity (kind='tool', phase='post' — the per-CLI
 *      worker stream; see features.ts for why NOT tool_invocations), group by
 *      (owner_id, session_id), embed each ≥MIN_SESSION_EVENTS session
 *      (features.ts) and UPSERT into fleet_ekg_sessions — idempotent; an
 *      active session's vector converges as it ends.
 *   2. COMPARE: window cohort (ended in the trailing windowHours) vs baseline
 *      cohort (ended in the preceding baselineDays), via detectDrift
 *      (drift.ts: PSI + JSD over the named feature registry).
 *   3. ATTRIBUTE: candidate causes from the behavior-change ledger
 *      (readRecentChanges, D-003) inside the lookback; zero candidates =
 *      UNATTRIBUTABLE.
 *   4. PERSIST: one fleet_ekg_shifts row per (feature, window day), upserted
 *      — re-scans update in place, never duplicate.
 *   5. ALARM: unattributable MAJOR shifts notify the attention rail ONCE
 *      (notified_at stamps the send; notifyAttention is fail-safe).
 *
 * Workspace scoping mirrors the negative-space miner: the given workspace
 * PLUS the box-global '*' bucket (unscoped SU sessions — the bulk of real
 * traffic). Deps are injectable so the tick is unit-testable without PG; the
 * flag + governor gates live in the routine action (fleet-ekg-action.ts).
 */

import type { Sql } from 'postgres';
import { embedSession, MIN_SESSION_EVENTS, type SessionEvents, type SessionVector } from './features';
import {
  attributeFindings,
  detectDrift,
  ATTRIBUTION_LOOKBACK_MS,
  type AttributedFinding,
  type DriftOptions,
  type DriftResult,
} from './drift';
import type { BehaviorChangeRow } from '../change-ledger/change-ledger';

export interface FleetEkgTickOptions extends DriftOptions {
  /** How far back to (re)embed sessions, days. Default 3. */
  embedDays?: number;
  /** Shift-window size, hours. Default 24. */
  windowHours?: number;
  /** Baseline size preceding the window, days. Default 7. */
  baselineDays?: number;
  /** Per-session event floor. Default MIN_SESSION_EVENTS. */
  minEvents?: number;
  /** Attribution lookback before window end, ms. Default ATTRIBUTION_LOOKBACK_MS. */
  attributionLookbackMs?: number;
  /** Suppress alarms (backtest / mine-only mode). Default false. */
  dryRun?: boolean;
}

/** Tune knobs from a routine's payload_template (all optional, ignore junk). */
export function ekgOptionsFromPayload(payload: unknown): FleetEkgTickOptions {
  if (payload === null || typeof payload !== 'object') return {};
  const p = payload as Record<string, unknown>;
  const num = (k: string): number | undefined => {
    const v = p[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return {
    embedDays: num('embedDays'),
    windowHours: num('windowHours'),
    baselineDays: num('baselineDays'),
    minEvents: num('minEvents'),
    minWindowSessions: num('minWindowSessions'),
    minBaselineSessions: num('minBaselineSessions'),
    psiModerate: num('psiModerate'),
    psiMajor: num('psiMajor'),
    jsdModerate: num('jsdModerate'),
    jsdMajor: num('jsdMajor'),
  };
}

/** Injectable seams (tests run the tick without PG). */
export interface FleetEkgTickDeps {
  readSessions: (workspaceId: string, sinceMs: number) => Promise<SessionEvents[]>;
  persistVectors: (workspaceId: string, vectors: SessionVector[]) => Promise<void>;
  readCohort: (workspaceId: string, fromMs: number, toMs: number) => Promise<SessionVector[]>;
  readLedger: (workspaceId: string, sinceMs: number) => Promise<BehaviorChangeRow[]>;
  persistShifts: (
    workspaceId: string,
    windowStartMs: number,
    windowEndMs: number,
    result: DriftResult,
    findings: AttributedFinding[],
  ) => Promise<PersistedShift[]>;
  alarm: (input: { title: string; body: string; workspaceId: string }) => Promise<void>;
  markNotified: (workspaceId: string, shiftIds: number[]) => Promise<void>;
  nowMs: () => number;
  log?: (message: string) => void;
}

export interface PersistedShift {
  id: number;
  feature: string;
  severity: string;
  attributed: boolean;
  /** Already alarmed by an earlier tick for this (feature, window day). */
  alreadyNotified: boolean;
}

export interface FleetEkgTickResult {
  embedded: number;
  skippedSmall: number;
  status: DriftResult['status'];
  windowSessions: number;
  baselineSessions: number;
  findings: number;
  attributed: number;
  unattributable: number;
  alarmed: number;
}

/** Completed tool calls grouped into sessions, over the embed window. */
export async function readSessionEvents(sql: Sql, workspaceId: string, sinceMs: number): Promise<SessionEvents[]> {
  const scopes = [...new Set([workspaceId, '*'])];
  const rows = await sql<
    {
      owner_id: string;
      session_id: string;
      agent: string | null;
      harness_slug: string | null;
      tool_name: string;
      status: string | null;
      created_at: string | Date;
    }[]
  >`
    SELECT owner_id, session_id, agent, harness_slug, tool_name, status, created_at
      FROM harness_shared.agent_activity
     WHERE kind = 'tool'
       AND phase = 'post'
       AND workspace_id = ANY(${scopes}::text[])
       AND session_id IS NOT NULL
       AND owner_id IS NOT NULL
       AND created_at >= ${new Date(sinceMs).toISOString()}
     ORDER BY owner_id, session_id, created_at`;
  const sessions = new Map<string, SessionEvents>();
  for (const r of rows) {
    const key = `${r.owner_id}\x00${r.session_id}`;
    let s = sessions.get(key);
    if (!s) {
      s = { ownerId: r.owner_id, sessionId: r.session_id, agent: r.agent, harnessSlug: r.harness_slug, events: [] };
      sessions.set(key, s);
    }
    s.events.push({
      toolName: r.tool_name,
      status: r.status,
      atMs: r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(String(r.created_at)),
    });
  }
  return [...sessions.values()];
}

/**
 * Upsert session vectors (recompute-idempotent).
 *
 * jsonb params are written as ${JSON.stringify(x)}::text::jsonb — the ONLY
 * form that round-trips an object on BOTH the live getOrgPg client (custom
 * `types` map: object/sql.json params throw) and a default postgres() client
 * (a pre-stringified param described as jsonb double-encodes). See
 * agent-insights/jsonb-params-text-cast-across-pg-clients.
 */
export async function persistSessionVectors(sql: Sql, workspaceId: string, vectors: SessionVector[]): Promise<void> {
  for (const v of vectors) {
    await sql`
      INSERT INTO harness_shared.fleet_ekg_sessions
        (workspace_id, owner_id, session_id, agent, harness_slug, started_at, ended_at,
         event_count, features, tool_mix, bigrams, computed_at)
      VALUES (${workspaceId}, ${v.ownerId}, ${v.sessionId}, ${v.agent}, ${v.harnessSlug},
              ${new Date(v.startedAtMs).toISOString()}, ${new Date(v.endedAtMs).toISOString()},
              ${v.eventCount},
              ${JSON.stringify(v.features)}::text::jsonb, ${JSON.stringify(v.toolMix)}::text::jsonb,
              ${JSON.stringify(v.bigrams)}::text::jsonb, now())
      ON CONFLICT (workspace_id, owner_id, session_id) DO UPDATE SET
        agent = EXCLUDED.agent,
        harness_slug = EXCLUDED.harness_slug,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        event_count = EXCLUDED.event_count,
        features = EXCLUDED.features,
        tool_mix = EXCLUDED.tool_mix,
        bigrams = EXCLUDED.bigrams,
        computed_at = now()`;
  }
}

/** Stored vectors whose session ENDED inside [fromMs, toMs). */
export async function readCohortVectors(sql: Sql, workspaceId: string, fromMs: number, toMs: number): Promise<SessionVector[]> {
  const rows = await sql<
    {
      owner_id: string;
      session_id: string;
      agent: string | null;
      harness_slug: string | null;
      started_at: string | Date;
      ended_at: string | Date;
      event_count: number;
      features: Record<string, number>;
      tool_mix: Record<string, number>;
      bigrams: Record<string, number>;
    }[]
  >`
    SELECT owner_id, session_id, agent, harness_slug, started_at, ended_at,
           event_count, features, tool_mix, bigrams
      FROM harness_shared.fleet_ekg_sessions
     WHERE workspace_id = ${workspaceId}
       AND ended_at >= ${new Date(fromMs).toISOString()}
       AND ended_at < ${new Date(toMs).toISOString()}`;
  const ms = (v: string | Date): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
  return rows.map((r) => ({
    ownerId: r.owner_id,
    sessionId: r.session_id,
    agent: r.agent,
    harnessSlug: r.harness_slug,
    startedAtMs: ms(r.started_at),
    endedAtMs: ms(r.ended_at),
    eventCount: r.event_count,
    features: r.features ?? {},
    toolMix: r.tool_mix ?? {},
    bigrams: r.bigrams ?? {},
  }));
}

/** Upsert one shift row per finding for the window's day; returns ids + prior-notify state. */
export async function persistShiftRows(
  sql: Sql,
  workspaceId: string,
  windowStartMs: number,
  windowEndMs: number,
  result: DriftResult,
  findings: AttributedFinding[],
): Promise<PersistedShift[]> {
  const windowDate = new Date(windowEndMs).toISOString().slice(0, 10);
  const out: PersistedShift[] = [];
  for (const f of findings) {
    const rows = await sql<{ id: number; notified_at: string | Date | null }[]>`
      INSERT INTO harness_shared.fleet_ekg_shifts
        (workspace_id, window_date, feature, kind, score, severity, direction,
         window_start, window_end, baseline_sessions, window_sessions,
         baseline_summary, window_summary, attributed, ledger_candidates, updated_at)
      VALUES (${workspaceId}, ${windowDate}, ${f.feature}, ${f.kind}, ${f.score}, ${f.severity},
              ${f.direction}, ${new Date(windowStartMs).toISOString()}, ${new Date(windowEndMs).toISOString()},
              ${result.baselineSessions}, ${result.windowSessions},
              ${f.baselineSummary}, ${f.windowSummary}, ${f.attributed},
              ${JSON.stringify(f.ledgerCandidates)}::text::jsonb, now())
      ON CONFLICT (workspace_id, feature, window_date) DO UPDATE SET
        kind = EXCLUDED.kind,
        score = EXCLUDED.score,
        severity = EXCLUDED.severity,
        direction = EXCLUDED.direction,
        window_start = EXCLUDED.window_start,
        window_end = EXCLUDED.window_end,
        baseline_sessions = EXCLUDED.baseline_sessions,
        window_sessions = EXCLUDED.window_sessions,
        baseline_summary = EXCLUDED.baseline_summary,
        window_summary = EXCLUDED.window_summary,
        attributed = EXCLUDED.attributed,
        ledger_candidates = EXCLUDED.ledger_candidates,
        updated_at = now()
      RETURNING id, notified_at`;
    const row = rows[0];
    if (row) {
      out.push({
        id: Number(row.id),
        feature: f.feature,
        severity: f.severity,
        attributed: f.attributed,
        alreadyNotified: row.notified_at != null,
      });
    }
  }
  return out;
}

/** Stamp alarm delivery so a re-scan never re-alarms the same shift. */
export async function markShiftsNotified(sql: Sql, workspaceId: string, shiftIds: number[]): Promise<void> {
  if (shiftIds.length === 0) return;
  await sql`
    UPDATE harness_shared.fleet_ekg_shifts
       SET notified_at = now(), updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND id = ANY(${shiftIds}::bigint[])`;
}

/** The live PG-backed deps (the routine action's default wiring). */
export function defaultFleetEkgDeps(sql: Sql): FleetEkgTickDeps {
  return {
    readSessions: (ws, sinceMs) => readSessionEvents(sql, ws, sinceMs),
    persistVectors: (ws, vectors) => persistSessionVectors(sql, ws, vectors),
    readCohort: (ws, fromMs, toMs) => readCohortVectors(sql, ws, fromMs, toMs),
    readLedger: async (ws, sinceMs) => {
      const { readRecentChanges } = await import('../change-ledger/change-ledger');
      return readRecentChanges(ws, { sinceMs, limit: 200 });
    },
    persistShifts: (ws, fromMs, toMs, result, findings) => persistShiftRows(sql, ws, fromMs, toMs, result, findings),
    alarm: async ({ title, body, workspaceId }) => {
      const { notifyAttention } = await import('../attention-notify');
      await notifyAttention({ kind: 'intervention', title, body, importance: 'high', workspaceId });
    },
    markNotified: (ws, ids) => markShiftsNotified(sql, ws, ids),
    nowMs: () => Date.now(),
    log: (m) => console.log(m),
  };
}

function alarmBody(findings: AttributedFinding[], result: DriftResult): string {
  const lines = findings.slice(0, 4).map((f) => {
    const move =
      f.kind === 'numeric' && f.baselineSummary != null && f.windowSummary != null
        ? ` (${f.baselineSummary.toPrecision(3)} → ${f.windowSummary.toPrecision(3)})`
        : '';
    return `${f.feature} ${f.severity} score=${f.score.toFixed(3)}${move}`;
  });
  return (
    `Fleet behavior shifted with NO behavior-change-ledger entry in the lookback — ` +
    `unattributable per D-003. ${result.windowSessions} window vs ${result.baselineSessions} baseline sessions: ` +
    lines.join('; ')
  );
}

/** One EKG tick: embed → compare → attribute → persist → alarm. */
export async function runFleetEkgTick(
  workspaceId: string,
  deps: FleetEkgTickDeps,
  opts: FleetEkgTickOptions = {},
): Promise<FleetEkgTickResult> {
  const log = deps.log ?? (() => {});
  const embedDays = opts.embedDays ?? 3;
  const windowHours = opts.windowHours ?? 24;
  const baselineDays = opts.baselineDays ?? 7;
  const minEvents = opts.minEvents ?? MIN_SESSION_EVENTS;
  const now = deps.nowMs();

  // 1. Embed.
  const sessions = await deps.readSessions(workspaceId, now - embedDays * 86_400_000);
  const vectors: SessionVector[] = [];
  let skippedSmall = 0;
  for (const s of sessions) {
    const v = embedSession(s, minEvents);
    if (v) vectors.push(v);
    else skippedSmall += 1;
  }
  await deps.persistVectors(workspaceId, vectors);

  // 2. Compare window vs baseline cohorts (from the accumulated store, so
  // history embedded by earlier ticks/backfills counts toward the baseline).
  const windowStart = now - windowHours * 3600_000;
  const baselineStart = windowStart - baselineDays * 86_400_000;
  const [windowCohort, baselineCohort] = await Promise.all([
    deps.readCohort(workspaceId, windowStart, now),
    deps.readCohort(workspaceId, baselineStart, windowStart),
  ]);
  const result = detectDrift(baselineCohort, windowCohort, opts);

  const base: FleetEkgTickResult = {
    embedded: vectors.length,
    skippedSmall,
    status: result.status,
    windowSessions: result.windowSessions,
    baselineSessions: result.baselineSessions,
    findings: 0,
    attributed: 0,
    unattributable: 0,
    alarmed: 0,
  };
  if (result.status !== 'ok' || result.findings.length === 0) {
    log(`[fleet-ekg] embedded ${vectors.length} (skipped ${skippedSmall} small), ${result.status}, no shifts`);
    return base;
  }

  // 3. Attribute against the change ledger (D-003).
  const lookbackMs = opts.attributionLookbackMs ?? ATTRIBUTION_LOOKBACK_MS;
  const ledger = await deps.readLedger(workspaceId, now - lookbackMs);
  const findings = attributeFindings(result.findings, ledger, now, lookbackMs);
  base.findings = findings.length;
  base.attributed = findings.filter((f) => f.attributed).length;
  base.unattributable = findings.length - base.attributed;

  // 4. Persist (upsert per feature + window day).
  const persisted = await deps.persistShifts(workspaceId, windowStart, now, result, findings);

  // 5. Alarm unattributable MAJOR shifts, once per (feature, window day).
  if (!opts.dryRun) {
    const toAlarm = persisted.filter((p) => !p.attributed && p.severity === 'major' && !p.alreadyNotified);
    if (toAlarm.length > 0) {
      const alarmFindings = findings.filter((f) => toAlarm.some((p) => p.feature === f.feature));
      try {
        await deps.alarm({
          workspaceId,
          title: `Fleet EKG: ${toAlarm.length} unattributable behavior shift${toAlarm.length === 1 ? '' : 's'}`,
          body: alarmBody(alarmFindings, result),
        });
        await deps.markNotified(workspaceId, toAlarm.map((p) => p.id));
        base.alarmed = toAlarm.length;
      } catch (e) {
        // Alarm delivery is best-effort; the shift rows persist regardless.
        log(`[fleet-ekg] alarm FAILED (shift rows persisted): ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  log(
    `[fleet-ekg] embedded ${vectors.length} (skipped ${skippedSmall} small); ` +
      `${result.windowSessions}w/${result.baselineSessions}b sessions → ${findings.length} shift(s), ` +
      `${base.attributed} attributed, ${base.unattributable} unattributable, ${base.alarmed} alarmed`,
  );

  // Nudge the Learning tab's EKG panel (learning.ekg is not table-backed for
  // PG-trigger invalidation). Lazy + fire-and-forget.
  import('../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.ekg'))
    .catch(() => {});

  return base;
}
