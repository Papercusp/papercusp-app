/**
 * autoloop-chronic-failure — the CHRONIC-FAILURE ESCALATOR
 * (gym-unwedge-scout-novelty-2026-07-02 GYM-2, generalized across roles).
 *
 * THE GAP THIS CLOSES: a routine-driven cycle can fail EVERY fire and nothing
 * escalates — the gym-cycle sat at consecutive_errors=72 (12 days dead) and the
 * only witness was a bare `gym-cycle:error` literal nobody read. The fire-gate's
 * error backoff correctly SLOWS a failing cycle, but slowing is not surfacing:
 * a chronically-red autoloop row must become a visible, owned artifact.
 *
 * MECHANISM (the watchdog-sweep house pattern — pure decider + debounced
 * fail-soft PG sweep on the routines tick): any `autoloop_state` row with
 * `consecutive_errors >= threshold` files ONE improvements OBSERVATION
 * (kind bug, carrying the verbatim last_status) per breach, debounced 24h per
 * (harness, role) via the `hive_watchdog_fires` ledger. The observation enters
 * the SAME triage pipeline scout/queen already consume — no parallel alerting
 * system. Kill switch: PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD <= 0.
 *
 * WI-4632 (GYM-2, generalized ACROSS ROLES — not gym-specific): the observation alone is a
 * mailbox drop that can sit unread for the same reason the underlying cycle went silently dead
 * — nobody was watching. Each escalation ALSO requests an immediate wake of the overwatch (the
 * autonomous system-health supervisor) through `overwatch/wake-bridge.ts`'s `requestOverwatchWake`
 * — the same B-07↔B-04 seam `kettle:start` uses. Fail-soft: an unwired waker, the flag off, or an
 * unresolvable pot-home harness for a wildcard-scoped row all degrade to a no-op wake, never to a
 * blocked or un-filed observation (see `overwatchWaked` on the escalated result).
 *
 * SKIP AN ALREADY-PAUSED ROUTINE (found live: EI-6760/6761/6762 — a loop-arm
 * loop whose owner session died was correctly auto-paused by the pre-existing
 * stuck-park backstop / the WI-1399 dead-owner guard — `harness_shared.routines
 * .active = false` — 13+ hours before this sweep next ran, yet the sweep kept
 * re-escalating it as if it were still actively failing, because it only reads
 * `autoloop_state.consecutive_errors` and never checks whether the underlying
 * routine is still armed). A `consecutive_errors` streak is a STALE watermark —
 * it is only meaningfully "chronic" while the routine is still trying (and
 * failing) to fire. So this LEFT JOINs `harness_shared.routines` on
 * `(name, workspace_id)` and drops a row whose matching routine is explicitly
 * `active = false` — a resolved (already-paused) condition, not a live one.
 * A role with NO matching routines row (director/gym-cycle/overwatch/
 * scout-cycle — fixed system roles, not `loop:arm` rows) has nothing to join
 * against and is treated as still-live (fail-open: an unknown routine state
 * must never SUPPRESS a genuine chronic-failure alert).
 *
 * SKIP AN EPHEMERAL loop:arm OWNER LOOP entirely (EI-6727 — the fix that closes this
 * escalation flood at the root): the `routine_active = false` skip above only kicks in AFTER
 * the reconcile guard pauses a dead loop, but a dead `loop-su-<uuid>` owner climbs past the
 * chronic threshold (6) and escalates in the WINDOW before the guard circuit-opens (≥8) and
 * pauses it — filing an un-actionable "loop-su-<uuid> red N fires" ticket. 28 such EIs
 * accumulated this way (all dead su sessions). A loop:arm loop is NOT the sweep's concern: it
 * is OWNER-witnessed (a live su session is its owner) and auto-terminated by the reconcile
 * dead-owner guard, which fires its OWN dedicated human escalation (`escalateDeadLoop`,
 * WI-2339 fix E) when it pauses the loop. So the sweep ALSO drops any row whose matching
 * routine carries a non-null `target_owner_id` (the structural marker of a loop:arm owner
 * loop; `target_role = system:loop-wake`) — restoring the sweep to its intended scope: the
 * witness-less FIXED system roles (director/gym-cycle/overwatch/scout-cycle) that carry no
 * `target_owner_id` and have no other escalation path.
 *
 * EI-7220: the `target_owner_id` JOIN marker above is FRAGILE — it goes NULL the moment the
 * loop's `harness_shared.routines` row is reaped, leaving an ORPHANED `autoloop_state` row that
 * fails OPEN and escalates as if a fixed system role (`loop-su-c2b2ece8-…@*` red 7 fires — the
 * exact flood EI-6727 tried to kill, resurrected by a routine GC'd out from under a stale-red
 * autoloop row). So the loop:arm guard ALSO keys off the ROLE NAME itself: `loopRoutineName` is
 * `` `loop-${ownerId}` ``, so every loop:arm role begins with `loop-` (a join-independent
 * structural marker no fixed system role uses). See `isLoopArmOwnerRole` / `isLoopArmOwnerLoop`.
 *
 * SKIP A RED-QUEEN DRILL ROW (EI-12429): the Red Queen vaccination harness PLANTS a synthetic
 * `autoloop_state` row — `harness_slug = 'red-queen-sandbox'`, `role = 'red-queen-drill-worker'`,
 * `consecutive_errors = 7`, `last_status = 'red-queen drill: synthetic consecutive fire errors
 * (planted, origin=drill)'` — under the SANDBOX workspace to exercise the fire-circuit-open
 * collector, then the drill machinery itself detects, heals (`consecutive_errors = 0`), and
 * cleans it up (drill-classes.ts `circuitOpenDrill`). It is NEVER a real chronic failure. But this
 * sweep's SELECT was NOT workspace-scoped (it read every workspace's rows, filtering only on
 * `consecutive_errors >= threshold`), so it saw the planted row transiently present and escalated
 * it as "CHRONIC autoloop failure: red-queen-drill-worker@red-queen-sandbox red 7 consecutive
 * fires" — a false positive that re-fired every 24h debounce cycle. Every artifact the drill harness
 * plants lives under the sandbox partition (`SANDBOX_WORKSPACE_ID === SANDBOX_HARNESS_SLUG ===
 * 'red-queen-sandbox'`); no real capability ever lives in that harness by construction (red-queen
 * types.ts). So the sweep drops any row whose `harness_slug` is the red-queen sandbox — restoring
 * the sandbox-partition invariant every live workspace-scoped collector already honors. See
 * `isRedQueenDrillRow`.
 *
 * BOTH SWEEPS ARE NOW WORKSPACE-SCOPED (EI-19372306666296664) — the fix EI-12429 should have been.
 * Excluding ONE known-bad `harness_slug` (above) left the unscoped query itself in place, so the
 * same defect recurred from a DIFFERENT tenant: a `workspace_id = 'default'` row for the retired
 * `director` role, dead 93 days, was filed as "SILENTLY STOPPED autoloop role: director@papercusp"
 * — a live-looking papercusp incident for a role that does not exist in this workspace
 * (EI-19370235414830628). `harness_slug` is NOT unique across workspaces ('papercusp' exists in
 * both `default` and `papercusp-workspace`), and the rendered identity dropped the workspace, so
 * the alert was textually indistinguishable from a real one.
 *
 * It was also a genuinely WRONG WRITE, not just noise: `workspaceId` was already resolved in both
 * functions and passed to `recentWatchdogFires`/`claimWatchdogFire`, so the escalation SIDE EFFECTS
 * were workspace-scoped while the row SET was not — a foreign tenant's row consumed the ACTIVE
 * workspace's 24h debounce slot, and could suppress a real alert for the same (harness, role).
 * Both SELECTs now carry `s.workspace_id = ${workspaceId}` and every message renders
 * `role@harness [workspace]` (see `autoloopRowIdentity`).
 *
 * `isRedQueenDrillRow` DELIBERATELY STAYS, though scoping now excludes the planted row by
 * construction (it lives under `SANDBOX_WORKSPACE_ID`, and the drill does NOT change the
 * process-global active workspace — its `workspaceId` parameter never reaches `activeWorkspaceId()`,
 * red-queen/sandbox.ts EI-6933). The two guards key on INDEPENDENT axes: this one on `workspace_id`,
 * that one on `harness_slug`. `activeWorkspaceId()` honors a `PAPERCUSP_WORKSPACE_ID` env pin
 * (workspace-registry precedence #2), so a drill-dedicated process pinned to the sandbox workspace
 * would see the planted row again with only the scope guard in place. Removing a cheap, tested,
 * independent-axis guard because a new one usually subsumes it is how EI-12429 became a recurrence
 * in the first place.
 */
import { getOrgPg } from '@papercusp/db-org';
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { activeWorkspaceId } from '../../workspace-registry';
import { SANDBOX_HARNESS_SLUG } from '../../red-queen/types';
import { gymBudgetFloorUsd, isEligibleAutoloop } from '../../gym/autoloop-tick';

/** Breach threshold (env-overridable; <=0 disables the sweep). */
export function chronicErrorThreshold(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD ?? 6);
  return Number.isFinite(n) ? n : 6;
}

/**
 * Staleness window (env-overridable). A `consecutive_errors` streak is only
 * meaningfully "chronic" while the routine is still TRYING to fire — a row whose
 * `last_fired_at` is older than this window is a FROZEN watermark, not a live
 * failure, and must not re-escalate forever.
 *
 * EI-6765 (overwatch@papercup, red 6 consecutive fires yet `last_fired_at` was
 * 8 DAYS stale): the active overwatch loop had moved to the `papercusp` home slug
 * (which is `ok`), leaving an orphaned `papercup` row frozen at 6 errors. The
 * pre-existing `routine_active = false` guard catches AUTO-PAUSED loops, but an
 * ORPHANED slug (rename/migration/one-time misfire) never fires again, so its
 * streak can NEVER reset — it re-escalated once every 24h debounce cycle in
 * perpetuity. Default 6h = 6× the 1h fire-gate backoff cap
 * (PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC), so a genuinely-failing loop (which fires
 * at least hourly even fully backed off) is NEVER suppressed. <=0 disables the
 * staleness guard (fail-open — every breaching row escalates as before).
 */
export function staleWindowMs(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_STALE_MS ?? 6 * 60 * 60 * 1000);
  return Number.isFinite(n) ? n : 6 * 60 * 60 * 1000;
}

export interface AutoloopStateRow {
  harness_slug: string;
  role: string;
  consecutive_errors: number;
  last_status: string | null;
  /** The matching `harness_shared.routines.active` for this (workspace, role) — from a LEFT
   *  JOIN, so `null` means no matching routine row exists (a fixed system role, not a
   *  loop:arm-materialized routine). `false` is the ONLY value that suppresses escalation —
   *  the routine engine itself has already resolved this condition (auto-paused). */
  routine_active: boolean | null;
  /** When this autoloop row last FIRED. A streak whose last fire is older than
   *  `staleWindowMs()` is a frozen watermark (EI-6765) — the row stopped firing
   *  (orphaned/renamed slug) so its error count can never reset. `null`/absent =
   *  unknown → fail-OPEN (treated as live, never silently suppressed). */
  last_fired_at?: string | Date | null;
  /** The matching `harness_shared.routines.target_owner_id` — the warm coord owner of a
   *  `loop:arm`-materialized loop (`loop-su-<uuid>` role, `target_role = system:loop-wake`).
   *  NON-NULL ⇒ this is an EPHEMERAL loop:arm OWNER loop, not a fixed system role
   *  (director/gym-cycle/overwatch/scout-cycle, which carry `null`). EI-6727: such loops are
   *  owner-witnessed AND managed end-to-end by the reconcile terminal-guard autonomy — a dead
   *  owner is auto-paused with its OWN dedicated human escalation (`escalateDeadLoop`,
   *  WI-2339 fix E). So the chronic-failure sweep escalating them is a PREMATURE DUPLICATE
   *  (fired in the window before the guard pauses the routine), flooding the queue with
   *  un-actionable "loop-su-<uuid> red N fires" tickets (28 accumulated). NON-NULL suppresses
   *  escalation; `null`/absent (a fixed system role, the sweep's intended scope) does NOT. */
  routine_target_owner_id?: string | null;
  /** Matching gym config columns, populated only by the silent-stop query. */
  gym_autoloop_enabled?: boolean | null;
  gym_autoloop_status?: string | null;
  gym_autoloop_budget_usd?: number | null;
  gym_autoloop_spent_usd?: number | null;
  /** Base tick eligibility for this harness; unknown is fail-closed for gym-cycle alerts. */
  gym_cycle_eligible?: boolean;
}

/** PURE: is this row's error streak a FROZEN watermark rather than a live failure —
 *  i.e. has it not fired within the staleness window? `null`/absent `last_fired_at`
 *  (or an unparseable value) fails OPEN (returns false: treat as live), matching the
 *  `routine_active: null` fail-open philosophy — never silently suppress on unknown. */
export function isStaleWatermark(
  row: Pick<AutoloopStateRow, 'last_fired_at'>,
  now: number,
  staleMs: number,
): boolean {
  if (staleMs <= 0) return false;
  const raw = row.last_fired_at;
  if (raw == null) return false;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t > staleMs;
}

/** PURE: which rows breach the threshold (highest streak first), EXCLUDING any row that is
 *  (a) an EPHEMERAL `loop:arm` OWNER loop (`routine_target_owner_id` non-null OR a `loop-`-prefixed
 *  role — EI-6727/EI-7220: managed end-to-end by the reconcile terminal-guard autonomy with its own
 *  dedicated dead-owner escalation, so a chronic-failure ticket is a premature duplicate; the role
 *  marker also catches an ORPHANED row whose routine was GC'd); (b) already auto-paused
 *  (`routine_active: false` — a resolved condition, not a live chronic failure; see this module's
 *  header comment); or (c) a FROZEN watermark (EI-6765 — `last_fired_at` older than the staleness
 *  window; the row stopped firing so its error count can never reset); or (d) a RED-QUEEN DRILL
 *  row (EI-12429 — a synthetic `red-queen-sandbox` artifact planted, detected, healed and cleaned
 *  up by the vaccination harness itself; never a real chronic failure). `routine_target_owner_id`
 *  null (a fixed system role — director/gym-cycle/overwatch/scout-cycle, the sweep's intended
 *  scope), `routine_active: null`, and absent `last_fired_at` are NOT excluded — fail-open, never
 *  silently suppress an unknown state. */
export function selectChronicFailures(
  rows: readonly AutoloopStateRow[],
  threshold: number,
  opts?: { now?: number; staleMs?: number },
): AutoloopStateRow[] {
  if (threshold <= 0) return [];
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? staleWindowMs();
  return rows
    .filter(
      (r) =>
        r.consecutive_errors >= threshold &&
        !isRedQueenDrillRow(r) &&
        !isLoopArmOwnerLoop(r) &&
        r.routine_active !== false &&
        !isStaleWatermark(r, now, staleMs),
    )
    .sort((a, b) => b.consecutive_errors - a.consecutive_errors);
}

/** PURE: is this a Red Queen vaccination-drill row (EI-12429)? Every artifact the drill harness
 *  plants lives under the sandbox partition — `SANDBOX_WORKSPACE_ID === SANDBOX_HARNESS_SLUG ===
 *  'red-queen-sandbox'` (red-queen types.ts) — and no real capability ever runs in that harness by
 *  construction, so ANY `autoloop_state` row whose `harness_slug` is the sandbox is a synthetic
 *  planted artifact (`circuitOpenDrill` plants `role = 'red-queen-drill-worker'`, streak 7). The
 *  drill machinery itself detects, heals and cleans it up; the chronic-failure sweep must never
 *  escalate it. Keyed on the sandbox harness slug (not the role) so a future drill class planting a
 *  different role in the sandbox is suppressed too. `null`/absent/other slug → not a drill (false). */
export function isRedQueenDrillRow(row: Pick<AutoloopStateRow, 'harness_slug'>): boolean {
  return row.harness_slug === SANDBOX_HARNESS_SLUG;
}

/** PURE: the rendered identity of an autoloop row — `role@harness [workspace]` (EI-19372306666296664).
 *
 *  The workspace is NOT decoration. Both sweeps used to render `` `${role}@${harness_slug}` ``,
 *  dropping the one field that distinguishes tenants — and `harness_slug` is NOT unique across
 *  workspaces (`'papercusp'` exists in BOTH `default` and `papercusp-workspace`). So when the
 *  unscoped SELECT above returned a foreign tenant's row, the resulting alert was textually
 *  INDISTINGUISHABLE from a live one: a dead `default`-workspace `director` row, retired 93 days
 *  earlier, was filed as "SILENTLY STOPPED autoloop role: director@papercusp" and sent a reader
 *  hunting a live papercusp role that does not exist (EI-19370235414830628).
 *
 *  The SELECT is now workspace-scoped, so this can only ever render the ACTIVE workspace — which
 *  is exactly why it is worth printing. A scope that is enforced but invisible cannot be audited
 *  from its own output: if the predicate is ever dropped again, the identity says so on the very
 *  first alert instead of producing another undiagnosable false positive. A guard's scope belongs
 *  in what it PRINTS, not only in what it checks. */
export function autoloopRowIdentity(
  row: Pick<AutoloopStateRow, 'role' | 'harness_slug'>,
  workspaceId: string,
): string {
  return `${row.role}@${row.harness_slug} [${workspaceId}]`;
}

/** PURE: is this an ephemeral `loop:arm` OWNER loop identified by its ROLE NAME alone
 *  (EI-7220)? `loopRoutineName(ownerId)` (routines/loop.ts) is `` `loop-${ownerId}` ``, so a
 *  loop:arm loop's `autoloop_state.role` — and its materialized routine name — ALWAYS begins
 *  with `loop-` (`loop-su-<uuid>`, `loop-role-<uuid>`, or a bare `loop-<uuid>`). No FIXED
 *  system role (director/gym-cycle/overwatch/scout-cycle) uses that prefix.
 *
 *  This is the JOIN-INDEPENDENT structural marker that survives the routine row being GC'd:
 *  an ORPHANED `autoloop_state` row whose `harness_shared.routines` row is gone yields
 *  `routine_target_owner_id` = NULL from the LEFT JOIN, so the owner-id marker in
 *  `isLoopArmOwnerLoop` fails OPEN and the row would (wrongly) escalate as if a witness-less
 *  fixed system role — the exact `loop-su-<uuid>@*` chronic-failure flood EI-7220 reports (a
 *  dead su session's loop whose routine was reaped while its stale-red autoloop_state row
 *  lingered). `null`/absent/non-`loop-` role → not a loop:arm loop (false). */
export function isLoopArmOwnerRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && role.startsWith('loop-');
}

/** PURE: is this an ephemeral `loop:arm` OWNER loop (EI-6727 / EI-7220)? True when EITHER
 *  (a) the matching routine carries a `target_owner_id` (the JOIN marker — a `loop-su-<uuid>`
 *  warm-coord loop), OR (b) the role name itself begins with `loop-` (`isLoopArmOwnerRole` —
 *  the join-independent marker that ALSO catches an ORPHANED row whose routine was GC'd,
 *  EI-7220). Both are owner-witnessed and auto-terminated by the reconcile dead-owner guard
 *  (which fires its OWN escalation), so the chronic-failure sweep must not also escalate them.
 *  A fixed system role (null owner-id AND a non-`loop-` name) is NOT a loop:arm loop →
 *  fail-OPEN (still eligible to escalate), never silently suppressed. */
export function isLoopArmOwnerLoop(
  row: Pick<AutoloopStateRow, 'routine_target_owner_id'> & { role?: string | null },
): boolean {
  const hasOwnerId = row.routine_target_owner_id != null && row.routine_target_owner_id !== '';
  return hasOwnerId || isLoopArmOwnerRole(row.role);
}

export interface ChronicFailureResult {
  harnessSlug: string;
  role: string;
  outcome: 'escalated' | 'debounced' | 'skipped-paused' | 'skipped-stale' | 'skipped-loop-arm' | 'skipped-drill' | 'error';
  reason: string;
  /** Only set on 'escalated': whether the companion overwatch wake (WI-4632) actually fired a
   *  live wake (`wired: true`, B-04's waker registered) vs a fail-soft no-op (unwired, or no
   *  resolvable pot-home harness for the row). Observability only — the sweep never fails or
   *  retries on a missed wake; the filed observation is the durable record regardless. */
  overwatchWaked?: boolean;
}

/**
 * The sweep. Fail-soft by contract; debounced 24h per (harness, role) so a
 * still-red row escalates once a day, not every 30s tick.
 */
export async function autoloopChronicFailureSweep(): Promise<ChronicFailureResult[]> {
  const results: ChronicFailureResult[] = [];
  const threshold = chronicErrorThreshold();
  if (threshold <= 0) return results;
  try {
    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const now = Date.now();
    const staleMs = staleWindowMs();
    const allRows = await sql<AutoloopStateRow[]>`
      SELECT s.harness_slug, s.role, s.consecutive_errors, s.last_status, s.last_fired_at,
             r.active AS routine_active, r.target_owner_id AS routine_target_owner_id
        FROM harness_shared.autoloop_state s
   LEFT JOIN harness_shared.routines r
          ON r.name = s.role AND r.workspace_id = s.workspace_id
       WHERE s.workspace_id = ${workspaceId}
         AND s.consecutive_errors >= ${threshold}`;
    // EI-12429: a Red Queen vaccination-drill row (a synthetic `red-queen-sandbox` artifact the
    // drill harness plants, detects, heals and cleans up itself) is never a real chronic failure.
    // Report it as skipped-drill (checked FIRST, mirroring selectChronicFailures) so the loop-arm/
    // paused/stale buckets below never double-report the planted row.
    const drillSkipped = allRows.filter((r) => r.consecutive_errors >= threshold && isRedQueenDrillRow(r));
    // EI-6727: an ephemeral loop:arm OWNER loop (routine.target_owner_id non-null) is
    // owner-witnessed AND auto-terminated by the reconcile dead-owner guard, which fires its
    // OWN dedicated escalation — so the chronic sweep escalating it is a premature duplicate.
    // Report it as skipped-loop-arm (checked after the drill guard, mirroring selectChronicFailures)
    // so the paused/stale buckets below never double-report the same row.
    const loopArmSkipped = allRows.filter(
      (r) => r.consecutive_errors >= threshold && !isRedQueenDrillRow(r) && isLoopArmOwnerLoop(r),
    );
    const pausedSkipped = allRows.filter(
      (r) =>
        r.consecutive_errors >= threshold &&
        !isRedQueenDrillRow(r) &&
        !isLoopArmOwnerLoop(r) &&
        r.routine_active === false,
    );
    // EI-6765: a breaching, non-paused row whose last fire is older than the staleness
    // window is a FROZEN watermark (orphaned/renamed slug that stopped firing), not a
    // live chronic failure — report it as skipped-stale for observability, never escalate.
    const staleSkipped = allRows.filter(
      (r) =>
        r.consecutive_errors >= threshold &&
        !isRedQueenDrillRow(r) &&
        !isLoopArmOwnerLoop(r) &&
        r.routine_active !== false &&
        isStaleWatermark(r, now, staleMs),
    );
    const breaches = selectChronicFailures(allRows, threshold, { now, staleMs });
    for (const d of drillSkipped) {
      results.push({
        harnessSlug: d.harness_slug,
        role: d.role,
        outcome: 'skipped-drill',
        reason: `red-queen vaccination-drill row (harness ${d.harness_slug}) — planted/detected/healed/cleaned by the drill harness itself, not a live chronic failure`,
      });
    }
    for (const l of loopArmSkipped) {
      results.push({
        harnessSlug: l.harness_slug,
        role: l.role,
        outcome: 'skipped-loop-arm',
        reason: `loop:arm owner loop (owner ${l.routine_target_owner_id}) — auto-terminated by the reconcile dead-owner guard with its own escalation, not a sweep-escalatable chronic failure`,
      });
    }
    for (const p of pausedSkipped) {
      results.push({
        harnessSlug: p.harness_slug,
        role: p.role,
        outcome: 'skipped-paused',
        reason: `routine already auto-paused (active:false) — resolved, not a live chronic failure`,
      });
    }
    for (const s of staleSkipped) {
      results.push({
        harnessSlug: s.harness_slug,
        role: s.role,
        outcome: 'skipped-stale',
        reason: `no fire within ${Math.round(staleMs / 3_600_000)}h (last_fired_at ${s.last_fired_at ?? 'null'}) — frozen watermark, not a live chronic failure`,
      });
    }
    for (const b of breaches) {
      try {
        const source = 'autoloop-chronic' as const;
        const installSlug = `${b.harness_slug}::${b.role}`;
        const alreadyFired = (await recentWatchdogFires(workspaceId, installSlug, 24, source)) > 0;
        if (alreadyFired) {
          results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'debounced', reason: 'escalated within 24h' });
          continue;
        }
        const reason = `${autoloopRowIdentity(b, workspaceId)}: ${b.consecutive_errors} consecutive errors — last_status: ${(b.last_status ?? '').slice(0, 200)}`;
        // EI-6777: the `alreadyFired` read above is a cheap, racy pre-check —
        // multiple concurrent sweep ticks/processes can all observe "not fired
        // yet" before any of them records a fire. Atomically re-check + claim
        // the debounce slot right before the one-time escalation side effect
        // so only one racer ever proceeds to captureImprovement below.
        const claimedFire = await claimWatchdogFire({ workspaceId, installSlug, source, windowHours: 24, reason, wakeAt: null });
        if (!claimedFire) {
          results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'debounced', reason: 'escalated within 24h (raced)' });
          continue;
        }
        const { captureImprovement } = await import('../improvements/capture-core');
        await captureImprovement({
          title: `CHRONIC autoloop failure: ${autoloopRowIdentity(b, workspaceId)} red ${b.consecutive_errors} consecutive fires`,
          kind: 'bug',
          severity: 'major',
          body:
            `${reason}\n\nThe fire-gate backoff is slowing this cycle but nothing was surfacing it — ` +
            `a chronically-red autoloop row is dead capability (the gym ran 12 days dead this way, WI plan ` +
            `gym-unwedge-scout-novelty-2026-07-02). Read the recorded last_status verbatim FIRST ` +
            `(runbook driving-the-autonomous-hive-loop), fix the root cause, then autoloop:control reset-errors.`,
          scope: `harness:${b.harness_slug}`,
          foundDuring: 'autoloop-chronic-failure sweep (routines tick)',
        });
        // claimWatchdogFire already recorded the fire atomically above —
        // no separate recordFire call here (that was the race this closes).
        //
        // WI-4632 (GYM-2, generalized): filing the observation alone is a mailbox drop into a
        // triage pipeline nobody may read for hours — the exact failure mode that let the gym
        // cycle sit 12 days dead. Also request an immediate OVERWATCH wake (the autonomous
        // system-health supervisor, a peer to the Mug) through the existing B-07↔B-04 seam
        // (overwatch/wake-bridge.ts) — the SAME primitive `kettle:start` uses for "wake it now".
        // Fail-soft by construction: `requestOverwatchWake` never throws (unwired B-04 or the
        // papercusp-overwatch flag off both degrade to a harmless no-op — the loop's own launch
        // action self-gates on the flag + the started bit), and a resolution failure (no concrete
        // pot-home harness for a '*'-scoped row, no PAPERCUSP_POT_HOME_SLUG) just skips the wake —
        // never blocks or un-escalates the already-filed, durable observation above.
        let overwatchWaked = false;
        try {
          const { requestOverwatchWake } = await import('../../overwatch/wake-bridge');
          const { resolvePotHomeSlug } = await import('../../pot/wake');
          const wakeHarness = resolvePotHomeSlug(b.harness_slug, undefined);
          if (wakeHarness) {
            const wake = await requestOverwatchWake({
              reason: `CHRONIC autoloop failure: ${autoloopRowIdentity(b, workspaceId)} red ${b.consecutive_errors} consecutive fires — survey + unwedge (observation filed; read its last_status verbatim first)`,
              harness: wakeHarness,
              workspaceId,
            });
            overwatchWaked = wake.wired === true && !wake.error;
          }
        } catch (e) {
          console.warn(`[autoloop-chronic] overwatch wake failed (observation still filed): ${e instanceof Error ? e.message : e}`);
        }
        results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'escalated', reason, overwatchWaked });
      } catch (e) {
        results.push({
          harnessSlug: b.harness_slug,
          role: b.role,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[autoloop-chronic] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

/**
 * EI-12968: should THIS sweep tick's console.warn actually print, for one result?
 *
 * The sweep re-derives each row's outcome correctly on every ~30s tick — that
 * decision needs no debouncing, it's cheap and always accurate. But a `skipped-*`
 * outcome (skipped-stale/skipped-paused/skipped-drill/skipped-loop-arm) describes
 * a condition that can persist INDEFINITELY once true (a frozen watermark never
 * un-freezes itself, per staleWindowMs()'s own docs) — so logging it unconditionally
 * every tick means one still-true condition floods the journal forever (measured:
 * ~60k duplicate "skipped-stale: kettle@papercup (frozen watermark)" lines since
 * the condition first appeared, burying real errors). The LOG LINE is what needs
 * rate-limiting, not the sweep's decision or its returned results — every OTHER
 * caller of autoloopChronicFailureSweep() still sees the full, accurate, un-throttled
 * result set every tick; only this console.warn gate is new.
 *
 * `escalated`/`debounced`/`error` are NEVER rate-limited here: `escalated` is
 * already deduped 24h upstream (via claimWatchdogFire in the sweep itself) so it's
 * inherently rare; `debounced` never reaches this function (the caller already
 * skips it, as before this fix); `error` deserves visibility every occurrence.
 *
 * Reuses the SAME watchdog-fires ledger + atomic claim primitive the sweep's own
 * escalation debounce uses (claimWatchdogFire) — a distinct `source` tag
 * ('autoloop-chronic-skip-log') so this log-throttling concern can never collide
 * with the escalation debounce's 24h window. Keyed by (outcome, harness, role) —
 * a TRANSITION (e.g. skipped-stale → escalated → skipped-stale) still gets its
 * own fresh log line via claimWatchdogFire's normal window semantics, it does not
 * stay silenced forever from one earlier claim.
 */
/**
 * EI-19281872822982156: the CHRONIC sweep above is entirely ERROR-STREAK-DRIVEN
 * (`WHERE consecutive_errors >= threshold`) — a role that stops firing while
 * reporting `last_status:'ok'` and `consecutive_errors:0` is NEVER a candidate,
 * no matter how long it sits dead. Measured live: `autoloop_state` role='kettle'
 * harness='papercusp' sat 7 DAYS past its last fire with 0 errors — invisible to
 * this module's own frozen-watermark guard (`isStaleWatermark`/`staleSkipped`
 * above), because that guard only ever runs on rows that already breached the
 * error threshold. `autoloop:status` confirmed the fire-GATE itself was healthy
 * (nothing was blocking a fire); nothing was calling it — a cadence/liveness
 * gap, not a broken circuit.
 *
 * This is the SIBLING sweep that closes it: independent of `consecutive_errors`,
 * any row (fixed system role, not a loop:arm owner loop, not a drill row, not
 * already explicitly paused — `routine_active === false` is the STALE-PAUSED-
 * ROUTINES alarm's job, `system-health/compute.ts`'s `computeStalePausedRoutines`,
 * not this one) whose `last_fired_at` is older than `silentStopThresholdMs()`
 * warrants its own escalation. Deliberately EXCLUDES any row already at/over the
 * chronic-error threshold — those are the CHRONIC sweep's job (including its
 * own frozen-watermark suppression, EI-6765), so a row that is BOTH erroring
 * and long-frozen is never double-escalated under a second name here.
 */
export function silentStopThresholdMs(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS ?? 24 * 60 * 60 * 1000);
  return Number.isFinite(n) ? n : 24 * 60 * 60 * 1000;
}

function lastFiredAtMs(row: Pick<AutoloopStateRow, 'last_fired_at'>): number {
  const raw = row.last_fired_at;
  if (raw == null) return 0;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** PURE: will the CHRONIC sweep ACTUALLY escalate this row? Mirrors
 *  `selectChronicFailures` exactly: it escalates only a row that BOTH breaches
 *  the error threshold AND is not a frozen watermark. A breaching row that is
 *  frozen is deliberately SUPPRESSED there as `skipped-stale` and escalated by
 *  nobody — so deferring to the chronic sweep on it protects nothing.
 *
 *  EI-19908775413647773: the silent-stop sweep used to defer on the chronic
 *  sweep's SCOPE (`consecutive_errors >= threshold`) rather than on its actual
 *  OUTPUT, which opened a seam nothing covered — `errors >= threshold AND
 *  silent > staleWindowMs()` escalated by neither. papercup::kettle sat in it
 *  at exactly threshold, 44 days dead, logged `skipped-stale` 52 times and
 *  alarmed zero times. Note the seam opened at staleWindowMs() (6h), not at
 *  silentStopThresholdMs() (24h), because the two sweeps use different
 *  staleness constants — and since 24h > 6h, EVERY row this sweep's own query
 *  returns is already frozen from the chronic sweep's point of view, so the
 *  old exclusion could only ever create the hole, never prevent a
 *  double-escalation. */
function chronicSweepWillEscalate(
  row: AutoloopStateRow,
  threshold: number,
  now: number,
  chronicStaleMs: number,
): boolean {
  return row.consecutive_errors >= threshold && !isStaleWatermark(row, now, chronicStaleMs);
}

/** PURE: which rows have SILENTLY STOPPED — stale beyond `silentStopMs`,
 *  EXCLUDING (a) a row the chronic sweep WILL ACTUALLY ESCALATE (breaching AND
 *  not frozen — never double-escalate the same row under two mechanisms; a row
 *  it merely SUPPRESSES is ours, per `chronicSweepWillEscalate` above); (b) a
 *  Red Queen drill row; (c) a loop:arm owner loop (owner-witnessed, its own
 *  dead-owner escalation); (d) an already explicitly-paused routine
 *  (`routine_active: false` — the stale-paused-routines alarm's job, not this
 *  one); or (e) a `gym-cycle` row without a matching currently eligible gym
 *  autoloop config. A legitimate no-eligible tick advances the scheduled
 *  routine heartbeat without advancing this per-harness fire watermark.
 *  `null`/absent `last_fired_at` never matches (nothing to measure a
 *  silence FROM), and `routine_active: null` (no matching routines row — a
 *  fixed system role with no `loop:arm`-materialized row) is NOT excluded —
 *  fail-open, matching every other predicate in this module. Sorted
 *  most-overdue (oldest last-fire) first. */
export function selectSilentlyStoppedRoles(
  rows: readonly AutoloopStateRow[],
  threshold: number,
  opts?: { now?: number; silentStopMs?: number; chronicStaleMs?: number },
): AutoloopStateRow[] {
  const silentStopMs = opts?.silentStopMs ?? silentStopThresholdMs();
  if (silentStopMs <= 0) return [];
  const now = opts?.now ?? Date.now();
  const chronicStaleMs = opts?.chronicStaleMs ?? staleWindowMs();
  return rows
    .filter(
      (r) =>
        !chronicSweepWillEscalate(r, threshold, now, chronicStaleMs) &&
        !isRedQueenDrillRow(r) &&
        !isLoopArmOwnerLoop(r) &&
        r.routine_active !== false &&
        (r.role !== 'gym-cycle' || r.gym_cycle_eligible === true) &&
        isStaleWatermark(r, now, silentStopMs),
    )
    .sort((a, b) => lastFiredAtMs(a) - lastFiredAtMs(b));
}

export interface SilentStopResult {
  harnessSlug: string;
  role: string;
  outcome: 'escalated' | 'debounced' | 'error';
  reason: string;
  /** Same B-07↔B-04 seam the chronic sweep uses (WI-4632) — see its doc for the
   *  fail-soft contract (an unwired waker / unresolvable pot-home never blocks
   *  or un-escalates the already-filed observation). */
  overwatchWaked?: boolean;
}

/**
 * The sweep. Independent kill switch (`PAPERCUSP_AUTOLOOP_SILENT_STOP_MS <= 0`
 * disables it without touching `autoloopChronicFailureSweep`'s own threshold).
 * Fail-soft by contract; debounced 24h per (harness, role) via the SAME
 * `hive_watchdog_fires` ledger the chronic sweep uses, under a DISTINCT
 * `source` tag ('autoloop-silent-stop') so the two debounce windows can never
 * collide or mask each other.
 */
export async function autoloopSilentStopSweep(): Promise<SilentStopResult[]> {
  const results: SilentStopResult[] = [];
  const silentStopMs = silentStopThresholdMs();
  if (silentStopMs <= 0) return results;
  try {
    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const now = Date.now();
    const threshold = chronicErrorThreshold();
    const allRows = await sql<AutoloopStateRow[]>`
      SELECT s.harness_slug, s.role, s.consecutive_errors, s.last_status, s.last_fired_at,
             r.active AS routine_active, r.target_owner_id AS routine_target_owner_id,
             g.enabled AS gym_autoloop_enabled, g.status AS gym_autoloop_status,
             g.budget_usd AS gym_autoloop_budget_usd, g.spent_usd AS gym_autoloop_spent_usd
        FROM harness_shared.autoloop_state s
   LEFT JOIN harness_shared.routines r
          ON r.name = s.role AND r.workspace_id = s.workspace_id
   LEFT JOIN harness_shared.gym_autoloop_config g
          ON s.role = 'gym-cycle' AND g.harness_slug = s.harness_slug AND g.workspace_id = s.workspace_id
       WHERE s.workspace_id = ${workspaceId}
         AND s.last_fired_at IS NOT NULL
         AND s.last_fired_at < now() - make_interval(secs => ${Math.floor(silentStopMs / 1000)})`;
    const budgetFloorUsd = gymBudgetFloorUsd();
    const silent = selectSilentlyStoppedRoles(
      allRows.map((row) => ({
        ...row,
        gym_cycle_eligible:
          row.role === 'gym-cycle' &&
          isEligibleAutoloop(
            {
              enabled: row.gym_autoloop_enabled === true,
              status: row.gym_autoloop_status ?? '',
              budgetUsd: row.gym_autoloop_budget_usd ?? null,
              spentUsd: row.gym_autoloop_spent_usd ?? 0,
            },
            budgetFloorUsd,
          ),
      })),
      threshold,
      { now, silentStopMs },
    );
    for (const s of silent) {
      try {
        const source = 'autoloop-silent-stop' as const;
        const installSlug = `${s.harness_slug}::${s.role}`;
        const alreadyFired = (await recentWatchdogFires(workspaceId, installSlug, 24, source)) > 0;
        if (alreadyFired) {
          results.push({ harnessSlug: s.harness_slug, role: s.role, outcome: 'debounced', reason: 'escalated within 24h' });
          continue;
        }
        const ageHours = Math.round((now - lastFiredAtMs(s)) / 3_600_000);
        const reason =
          `${autoloopRowIdentity(s, workspaceId)}: no fire in ${ageHours}h despite consecutive_errors=${s.consecutive_errors} ` +
          `(last_status: ${(s.last_status ?? '').slice(0, 160)}) — a cleanly-stopped role, invisible to the ` +
          `error-streak-driven chronic-failure sweep (EI-19281872822982156).`;
        // EI-6777-style single-flight: atomically re-check + claim the debounce slot
        // right before the one-time escalation side effect (mirrors the chronic sweep).
        const claimedFire = await claimWatchdogFire({ workspaceId, installSlug, source, windowHours: 24, reason, wakeAt: null });
        if (!claimedFire) {
          results.push({ harnessSlug: s.harness_slug, role: s.role, outcome: 'debounced', reason: 'escalated within 24h (raced)' });
          continue;
        }
        const { captureImprovement } = await import('../improvements/capture-core');
        await captureImprovement({
          title: `SILENTLY STOPPED autoloop role: ${autoloopRowIdentity(s, workspaceId)} — no fire in ${ageHours}h, ${s.consecutive_errors} errors`,
          kind: 'bug',
          severity: 'major',
          body:
            `${reason}\n\nThis role's fire-clock stopped advancing while its own error bookkeeping looked healthy — ` +
            `an error-streak-driven watchdog can never see this class of failure. Check whether the routine driving ` +
            `it is still scheduled (routines:list), whether its process/executor is alive, and whether it was ` +
            `silently unscheduled/orphaned (a rename, a migration, a one-time misfire).`,
          scope: `harness:${s.harness_slug}`,
          foundDuring: 'autoloop-silent-stop sweep (routines tick)',
        });
        let overwatchWaked = false;
        try {
          const { requestOverwatchWake } = await import('../../overwatch/wake-bridge');
          const { resolvePotHomeSlug } = await import('../../pot/wake');
          const wakeHarness = resolvePotHomeSlug(s.harness_slug, undefined);
          if (wakeHarness) {
            const wake = await requestOverwatchWake({
              reason: `SILENTLY STOPPED autoloop role: ${autoloopRowIdentity(s, workspaceId)} — no fire in ${ageHours}h (observation filed; read its last_status verbatim first)`,
              harness: wakeHarness,
              workspaceId,
            });
            overwatchWaked = wake.wired === true && !wake.error;
          }
        } catch (e) {
          console.warn(`[autoloop-silent-stop] overwatch wake failed (observation still filed): ${e instanceof Error ? e.message : e}`);
        }
        results.push({ harnessSlug: s.harness_slug, role: s.role, outcome: 'escalated', reason, overwatchWaked });
      } catch (e) {
        results.push({
          harnessSlug: s.harness_slug,
          role: s.role,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[autoloop-silent-stop] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

export async function shouldLogChronicOutcome(
  r: Pick<ChronicFailureResult, 'harnessSlug' | 'role' | 'outcome'>,
  opts: { workspaceId?: string; windowHours?: number } = {},
): Promise<boolean> {
  if (!r.outcome.startsWith('skipped-')) return true;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const installSlug = `${r.outcome}::${r.harnessSlug}::${r.role}`;
  return claimWatchdogFire({
    workspaceId,
    installSlug,
    source: 'autoloop-chronic-skip-log',
    reason: `rate-limited observability log line (${r.outcome})`,
    wakeAt: null,
    windowHours: opts.windowHours ?? 1,
  });
}
