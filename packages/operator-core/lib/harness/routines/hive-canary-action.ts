/**
 * hive-canary-action.ts — the daily hive-loop canary
 * (hive-loop-e2e-testing-2026-06-10 P-009, Tier 3).
 *
 * The live complement to the hermetic tiers: once a day, queue ONE trivial
 * feature into a dedicated throwaway canary harness and touch nothing — the
 * autonomous loop (routine tick → blueprint-run → dispatch → pipeline) must
 * carry it to a terminal state on its own. The NEXT day's tick checks the
 * previous canaries: one still un-terminal past its deadline means the
 * production loop is broken in a way the hermetic tiers can't see (config rot,
 * budget exhaustion, prompt drift — plan D-001), and files a forensics-laden
 * improvement (DBOS workflow status + nursery rows + fire-state attached)
 * through the watchdog's capture core (tagged + deduped — plan D-006).
 *
 * One `system:hive-canary` action, two phases per fire, both replay-safe:
 *   1. CHECK — canary features (payload.canary=true) older than
 *      `deadlineHours` (default 6) that are not terminal and not yet reported
 *      → gather forensics → captureImprovement (kind=bug, dedupScope 'open')
 *      → stamp payload.canary_reported so a fixed loop doesn't re-file daily.
 *   2. QUEUE — insert today's `F-CANARY-<YYYYMMDD>` (ON CONFLICT DO NOTHING —
 *      idempotent across replays and same-day re-fires).
 *
 * SELF-GATING: when the routine's harness is not in the workspace registry the
 * fire logs + no-ops cleanly (no error, no backoff) — so the routine can stay
 * ACTIVE and becomes effective the moment a canary harness is registered.
 * Cost: one trivial feature per day (plan D-004).
 *
 * EI-7655: Phase 2's INSERT is raw SQL (idempotent, replay-safe), NOT
 * work_items:create — so it never fired that tool's `emits` demand event, the
 * signal the Queen's default wake subscription rides (start-hive-wake-
 * orchestration-2026-06-09 P-001/D-001, see work_items/create.ts). A freshly
 * queued canary was therefore invisible to the event-driven wake path and sat
 * silent until some UNRELATED demand in the same Hive happened to wake the
 * Queen anyway (usually true for a busy Hive — hence "usually passes" — but
 * not guaranteed, and the exact "DBOS pipelines: NONE / no autoloop_state
 * rows" forensics a missed canary reports). Fixed by calling the same
 * `requestUrgentPotWake` bypass `work_items:create`'s `urgent` flag uses,
 * right after a NEW canary is actually inserted — mirrors the existing
 * hive-home resolution used a few lines below for the pause check.
 *
 * Seed: seed-hive-canary-routine.ts. Registered via register-system-actions.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { mugKettleSystemEnabled } from '../../pot/started';
import { loadHarnessRegistry } from '../../harness-registry';
import { captureImprovement } from '../improvements/capture-core';
import { getOwnerSteering, isPausedNow } from '../../owner-steering';
import { requestUrgentPotWake } from '../../pot/urgent-wake';
import { routineStorageSlug } from '../../pot-membership';

/**
 * The harness_slug canary rows are actually STORED under — which is NOT always the
 * routine's `install_slug` (EI-19298246923137692).
 *
 * `hive-canary` is a WORKSPACE_GLOBAL_LABEL (pot-membership.ts), so Pot-membership
 * enforcement re-homes every row written under it to the platform Pot (`papercusp`).
 * The write path therefore lands rows at a DIFFERENT slug than `installSlug`, while
 * every read/stamp here used to filter on `installSlug` verbatim — matching zero rows
 * forever, with no error and no warning. Both detectors went silently blind: 6 canaries
 * (F-CANARY-20260722..27) sat open with `canary_reported`/`canary_sla_reported` NULL
 * for up to 11 days, and the 15-min SLA sweep reported nothing on every single tick.
 *
 * Resolving through the SAME resolver the write path uses keeps read and write in
 * agreement BY CONSTRUCTION, including for any label added to that set later.
 * `installSlug` is still the right value for the registry self-gate, pause resolution,
 * log lines and watchdogKeys (stable alarm identity) — only DB row addressing moves.
 */
const canaryStorageSlug = routineStorageSlug;

/**
 * Terminal-enough statuses: the loop carried the canary to a verdict. Includes the
 * unified work-item enum (`done`/`dropped`, work-item-status-full-unify) AND the
 * legacy feature spellings (`passed`/`deprecated`/`failed`/`resolved`/`closed`).
 * A cup now COMPLETES a canary to `done`, so omitting `done` here (the pre-unify
 * bug, EI-18170) made a SUCCEEDED canary read as non-terminal — once the daily
 * check ran unpaused it would falsely re-report + deprecate every completed canary
 * older than the deadline. Exported for reuse by the fast SLA sweep so both
 * detectors share ONE terminal definition.
 */
export const CANARY_TERMINAL = new Set([
  'done',
  'dropped',
  'deprecated',
  'passed',
  'failed',
  'resolved',
  'closed',
]);

/** True when a canary feature has reached any terminal state (unified or legacy). */
export function isCanaryTerminal(status: string): boolean {
  return CANARY_TERMINAL.has(status);
}

/**
 * The PASS-like subset of {@link CANARY_TERMINAL}: statuses that assert the work
 * was actually CARRIED to a successful conclusion. The complement (`dropped`,
 * `deprecated`, `failed`) is ABANDON-like — it records that the canary was given
 * up on, which is an honest disposition rather than a claimed success.
 *
 * The split exists because only a pass-like terminal can constitute a FALSE GREEN.
 * An su that `dropped` a stale canary during an owner pause is doing legitimate
 * cleanup; an su that marked one `done` produced a row indistinguishable from the
 * autonomous loop having carried it (see {@link isVoidedCanaryOwner}).
 */
export const CANARY_PASS_LIKE = new Set(['done', 'passed', 'resolved', 'closed']);

/**
 * True when a canary's `terminal_owner` is an AGENT or human rather than the
 * autonomous loop — i.e. the completion proves nothing about the thing the canary
 * exists to measure.
 *
 * Ownership shapes observed in `harness_features_consolidated.terminal_owner`:
 *  - `s-<epochMs>-<hex>`   a cup session — the autonomous loop. THE ONLY VALID PASS.
 *  - `su-<uuid>`           an su/engineer agent — self-selected, carried by hand.
 *  - `system:hive-canary`  this routine's own deprecation stamp (see Phase 1).
 *
 * Unknown/NULL owners are NOT treated as agent-owned: this predicate gates a bug
 * report, so it must fail CLOSED (report nothing) rather than manufacture a red on
 * a shape it does not recognise. Historic rows predating terminal_owner therefore
 * stay silent instead of retro-firing.
 */
export function isVoidedCanaryOwner(terminalOwner: string | null | undefined): boolean {
  if (!terminalOwner) return false;
  if (terminalOwner.startsWith('system:')) return false;
  // A cup session id is `s-<digits>-<hex>`; an su id is `su-<uuid>`. Match the cup
  // shape positively rather than blacklisting `su-` so any future agent-id prefix
  // is treated as an agent (fail-loud on the measurement) rather than as a cup.
  if (/^s-\d+-[0-9a-f]+$/i.test(terminalOwner)) return false;
  return true;
}

export interface CanaryFeatureRow {
  feature_id: string;
  status: string;
  created_ts: number | string;
  /**
   * Who drove the canary to its terminal state. Load-bearing, not decorative: the
   * verdict is meaningless without it, because `status` alone cannot distinguish
   * "the autonomous loop carried this end-to-end" from "an agent typed done".
   */
  terminal_owner?: string | null;
  payload: {
    canary?: boolean;
    canary_reported?: boolean;
    canary_sla_reported?: boolean;
    canary_void_reported?: boolean;
  } | null;
}

export interface CanaryPlan {
  /** Canary ids overdue (past deadline, non-terminal, unreported) — to report. */
  overdue: string[];
  /** Today's canary feature id (`F-CANARY-<YYYYMMDD>`). */
  queueId: string;
  /**
   * Canary ids that WOULD be overdue but are suppressed because the harness's
   * Hive currently has `pauseNewWork` set (owner-steering-pause-aware-canary
   * follow-on to EI-7420) — an intentional pause is not an autonomous-loop
   * failure. NOT marked canary_reported, so a still-non-terminal canary is
   * re-evaluated (and genuinely reported if still overdue) once un-paused.
   */
  suppressed: string[];
  /**
   * Canaries that reached a PASS-like terminal state under an AGENT's ownership
   * rather than the autonomous loop's — the measurement for that day is VOID, not
   * healthy. Before this existed such a row was silently filtered out as "terminal,
   * nothing to report", so a canary an su completed by hand was indistinguishable
   * from one a cup carried, and the detector's silence read as a green.
   *
   * Deliberately NOT pause-suppressed. An owner pause explains a canary that is
   * STUCK; it does not explain one that was marked done. If anything a pause makes
   * a pass-like completion more suspect, since no cup could have produced it.
   */
  voided: string[];
}

/** Today's canary id from a clock (UTC date-keyed — one per day, replay-stable). */
export function canaryIdFor(nowMs: number): string {
  const d = new Date(nowMs);
  const ymd =
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
  return `F-CANARY-${ymd}`;
}

/**
 * Pure tick planning: which existing canaries are overdue (created more than
 * `deadlineHours` ago, not terminal, not already reported), and today's queue id.
 */
export function planCanaryTick(
  rows: CanaryFeatureRow[],
  opts: { deadlineHours?: number; nowMs?: number; isPaused?: boolean } = {},
): CanaryPlan {
  const deadlineHours = opts.deadlineHours ?? 6;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - deadlineHours * 3_600_000;
  const canaryRows = rows
    .filter((r) => r.payload !== null && r.payload !== undefined)
    .filter((r) => r.payload?.canary === true);
  const candidates = canaryRows
    .filter((r) => r.payload?.canary_reported !== true)
    .filter((r) => !CANARY_TERMINAL.has(r.status))
    .filter((r) => Number(r.created_ts) < cutoff)
    .map((r) => r.feature_id);
  // A canary that reached a PASS-like terminal state under an agent's ownership is
  // a VOID measurement, not a healthy one. This is the case the detector used to be
  // structurally blind to: `!CANARY_TERMINAL.has(status)` above drops every terminal
  // row, so a hand-completed canary left the pipeline silently and the silence read
  // as a pass. Abandon-like terminals (`dropped`/`deprecated`/`failed`) are excluded
  // — an agent dropping a stale canary is honest cleanup, not a claimed success.
  const voided = canaryRows
    .filter((r) => r.payload?.canary_void_reported !== true)
    .filter((r) => CANARY_PASS_LIKE.has(r.status))
    .filter((r) => isVoidedCanaryOwner(r.terminal_owner))
    .map((r) => r.feature_id);
  // Pause-aware (EI-7420): an owner-initiated pauseNewWork means the Queen is
  // intentionally starting no new work — a stuck canary under that condition is
  // an expected consequence of the pause, not a broken autonomous loop. Suppress
  // the report entirely (never mark canary_reported) so the SAME canary is
  // re-evaluated — and genuinely reported if still overdue — once un-paused.
  if (opts.isPaused) {
    // `voided` deliberately survives the pause — see CanaryPlan.voided.
    return { overdue: [], queueId: canaryIdFor(nowMs), suppressed: candidates, voided };
  }
  return { overdue: candidates, queueId: canaryIdFor(nowMs), suppressed: [], voided };
}

export interface CanarySlaPlan {
  /**
   * Canary ids breaching the FAST completion SLA: created more than `slaMinutes`
   * ago, still non-terminal, and not yet SLA-reported. These get an EARLY-WARNING
   * bug — distinct from the daily 6h `overdue` report — so a dark completion driver
   * is surfaced in ~30min instead of ~24h.
   */
  breaching: string[];
  /** Suppressed because the harness's Hive is owner-paused (see planCanaryTick). */
  suppressed: string[];
}

/**
 * Pure planning for the FAST SLA sweep (EI-18170 recurrence-guard). The daily
 * `planCanaryTick` only fires once/day with a 6h deadline, so a canary the loop
 * never touches is invisible for up to ~24h AND only if the daily routine itself
 * runs. This complementary sweep runs every ~15min and flags any canary older than
 * `slaMinutes` (default 30) that is still non-terminal and not yet SLA-reported.
 *
 * Deliberately independent of `planCanaryTick`:
 *  - a SEPARATE stamp (`canary_sla_reported`, not `canary_reported`) so the fast
 *    early-warning and the daily 6h report dedup independently and neither
 *    suppresses the other;
 *  - it does NOT queue and does NOT deprecate — deprecation stays the daily
 *    check's single responsibility (EI-8524), so an early SLA warning never kills
 *    a canary that might still complete before the 6h deadline.
 * Same pause-awareness as the daily check (EI-7420): an owner pause is an intended
 * state, not a loop failure, so suppress (and never stamp) while paused.
 */
export function planCanarySlaCheck(
  rows: CanaryFeatureRow[],
  opts: { slaMinutes?: number; nowMs?: number; isPaused?: boolean } = {},
): CanarySlaPlan {
  const slaMinutes = opts.slaMinutes ?? 30;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - slaMinutes * 60_000;
  const candidates = rows
    .filter((r) => r.payload !== null && r.payload !== undefined)
    .filter((r) => r.payload?.canary === true)
    .filter((r) => r.payload?.canary_sla_reported !== true)
    .filter((r) => !isCanaryTerminal(r.status))
    .filter((r) => Number(r.created_ts) < cutoff)
    .map((r) => r.feature_id);
  if (opts.isPaused) {
    return { breaching: [], suppressed: candidates };
  }
  return { breaching: candidates, suppressed: [] };
}

/**
 * RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-051 / D-045).
 *
 * Both canary actions measure exactly ONE thing: does the AUTONOMOUS CUP LOOP
 * carry queued work end-to-end? That is not incidental framing — it is encoded
 * in `isVoidedCanaryOwner` above, which accepts a cup session (`s-<ms>-<hex>`)
 * as THE ONLY VALID PASS and reports an agent-owned completion as a VOID
 * measurement. The cup tier is retired (D-001): `fleet/operator-spawn.ts`
 * refuses every `isRetiredTierRole` spawn while `papercusp-mug-kettle-system`
 * is OFF, and OFF is the DELIVERED state (D-016 polarity).
 *
 * So while the flag is OFF the canary's pass condition is UNREACHABLE BY
 * CONSTRUCTION, and every tick can produce only one of two false alarms:
 *   - the canary sits un-terminal  → SLA-breach bug, then a daily miss bug;
 *   - an su claims it from the pool → pass-like terminal → VOID bug.
 * Measured 2026-08-10: F-CANARY-20260803..20260809 all sat `open`, and the last
 * pass-like completion (20260802) was su-owned and already void-stamped.
 *
 * A detector for a deliberately-retired subsystem is noise, not signal. This
 * gate is the DURABLE half of the settlement — the two routine rows were also
 * disarmed, but a row is one UPDATE away from firing again (and `active` is
 * re-appliable by any re-seed), whereas this cannot resurrect while the flag is
 * OFF. Flip the flag back ON for testing and both detectors return, intact.
 */
async function canaryTierRetired(label: string): Promise<boolean> {
  if (await mugKettleSystemEnabled()) return false;
  console.log(
    `[${label}] mug/kettle/cup tier is RETIRED, permanently — ` +
      `skipping: this canary measures whether a CUP carries queued work end-to-end, and no cup can spawn, ` +
      `so every verdict would be a false alarm. This detector is NOT restorable: the escape hatch ` +
      `(papercusp-mug-kettle-system) was deleted in P-068, so reviving it means measuring a different subject.`,
  );
  return true;
}

/** Forensics for one missed canary: DBOS pipeline rows + nursery rows + fire-state. */
export async function gatherForensics(slug: string, featureId: string, workspaceId: string): Promise<string> {
  const { sql } = getOrgPg();
  const parts: string[] = [];
  try {
    const reg = await sql<{ t: string | null }[]>`SELECT to_regclass('dbos.workflow_status') AS t`;
    if (reg[0]?.t) {
      const wfs = await sql<{ workflow_uuid: string; status: string; created_at: string | null }[]>`
        SELECT workflow_uuid, status, to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD HH24:MI') AS created_at
          FROM dbos.workflow_status
         WHERE workflow_uuid LIKE ${'pipeline:' + slug + ':' + featureId + ':%'}
         ORDER BY workflow_uuid`;
      parts.push(
        wfs.length
          ? `DBOS pipelines: ${wfs.map((w) => `${w.workflow_uuid}=${w.status} (${w.created_at ?? '?'})`).join('; ')}`
          : 'DBOS pipelines: NONE — the dispatcher never started a pipeline for this canary (links 1–3 broken).',
      );
    } else {
      parts.push('DBOS pipelines: dbos schema absent (DBOS not booted on this host).');
    }
  } catch (e) {
    parts.push(`DBOS pipelines: read failed (${e instanceof Error ? e.message : e})`);
  }
  try {
    const spawns = await sql<{ spawn_id: string; child_role: string; status: string; error_message: string | null }[]>`
      SELECT spawn_id, child_role, status, error_message
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug} AND feature_id = ${featureId}
       ORDER BY started_at DESC LIMIT 10`;
    parts.push(
      spawns.length
        ? `Nursery: ${spawns.map((s) => `${s.spawn_id} ${s.child_role}=${s.status}${s.error_message ? ` (${s.error_message.slice(0, 120)})` : ''}`).join('; ')}`
        : 'Nursery: no agent spawns recorded for this canary.',
    );
  } catch (e) {
    parts.push(`Nursery: read failed (${e instanceof Error ? e.message : e})`);
  }
  try {
    const fires = await sql<{ role: string; last_status: string | null; consecutive_errors: number }[]>`
      SELECT role, last_status, consecutive_errors::int
        FROM harness_shared.autoloop_state
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug}
       ORDER BY role`;
    parts.push(
      fires.length
        ? `Fire-state: ${fires.map((f) => `${f.role}: ${f.last_status ?? '(none)'} (consecutive_errors=${f.consecutive_errors})`).join('; ')}`
        : 'Fire-state: no autoloop_state rows — the trigger chain (link 1) never fired for this harness.',
    );
  } catch (e) {
    parts.push(`Fire-state: read failed (${e instanceof Error ? e.message : e})`);
  }
  return parts.join('\n');
}

registerSystemAction('hive-canary', async (ctx: SystemActionCtx) => {
  const { installSlug, workspaceId, payloadTemplate } = ctx;
  const deadlineHours = Number(payloadTemplate?.deadlineHours) || 6;

  // Retired-tier gate — see canaryTierRetired. Deliberately FIRST: the phases
  // below both REPORT (file bugs) and QUEUE (insert tomorrow's canary), and
  // while the cup tier is retired neither has a defensible outcome.
  if (await canaryTierRetired('hive-canary')) return;

  // Self-gate: no registered canary harness → clean no-op (the routine stays
  // ACTIVE; it goes live the moment the harness is registered).
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    if (!reg.projects.some((p) => p.slug === installSlug)) {
      console.log(`[hive-canary] harness "${installSlug}" not registered in ${workspaceId} — skipping (self-gate)`);
      return;
    }
  } catch (e) {
    console.warn(`[hive-canary] registry unreadable — skipping: ${e instanceof Error ? e.message : e}`);
    return;
  }

  const { sql } = getOrgPg();
  // Address rows where they are actually STORED, not where the routine is installed.
  const storageSlug = await canaryStorageSlug(installSlug, workspaceId);
  const rows = await sql<CanaryFeatureRow[]>`
    SELECT feature_id, status, created_ts, terminal_owner, payload
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${storageSlug}
       AND item_kind = 'feature' AND payload IS NOT NULL AND payload->>'canary' = 'true'
     ORDER BY created_ts DESC LIMIT 30`;

  // Pause-aware (EI-7420): resolve the Hive this harness belongs to (a MEMBER
  // harness carries `hive_slug`; a hive-home harness IS its own hive) and check
  // whether the owner currently has pauseNewWork set — an intentional pause, not
  // an autonomous-loop failure, so a stuck canary under it shouldn't file a bug.
  let isPaused = false;
  // EI-7655: resolved here for the pause check, reused below to wake the
  // correct Hive (a MEMBER harness's demand event must wake ITS hive home,
  // not itself) after Phase 2 queues a genuinely new canary.
  let potHomeSlug = installSlug;
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    potHomeSlug = reg.projects.find((p) => p.slug === installSlug)?.hive_slug ?? installSlug;
    const steering = await getOwnerSteering(workspaceId, potHomeSlug, sql);
    isPaused = isPausedNow(steering, Date.now());
  } catch (e) {
    console.warn(`[hive-canary] pause-check failed for ${installSlug} — treating as unpaused: ${e instanceof Error ? e.message : e}`);
  }
  const plan = planCanaryTick(rows, { deadlineHours, isPaused });
  if (plan.suppressed.length > 0) {
    console.log(`[hive-canary] ${installSlug}: suppressed ${plan.suppressed.length} overdue report(s) — Hive is owner-paused (pauseNewWork): ${plan.suppressed.join(', ')}`);
  }

  // Phase 1 — CHECK: report each overdue canary with forensics (cap 3/tick).
  for (const fid of plan.overdue.slice(0, 3)) {
    const forensics = await gatherForensics(installSlug, fid, workspaceId);
    const res = await captureImprovement({
      title: `Hive canary ${installSlug}/${fid} missed its deadline`,
      kind: 'bug',
      severity: 'major',
      body:
        `The daily canary feature ${fid} in harness ${installSlug} did not reach a terminal state within ` +
        `${deadlineHours}h untouched — the autonomous hive loop is not carrying queued work end-to-end ` +
        `(hive-loop-e2e-testing-2026-06-10 P-009).\n\nForensics:\n${forensics}`,
      foundDuring: 'hive-canary routine',
      dedupScope: 'open',
      // WI-39594: keyed per INSTALL, not per canary fid — each day mints a fresh
      // fid, so a per-fid key never repeats and the detector filed one open item
      // per day per install (the gate-canary dupe family the 2026-08-17 queue
      // audit dropped). A re-breach now COALESCES onto the standing item, whose
      // title/body refresh to the newest fid; per-fid history rides occurrences.
      watchdogKey: `hive-canary:${installSlug}`,
    });
    // Mark reported regardless of created/deduped — one report per canary.
    // Merge canary_reported: true into the payload JSONB object (or create the object if payload is null).
    // EI-8524: ALSO deprecate the canary itself here. Before this it stayed
    // `todo` forever once reported — the miss is already captured durably as a
    // bug (or deduped into an existing one), so leaving the work-item open adds
    // nothing but permanent frontier/Kettle "work-feed-stuck" noise (observed
    // live: F-CANARY-20260703 sat unplaced 4+ days, already `canary_reported`,
    // still re-triggering the anomaly detector every wake). Deprecating loses no
    // signal (the bug carries the forensics) and a fresh dated canary is queued
    // every day regardless (Phase 2 below), so the E2E health check keeps running.
    const updateResult = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = CASE
               WHEN payload IS NULL THEN '{"canary": true, "canary_reported": true}'::jsonb
               ELSE payload || '{"canary_reported": true}'::jsonb
             END,
             status = 'deprecated',
             terminal_owner = 'system:hive-canary',
             terminal_completion_ref = ${`Canary missed its ${deadlineHours}h deadline; reported as ${res.issue?.id ?? (res.created ? 'a new bug' : 'a deduped bug')}. Auto-deprecated (EI-8524) — the miss is captured via the linked bug; a fresh canary is queued daily regardless.`},
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${storageSlug} AND feature_id = ${fid}
       RETURNING feature_id`;
    if (updateResult.length === 0) {
      console.warn(
        `[hive-canary] ${installSlug}/${fid} UPDATE failed — row not found in database`,
      );
    } else {
      console.warn(
        `[hive-canary] ${installSlug}/${fid} MISSED its ${deadlineHours}h deadline — ` +
          (res.created ? `filed ${res.issue?.id ?? 'improvement'}` : `report deduped (${res.reason ?? 'duplicate'})`),
      );
    }
  }

  // Phase 1b — VOID: a canary that reached a PASS-like terminal state under an
  // AGENT's ownership measured nothing. Reported SEPARATELY from the overdue miss
  // (distinct watchdogKey + its own `canary_void_reported` stamp) so this never
  // interferes with the Phase 1 report/deprecate lifecycle (EI-8524), and NOT
  // suppressed by the owner pause (see CanaryPlan.voided).
  //
  // Before this existed the row was simply filtered out as "terminal", so the
  // strongest possible negative signal — the canary was satisfied by the very
  // population it does not measure — produced total silence, which every surface
  // downstream read as a healthy pass.
  for (const fid of plan.voided.slice(0, 3)) {
    const owner = rows.find((r) => r.feature_id === fid)?.terminal_owner ?? 'unknown';
    const res = await captureImprovement({
      title: `Hive canary ${installSlug}/${fid} was completed by an AGENT, not the autonomous loop — measurement VOID`,
      kind: 'bug',
      severity: 'major',
      body:
        `The daily canary feature ${fid} in harness ${installSlug} reached a pass-like terminal state, but its ` +
        `terminal_owner is \`${owner}\` — an agent/human, not a cup session (\`s-<epochMs>-<hex>\`).\n\n` +
        `The canary exists to answer exactly one question: does the autonomous hive loop carry queued work ` +
        `end-to-end? A completion performed by an agent does not answer it. This day's measurement is VOID — ` +
        `treat it as NO DATA, never as a healthy pass.\n\n` +
        `This is not a reprimand of the agent: the canary sat in the general claimable pool, so ` +
        `scheduler:get_next hands it out like ordinary work. The durable fix is to make canaries ` +
        `structurally un-self-selectable while keeping them cup-placeable (EI-19441925633833456).`,
      foundDuring: 'hive-canary routine (void-measurement check)',
      dedupScope: 'open',
      // WI-39594: per-install key — see the deadline-miss site above.
      watchdogKey: `hive-canary-void:${installSlug}`,
    });
    // Stamp ONLY. Status and terminal_owner are left exactly as they are: the row IS
    // the evidence, and rewriting it would destroy the record of what happened.
    const voidStamp = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = CASE
               WHEN payload IS NULL THEN '{"canary": true, "canary_void_reported": true}'::jsonb
               ELSE payload || '{"canary_void_reported": true}'::jsonb
             END,
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${storageSlug} AND feature_id = ${fid}
       RETURNING feature_id`;
    if (voidStamp.length === 0) {
      console.warn(`[hive-canary] ${installSlug}/${fid} void-stamp UPDATE failed — row not found`);
    } else {
      console.warn(
        `[hive-canary] ${installSlug}/${fid} VOID — completed by ${owner}, not the autonomous loop; ` +
          (res.created ? `filed ${res.issue?.id ?? 'improvement'}` : `report deduped (${res.reason ?? 'duplicate'})`),
      );
    }
  }

  // Phase 2 — QUEUE today's canary (idempotent: date-keyed id + DO NOTHING).
  const now = Date.now();
  const title = typeof payloadTemplate?.title === 'string' && payloadTemplate.title.trim()
    ? payloadTemplate.title.trim()
    : 'Canary: append today\'s date to CANARY.md';
  // P-006 (autonomous-loop-canary-reliability-2026-06-29): seed the canary with a
  // HIGH backlog priority (low feature_order — the claim layer orders feature_order
  // ASC NULLS LAST) so the deadline-bound health check is placed PROMPTLY even in a
  // deep frontier. Without it the canary lands feature_order=NULL and sorts behind
  // every prioritized item (observed: a 214-deep frontier left it unplaced for hours,
  // failing the deadline even though the loop was healthy). Configurable via the
  // routine payload (featureOrder); default 0 = top of the backlog.
  const canaryOrder = Number.isFinite(Number(payloadTemplate?.featureOrder))
    ? Math.trunc(Number(payloadTemplate?.featureOrder))
    : 0;
  try {
    const inserted = await sql<{ feature_id: string }[]>`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, summary, status, attempts, item_kind,
         feature_order, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts)
      VALUES
        -- Write the RESOLVED storage slug directly (EI-19298246923137692): Pot-membership
        -- enforcement would re-home a workspace-global label anyway, so writing it here
        -- keeps ON CONFLICT (harness_slug, feature_id) idempotent against the row's real
        -- resting slug instead of depending on the trigger rewrite for dedup.
        (${storageSlug}, ${plan.queueId}, ${title},
         'Trivial daily canary feature — the autonomous loop must carry it to DONE untouched.',
         -- work-item-status-full-unify P-007: born at the unified claimable token 'open' (was
         -- 'todo') — this raw INSERT bypasses the alias-fold, and a 'todo' canary sits OUTSIDE
         -- the ['open'] claim floor (P-004), so the autoloop would never pick it up → false red.
         'open', 0, 'feature', ${canaryOrder}, '{"canary": true}'::jsonb, FALSE, ${workspaceId}, ${now}, ${now}, ${now})
      ON CONFLICT (harness_slug, feature_id) DO NOTHING
      RETURNING feature_id`;
    if (inserted.length > 0) {
      console.log(`[hive-canary] queued ${installSlug}/${plan.queueId} (deadline ${deadlineHours}h)`);
      // EI-7655: this raw INSERT bypasses work_items:create's `emits` demand
      // event, so without an explicit wake the newly-queued canary is invisible
      // to the Queen's event-driven wake path. Mirror the `urgent` bypass
      // (fail-soft by contract — never throws, worst case is a floor-bounded
      // coalesce) so the canary is woken-for promptly instead of relying on
      // incidental unrelated Hive demand.
      try {
        const wake = await requestUrgentPotWake({
          reason: `hive-canary: queued today's canary ${plan.queueId} in ${installSlug}`,
          harness: potHomeSlug,
          workspaceId,
        });
        if (wake.error) {
          console.warn(`[hive-canary] urgent wake for ${installSlug}/${plan.queueId} failed (canary still queued): ${wake.error}`);
        }
      } catch (e) {
        console.warn(`[hive-canary] urgent wake threw for ${installSlug}/${plan.queueId} (canary still queued): ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log(`[hive-canary] ${installSlug}/${plan.queueId} already queued from previous run`);
    }
  } catch (e) {
    console.error(`[hive-canary] failed to queue ${installSlug}/${plan.queueId}: ${e instanceof Error ? e.message : e}`);
  }
});

/**
 * `system:hive-canary-sla` — the FAST completion-SLA sweep (EI-18170 recurrence
 * guard). Runs every ~15min (seed-hive-canary-sla-routine.ts) and fires an
 * early-warning bug the moment today's canary breaches its completion SLA
 * (default 30min), INDEPENDENT of any Mug/Queen wake — closing the detector gap
 * that let F-CANARY-20260720 sit open+untouched with no standing alarm (the only
 * prior detector was the daily 6h CHECK, so a dark completion driver was invisible
 * for up to ~24h and only if the daily routine itself ran).
 *
 * Mirrors the daily action's self-gate + Hive-pause resolution, but is a
 * pure EARLY WARNING: it does NOT queue a canary and does NOT deprecate — it only
 * reports (with a DISTINCT watchdogKey + the `canary_sla_reported` stamp) so the
 * daily 6h detector's report/deprecate lifecycle (EI-8524) is untouched.
 */
registerSystemAction('hive-canary-sla', async (ctx: SystemActionCtx) => {
  const { installSlug, workspaceId, payloadTemplate } = ctx;
  const slaMinutes = Number(payloadTemplate?.slaMinutes) || 30;

  // Retired-tier gate — see canaryTierRetired. This sweep is the LOUDER of the
  // two (every ~15min vs daily), so it is the larger false-alarm source while
  // no cup can spawn to complete the canary it is timing.
  if (await canaryTierRetired('hive-canary-sla')) return;

  // Self-gate: no registered canary harness → clean no-op (routine stays ACTIVE).
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    if (!reg.projects.some((p) => p.slug === installSlug)) {
      console.log(`[hive-canary-sla] harness "${installSlug}" not registered in ${workspaceId} — skipping (self-gate)`);
      return;
    }
  } catch (e) {
    console.warn(`[hive-canary-sla] registry unreadable — skipping: ${e instanceof Error ? e.message : e}`);
    return;
  }

  const { sql } = getOrgPg();
  // Address rows where they are actually STORED, not where the routine is installed.
  const storageSlug = await canaryStorageSlug(installSlug, workspaceId);
  const rows = await sql<CanaryFeatureRow[]>`
    SELECT feature_id, status, created_ts, terminal_owner, payload
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${storageSlug}
       AND item_kind = 'feature' AND payload IS NOT NULL AND payload->>'canary' = 'true'
     ORDER BY created_ts DESC LIMIT 30`;

  // Pause-aware (EI-7420): resolve the Hive this harness belongs to and honor an
  // owner pauseNewWork — an intentional pause is not a broken loop.
  let isPaused = false;
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    const potHomeSlug = reg.projects.find((p) => p.slug === installSlug)?.hive_slug ?? installSlug;
    const steering = await getOwnerSteering(workspaceId, potHomeSlug, sql);
    isPaused = isPausedNow(steering, Date.now());
  } catch (e) {
    console.warn(`[hive-canary-sla] pause-check failed for ${installSlug} — treating as unpaused: ${e instanceof Error ? e.message : e}`);
  }

  const plan = planCanarySlaCheck(rows, { slaMinutes, isPaused });
  if (plan.suppressed.length > 0) {
    console.log(`[hive-canary-sla] ${installSlug}: suppressed ${plan.suppressed.length} SLA breach(es) — Hive is owner-paused (pauseNewWork): ${plan.suppressed.join(', ')}`);
  }

  // Report each SLA breach (cap 3/tick) with forensics. Distinct watchdogKey +
  // stamp from the daily detector so the two never dedup into each other.
  for (const fid of plan.breaching.slice(0, 3)) {
    const forensics = await gatherForensics(installSlug, fid, workspaceId);
    const res = await captureImprovement({
      title: `Hive canary ${installSlug}/${fid} breached its ${slaMinutes}min completion SLA`,
      kind: 'bug',
      severity: 'major',
      body:
        `The daily canary feature ${fid} in harness ${installSlug} has been non-terminal and untouched for ` +
        `more than ${slaMinutes}min — the autonomous hive completion driver has likely gone dark ` +
        `(create/queue half OK, but no cup spawned to claim + complete it). This is the FAST early-warning ` +
        `SLA sweep (EI-18170); the daily 6h CHECK will independently report + deprecate if it is still ` +
        `un-terminal at its deadline.\n\nForensics:\n${forensics}`,
      foundDuring: 'hive-canary-sla routine',
      dedupScope: 'open',
      // WI-39594: per-install key — see the deadline-miss site above. Still a
      // distinct prefix from the daily detector, so the two never dedup into
      // each other.
      watchdogKey: `hive-canary-sla:${installSlug}`,
    });
    // Stamp canary_sla_reported (distinct from canary_reported) — one SLA report
    // per canary, idempotent across replays. Do NOT change status: deprecation
    // stays the daily check's single responsibility (EI-8524), and leaving the
    // canary open lets it still complete (turning the alarm into a near-miss).
    const updateResult = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = CASE
               WHEN payload IS NULL THEN '{"canary": true, "canary_sla_reported": true}'::jsonb
               ELSE payload || '{"canary_sla_reported": true}'::jsonb
             END,
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${storageSlug} AND feature_id = ${fid}
       RETURNING feature_id`;
    if (updateResult.length === 0) {
      console.warn(`[hive-canary-sla] ${installSlug}/${fid} stamp UPDATE failed — row not found`);
    } else {
      console.warn(
        `[hive-canary-sla] ${installSlug}/${fid} BREACHED its ${slaMinutes}min SLA — ` +
          (res.created ? `filed ${res.issue?.id ?? 'improvement'}` : `report deduped (${res.reason ?? 'duplicate'})`),
      );
    }
  }
});
