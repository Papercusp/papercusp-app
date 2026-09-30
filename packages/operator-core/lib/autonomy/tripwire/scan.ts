/**
 * tripwire/scan.ts — the autonomy TRUST sweep (queen-autonomy-policy-2026-06-13
 * B-16 / P-080, P-081, P-082). One cadence does two legs over the tripwire
 * ledger:
 *
 *   1. TRIPWIRE SWEEP (P-080/P-081): load every armed tripwire, evaluate its
 *      watch window against the outcome rails (gym regression · EKG drift ·
 *      validator bounce · owner thumbs-down). On a hit → TRIP: auto-revert the
 *      action (via the injected executor), demote the category one step, notify.
 *      On a clean window close → CLEAR (one clean auto-pass for graduation).
 *   2. GRADUATION (P-082): recount trailing clean passes per (category, class)
 *      from the ledger, raise each category's `graduated_level` WITHIN its
 *      ceiling (the store clamps), and file an owner "graduation-eligible" report
 *      per newly eligible (category, class) tier. Never raises a ceiling (owner
 *      authority — the report is the ask).
 *
 * GATED on `papercusp-queen-autonomy-armed` (P-092): unarmed ⇒ the scan is a
 * no-op (and there are no tripwire rows anyway, since nothing auto-decides
 * unarmed) — so arming autonomy is the SINGLE switch that lights the trust loop.
 * Behavior-neutral until then (D-007).
 *
 * Deps are injectable so unit tests drive the whole sweep with fakes; live
 * defaults bind PG + the policy store + capture rail. Mirrors
 * graduation/scan-loop.ts.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { Sql } from 'postgres';
import type { AutonomyCeiling } from '@papercusp/plan-parser';
import type { AutonomyCategory } from '../categories';
import type { AutonomyCategoryPolicy } from '../policy';
import {
  armTripwire,
  demoteGraduatedLevel,
  evaluateTripwire,
  type ArmTripwireResult,
  type RevertHandle,
  type TripwireSignalKind,
  type TripwireWatchSignal,
} from './core';
import type { AutonomyDecision } from '../decider';
import {
  getTripwire,
  insertTripwire,
  listArmedTripwires,
  listRecentlyRevertedTripwires,
  markTripwireCleared,
  markTripwireReverted,
  markTripwireTripped,
  readTripwireEvidence,
  type TripwireRow,
} from './store';
import {
  buildAutonomyGraduationReport,
  computeAutonomyStandings,
  computeCategoryGraduationTargets,
  DEFAULT_AUTONOMY_GRADUATION_POLICY,
  parseGradKey,
  type AutonomyGraduationPolicy,
} from './graduation';

const DAY_MS = 86_400_000;

/** The result of attempting to undo a tripped action. */
export interface RevertOutcome {
  reverted: boolean;
  note: string;
}

/** Injectable IO for the sweep — fakes in tests, live PG defaults in prod. */
export interface AutonomyTrustScanDeps {
  /** Is autonomy armed? (the P-092 flag). Default: the live getFlag. */
  isArmed: () => Promise<boolean>;
  /** Load armed tripwires (the sweep set). */
  listArmed: () => Promise<TripwireRow[]>;
  /** Gather watch signals observed since `sinceMs` (gym/EKG/validator). */
  gatherSignals: (sinceMs: number) => Promise<{ signals: TripwireWatchSignal[]; legs: SignalLegs }>;
  /** Execute the auto-revert for a tripped row (interprets revert_handle). */
  executeRevert: (row: TripwireRow) => Promise<RevertOutcome>;
  /** Mark a row cleared / tripped / reverted. */
  markCleared: (id: string, nowMs: number) => Promise<void>;
  markTripped: (id: string, reason: TripwireSignalKind, nowMs: number, by?: string) => Promise<void>;
  markReverted: (id: string, nowMs: number) => Promise<void>;
  /** Read the full tripwire evidence for graduation. */
  readEvidence: (opts: { lookbackDays: number; nowMs: number }) => Promise<TripwireRow[]>;
  /** Read successful reverts in the damper's wall-clock window. */
  listRecentlyReverted: (sinceMs: number) => Promise<TripwireRow[]>;
  /** Durable quarantine + synthesis write for one repeated work-item cohort. */
  quarantineRevertLoop: (input: RevertLoopQuarantineInput) => Promise<RevertLoopQuarantineOutcome>;
  /** Read one category's policy (ceiling / graduated_level / locked / pin). */
  readPolicy: (category: AutonomyCategory) => Promise<AutonomyCategoryPolicy>;
  /** Write a category's graduated_level (clamped ≤ ceiling by the store). */
  writeGraduatedLevel: (category: AutonomyCategory, level: AutonomyCeiling, reason: string) => Promise<void>;
  /** File an owner-facing report/alert via the existing rail. Return true if filed. */
  notify: (input: NotifyInput) => Promise<boolean>;
  nowMs: () => number;
}

export interface SignalLegs {
  gym: boolean;
  ekg: boolean;
  validator: boolean;
}

export interface NotifyInput {
  kind: 'tripped' | 'graduation-eligible';
  title: string;
  body: string;
  /** Dedup key — a tripped alert per row, a graduation report per (class, tier). */
  watchdogKey: string;
  category: AutonomyCategory;
}

export interface AutonomyTrustScanOptions extends AutonomyGraduationPolicy {
  /** Evidence lookback for graduation + signal gathering (days). */
  lookbackDays: number;
  /** Cap on graduation reports filed per tick. */
  maxReportsPerTick: number;
  /** Compute + log, mutate nothing (supervised dry mode). */
  mineOnly: boolean;
  /** Successful reverts of one work-item required before durable quarantine. */
  revertLoopThreshold: number;
  /** Wall-clock window for the successful-revert count. */
  revertLoopWindowDays: number;
}

export const DEFAULT_AUTONOMY_TRUST_SCAN_OPTIONS: AutonomyTrustScanOptions = {
  ...DEFAULT_AUTONOMY_GRADUATION_POLICY,
  lookbackDays: 90,
  maxReportsPerTick: 3,
  mineOnly: false,
  revertLoopThreshold: 3,
  revertLoopWindowDays: 7,
};

export function autonomyTrustScanOptionsFromPayload(payload: unknown): AutonomyTrustScanOptions {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const num = (k: string, fb: number): number =>
    typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : fb;
  const d = DEFAULT_AUTONOMY_TRUST_SCAN_OPTIONS;
  return {
    threshold: Math.max(1, num('threshold', d.threshold)),
    recurrenceWindowDays: Math.max(1, num('recurrenceWindowDays', d.recurrenceWindowDays)),
    lookbackDays: Math.max(1, num('lookbackDays', d.lookbackDays)),
    maxReportsPerTick: Math.max(0, num('maxReportsPerTick', d.maxReportsPerTick)),
    mineOnly: p.mineOnly === true,
    revertLoopThreshold: Math.max(2, Math.floor(num('revertLoopThreshold', d.revertLoopThreshold))),
    revertLoopWindowDays: Math.max(1, num('revertLoopWindowDays', d.revertLoopWindowDays)),
  };
}

export interface TripwireSweepResult {
  armed: number;
  cleared: number;
  tripped: number;
  reverted: number;
  legs: SignalLegs;
  /** Per-tripped row: which category demoted and to what. */
  demotions: { category: AutonomyCategory; from: AutonomyCeiling; to: AutonomyCeiling; reverted: boolean }[];
}

/**
 * Leg 1: evaluate every armed tripwire. Earliest matching signal in-window trips
 * it → revert + demote + notify; a clean window close clears it. Idempotent: a
 * replay re-reads armed rows (cleared/tripped rows are already out of the set).
 */
export async function runAutonomyTripwireSweep(
  deps: AutonomyTrustScanDeps,
  opts: AutonomyTrustScanOptions,
): Promise<TripwireSweepResult> {
  const nowMs = deps.nowMs();
  const armedRows = await deps.listArmed();
  const { signals, legs } = await deps.gatherSignals(nowMs - opts.lookbackDays * DAY_MS);

  let cleared = 0;
  let tripped = 0;
  let reverted = 0;
  const demotions: TripwireSweepResult['demotions'] = [];

  for (const row of armedRows) {
    const verdict = evaluateTripwire(row, signals, nowMs);
    if (verdict.outcome === 'still-armed') continue;
    if (verdict.outcome === 'cleared') {
      if (!opts.mineOnly) await deps.markCleared(row.id, nowMs);
      cleared += 1;
      continue;
    }
    // tripped — the safety path: record the trip, revert, demote, notify.
    tripped += 1;
    if (opts.mineOnly) continue;
    await deps.markTripped(row.id, verdict.reason, nowMs);

    // Auto-revert (best-effort — the executor is the Queen execution seam).
    let revertOk = false;
    try {
      const outcome = await deps.executeRevert(row);
      revertOk = outcome.reverted;
      if (revertOk) {
        await deps.markReverted(row.id, nowMs);
        reverted += 1;
      }
    } catch (e) {
      console.warn(`[autonomy-trust] revert FAILED for ${row.id}:`, e instanceof Error ? e.message : e);
    }

    // Demote the category one step (immediate safety; the graduation leg below
    // reconciles to the evidence-consistent level). Honors locked/pin via the
    // policy read; a protected category never had an auto-decision, so this is
    // belt-and-braces.
    const policy = await deps.readPolicy(row.category);
    const from = policy.graduatedLevel;
    const to = demoteGraduatedLevel(from);
    const pinned = policy.ownerOverride != null && (policy.ownerOverride as { pinned?: unknown }).pinned === true;
    // The demote is a SAFETY action and ALWAYS fires on a trip. An owner ceiling
    // PIN (ownerOverride.pinned) freezes the graduation RAISE (the graduation leg
    // below), but must NEVER disable this safety demote (EI-513 /
    // relight-self-learning-edges D-003) — a Queen pinned for a stable go-live must
    // still shrink its autonomy when a tripwire trips. `locked` (a protected/owner-
    // locked category) is already never-auto-effective, so a demote there is moot;
    // gated only to skip a no-op write.
    if (!policy.locked && to !== from) {
      await deps.writeGraduatedLevel(
        row.category,
        to,
        `tripwire trip (${verdict.reason}) on ${row.id}${pinned ? ' [ceiling pinned — safety demote still applied]' : ''}`,
      );
    }
    demotions.push({ category: row.category, from, to, reverted: revertOk });

    await deps.notify({
      kind: 'tripped',
      category: row.category,
      title: `Autonomy tripwire TRIPPED: '${row.category}' / '${row.findingClass}' (${verdict.reason})`,
      body:
        `An auto-decided REVERSIBLE action tripped its watch (${verdict.reason}: ${verdict.signal.label}).\n\n` +
        `- Action: \`${row.action ?? '—'}\` · category \`${row.category}\` · class \`${row.findingClass}\`\n` +
        `- Auto-revert: ${revertOk ? 'executed' : 'NOT executed (no executor wired / failed) — manual revert may be needed'}\n` +
        `- Graduation demoted: \`${from}\` → \`${to}\`${policy.locked ? ' (skipped: category locked)' : pinned ? ' (ceiling pinned — safety demote still applied)' : ''}\n` +
        `- Revert handle: \`${JSON.stringify(row.revertHandle)}\`\n\n` +
        `Tripwire ${row.id} (queen-autonomy-policy P-081 / D-006).`,
      watchdogKey: `autonomy-tripwire-trip:${row.id}`,
    });
  }

  return { armed: armedRows.length, cleared, tripped, reverted, legs, demotions };
}

export interface GraduationLegResult {
  classes: number;
  raised: { category: AutonomyCategory; from: AutonomyCeiling; to: AutonomyCeiling }[];
  eligible: string[];
  filed: string[];
}

/**
 * Leg 2: recompute graduation standings from the ledger, raise each category's
 * graduated_level to its evidence-earned level (within the ceiling), and file an
 * owner report per newly eligible (category, class) tier. Idempotent: the write
 * is a no-op when already at the earned level; the report dedups on its tier key.
 */
export async function runAutonomyGraduationLeg(
  deps: AutonomyTrustScanDeps,
  opts: AutonomyTrustScanOptions,
): Promise<GraduationLegResult> {
  const nowMs = deps.nowMs();
  const rows = await deps.readEvidence({ lookbackDays: opts.lookbackDays, nowMs });
  const standings = computeAutonomyStandings(rows, opts, nowMs);

  // Build the per-category policy map the target computation needs.
  const categories = [...new Set(standings.map((s) => parseGradKey(s.findingClass).category))];
  const policyMap = new Map<AutonomyCategory, AutonomyCategoryPolicy>();
  for (const c of categories) policyMap.set(c, await deps.readPolicy(c));

  const targets = computeCategoryGraduationTargets(standings, policyMap, opts);
  const raised: GraduationLegResult['raised'] = [];
  if (!opts.mineOnly) {
    for (const t of targets) {
      if (t.shouldWrite) {
        await deps.writeGraduatedLevel(t.category, t.targetGraduatedLevel, `graduation: ${t.reason}`);
        raised.push({ category: t.category, from: t.currentGraduatedLevel, to: t.targetGraduatedLevel });
      }
    }
  }

  // File reports for newly eligible classes (most-evidenced first).
  const eligible = standings.filter((s) => s.eligible);
  const filed: string[] = [];
  if (!opts.mineOnly) {
    for (const s of eligible.slice(0, opts.maxReportsPerTick)) {
      const { category } = parseGradKey(s.findingClass);
      const policy = policyMap.get(category);
      const report = buildAutonomyGraduationReport(s, policy?.ceiling ?? 'never-auto', opts);
      const ok = await deps.notify({
        kind: 'graduation-eligible',
        category,
        title: report.title,
        body: report.body,
        watchdogKey: report.watchdogKey,
      });
      if (ok) filed.push(report.watchdogKey);
    }
  }

  return {
    classes: standings.length,
    raised,
    eligible: eligible.map((s) => s.findingClass),
    filed,
  };
}

export interface AutonomyTrustScanOutcome {
  ran: boolean;
  skipReason?: 'not-armed';
  sweep?: TripwireSweepResult;
  damper?: RevertLoopDamperResult;
  graduation?: GraduationLegResult;
}

export interface RevertLoopQuarantineInput {
  itemId: string;
  harness?: string;
  rows: TripwireRow[];
  threshold: number;
  windowDays: number;
  nowMs: number;
}

export interface RevertLoopQuarantineOutcome {
  quarantined: boolean;
  alreadyQuarantined: boolean;
  cohortKey?: string;
}

export interface RevertLoopDamperResult {
  successfulReverts: number;
  repeatedItems: number;
  quarantined: string[];
  alreadyQuarantined: string[];
}

interface RevertLoopMarker {
  version: 1;
  cohortKey: string;
  appliedAt: string;
  threshold: number;
  windowDays: number;
  tripwireIds: string[];
  source: 'autonomy-trust-scan';
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workItemTarget(row: TripwireRow): { itemId: string; harness?: string } | null {
  const handle = record(row.revertHandle);
  if (handle.kind !== 'work-item-state' && handle.kind !== 'work-item-priority') return null;
  const itemId = typeof handle.id === 'string' ? handle.id.trim() : '';
  if (!itemId) return null;
  const harness = typeof handle.harness === 'string' && handle.harness.trim() ? handle.harness.trim() : undefined;
  return { itemId, ...(harness ? { harness } : {}) };
}

function markerFrom(payload: unknown): RevertLoopMarker | null {
  const raw = record(record(payload)._revertLoopDamper);
  if (raw.version !== 1 || typeof raw.cohortKey !== 'string' || typeof raw.appliedAt !== 'string') return null;
  return raw as unknown as RevertLoopMarker;
}

function renderRevertLoopBrief(input: RevertLoopQuarantineInput, cohort: TripwireRow[], cohortKey: string): string {
  const evidence = cohort
    .map((row) => {
      const at = row.revertedAtMs == null ? 'unknown-time' : new Date(row.revertedAtMs).toISOString();
      return `- \`${row.id}\` at ${at}: \`${row.action ?? row.findingClass}\` · ${row.tripReason ?? 'unknown-signal'} · \`${row.revertHandle.kind}\``;
    })
    .join('\n');
  return (
    `### Revert-loop damper — AUTO-QUARANTINED\n\n` +
    `[revert-loop-damper:${cohortKey}]\n\n` +
    `This item had ${cohort.length} successful automatic reverts within ${input.windowDays} days ` +
    `(threshold ${input.threshold}). It is durably parked out of self-selection until a reviewer ` +
    `synthesizes a safer next attempt.\n\n` +
    `Evidence:\n${evidence}\n\n` +
    `Synthesis prompt: compare the reverted actions and trip reasons, identify the shared invalid ` +
    `assumption or unstable precondition, then revise the approach before clearing the claim hold. ` +
    `Do not retry the same automation unchanged.`
  );
}

export interface RevertLoopQuarantineIo {
  getWorkItem: (id: string, harness?: string) => Promise<{ payload: unknown } | null>;
  getThreadWindow: (id: string, limit: number, harness?: string) => Promise<{ posts: { body: string }[] } | null>;
  setClaimHold: (
    id: string,
    hold: boolean,
    opts: { harness?: string; parkedBy?: string; parkedReason?: string },
  ) => Promise<{ applicable: boolean } | null>;
  comment: (id: string, body: string, author: string, opts: { harness?: string }) => Promise<unknown | null>;
  mergePayload: (id: string, patch: Record<string, unknown>, opts: { harness?: string }) => Promise<unknown | null>;
}

async function liveRevertLoopQuarantineIo(): Promise<RevertLoopQuarantineIo> {
  const wi = await import('../../work-items');
  return {
    getWorkItem: wi.getWorkItem,
    getThreadWindow: wi.getWorkItemThreadWindow,
    setClaimHold: wi.setWorkItemClaimHold,
    comment: wi.commentWorkItem,
    mergePayload: wi.mergeWorkItemPayload,
  };
}

/** Durable park + synthesis comment, replay-safe through the existing payload/thread surfaces. */
export async function quarantineWorkItemRevertLoop(
  input: RevertLoopQuarantineInput,
  io?: RevertLoopQuarantineIo,
): Promise<RevertLoopQuarantineOutcome> {
  const resolvedIo = io ?? (await liveRevertLoopQuarantineIo());
  const item = await resolvedIo.getWorkItem(input.itemId, input.harness);
  if (!item) return { quarantined: false, alreadyQuarantined: false };
  const payload = record(item.payload);
  const prior = markerFrom(payload);
  const priorAt = prior ? new Date(prior.appliedAt).getTime() : Number.NEGATIVE_INFINITY;
  const held = String(payload._claimHold) === 'true';
  const durablyParkedByDamper = held && payload.claim_hold_by === 'autonomy-trust-scan';
  if (prior && durablyParkedByDamper) {
    return { quarantined: false, alreadyQuarantined: true, cohortKey: prior.cohortKey };
  }

  const eligible = input.rows
    .filter((row) => row.revertedAtMs != null && row.revertedAtMs > priorAt)
    .sort((a, b) => (a.revertedAtMs! - b.revertedAtMs!) || a.id.localeCompare(b.id));
  if (eligible.length < input.threshold) {
    return { quarantined: false, alreadyQuarantined: prior != null, ...(prior ? { cohortKey: prior.cohortKey } : {}) };
  }
  const cohort = eligible.slice(0, input.threshold);
  const cohortKey = `v1:${input.itemId}:${cohort.map((row) => row.id).join('+')}`;
  const threadMarker = `[revert-loop-damper:${cohortKey}]`;

  // `_claimHold` alone is insufficient: it may be a liveness-bound `held_open`
  // lease that the session reaper will lift. Stamp the damper's durable-park
  // provenance unless this exact park is already present.
  if (!durablyParkedByDamper) {
    const applied = await resolvedIo.setClaimHold(input.itemId, true, {
      ...(input.harness ? { harness: input.harness } : {}),
      parkedBy: 'autonomy-trust-scan',
      parkedReason: `revert-loop damper: ${cohort.length} successful reverts in ${input.windowDays}d`,
    });
    if (!applied?.applicable) return { quarantined: false, alreadyQuarantined: false, cohortKey };
  }

  const thread = await resolvedIo.getThreadWindow(input.itemId, 200, input.harness);
  if (!thread?.posts.some((post) => post.body.includes(threadMarker))) {
    const post = await resolvedIo.comment(
      input.itemId,
      renderRevertLoopBrief(input, cohort, cohortKey),
      'autonomy-trust-scan',
      input.harness ? { harness: input.harness } : {},
    );
    if (!post) throw new Error(`revert-loop damper could not write synthesis brief for ${input.itemId}`);
  }

  const marker: RevertLoopMarker = {
    version: 1,
    cohortKey,
    appliedAt: new Date(input.nowMs).toISOString(),
    threshold: input.threshold,
    windowDays: input.windowDays,
    tripwireIds: cohort.map((row) => row.id),
    source: 'autonomy-trust-scan',
  };
  const stamped = await resolvedIo.mergePayload(
    input.itemId,
    { _revertLoopDamper: marker },
    input.harness ? { harness: input.harness } : {},
  );
  if (!stamped) throw new Error(`revert-loop damper could not stamp ${input.itemId}`);
  return { quarantined: true, alreadyQuarantined: false, cohortKey };
}

/** Count successful work-item reverts and quarantine each repeated target once. */
export async function runAutonomyRevertLoopDamper(
  deps: AutonomyTrustScanDeps,
  opts: AutonomyTrustScanOptions,
): Promise<RevertLoopDamperResult> {
  const nowMs = deps.nowMs();
  const sinceMs = nowMs - opts.revertLoopWindowDays * DAY_MS;
  const rows = (await deps.listRecentlyReverted(sinceMs)).filter(
    (row) => row.status === 'reverted' && row.revertedAtMs != null && row.revertedAtMs >= sinceMs,
  );
  const groups = new Map<string, { itemId: string; harness?: string; rows: TripwireRow[] }>();
  for (const row of rows) {
    const target = workItemTarget(row);
    if (!target) continue;
    const key = `${target.harness ?? ''}\u0000${target.itemId}`;
    const group = groups.get(key) ?? { ...target, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const repeated = [...groups.values()].filter((group) => group.rows.length >= opts.revertLoopThreshold);
  const quarantined: string[] = [];
  const alreadyQuarantined: string[] = [];
  if (!opts.mineOnly) {
    for (const group of repeated) {
      const outcome = await deps.quarantineRevertLoop({
        itemId: group.itemId,
        ...(group.harness ? { harness: group.harness } : {}),
        rows: group.rows,
        threshold: opts.revertLoopThreshold,
        windowDays: opts.revertLoopWindowDays,
        nowMs,
      });
      if (outcome.quarantined) quarantined.push(group.itemId);
      else if (outcome.alreadyQuarantined) alreadyQuarantined.push(group.itemId);
    }
  }
  return { successfulReverts: rows.length, repeatedItems: repeated.length, quarantined, alreadyQuarantined };
}

/** The full trust scan: gate on arming, then sweep, then graduation. */
export async function runAutonomyTrustScan(
  deps: AutonomyTrustScanDeps,
  opts: AutonomyTrustScanOptions = DEFAULT_AUTONOMY_TRUST_SCAN_OPTIONS,
): Promise<AutonomyTrustScanOutcome> {
  if (!(await deps.isArmed())) return { ran: false, skipReason: 'not-armed' };
  const sweep = await runAutonomyTripwireSweep(deps, opts);
  const damper = await runAutonomyRevertLoopDamper(deps, opts);
  const graduation = await runAutonomyGraduationLeg(deps, opts);
  return { ran: true, sweep, damper, graduation };
}

// ───────────────────────── live PG-backed deps ─────────────────────────

/** Gather the fleet outcome signals (gym regressions + major EKG shifts) as
 *  GLOBAL signals — a fleet regression in an armed window implicates every
 *  auto-decision of that window (mirrors graduation/evidence.ts's rails). Each
 *  leg is best-effort: a dark/missing rail contributes no signals. */
export async function gatherTripwireSignals(
  sql: Sql,
  workspaceId: string,
  sinceMs: number,
): Promise<{ signals: TripwireWatchSignal[]; legs: SignalLegs }> {
  const legs: SignalLegs = { gym: true, ekg: true, validator: false };
  const signals: TripwireWatchSignal[] = [];
  try {
    const rows = await sql<{ evaluated_at: Date | string | null; accepted_at: Date | string; role: string; harness_slug: string }[]>`
      SELECT evaluated_at, accepted_at, role, harness_slug
        FROM harness_shared.gym_champion_outcomes
       WHERE workspace_id = ${workspaceId} AND verdict = 'regressed'
         AND accepted_at >= ${new Date(sinceMs)}`;
    for (const r of rows) {
      signals.push({
        kind: 'gym-regression',
        atMs: new Date(r.evaluated_at ?? r.accepted_at).getTime(),
        label: `gym champion regressed (${r.harness_slug}/${r.role})`,
        global: true,
      });
    }
  } catch {
    legs.gym = false;
  }
  try {
    const rows = await sql<{ window_date: Date | string; feature: string }[]>`
      SELECT window_date, feature
        FROM harness_shared.fleet_ekg_shifts
       WHERE workspace_id = ${workspaceId} AND severity = 'major'
         AND window_date >= ${new Date(sinceMs)}::date`;
    for (const r of rows) {
      signals.push({
        kind: 'ekg-drift',
        atMs: new Date(r.window_date).getTime(),
        label: `major fleet-EKG shift (${r.feature})`,
        global: true,
      });
    }
  } catch {
    legs.ekg = false;
  }
  return { signals: signals.sort((a, b) => a.atMs - b.atMs), legs };
}

/**
 * Live deps: PG store + the policy store (graduated_level writes via
 * setAutonomyPolicy, which audits + clamps ≤ ceiling) + captureImprovement for
 * the owner rail. The revert executor dispatches through revert-executor.ts's
 * registry (built-in reverters for the canonical work-item-state/-priority
 * handle kinds; the Queen execution layer registers reverters for its own
 * kinds). An unrecognized handle kind → reverted:false — the trip still records +
 * demotes + alerts (the safety), with the handle surfaced for a manual undo.
 */
export function defaultAutonomyTrustScanDeps(sql: Sql, workspaceId: string): AutonomyTrustScanDeps {
  return {
    async isArmed() {
      try {
        return await getFlag(FLAGS.MUG_AUTONOMY_ARMED, `autonomy:${workspaceId}`);
      } catch {
        return false; // fail-dark
      }
    },
    listArmed: () => listArmedTripwires(sql, workspaceId),
    gatherSignals: (sinceMs) => gatherTripwireSignals(sql, workspaceId, sinceMs),
    async executeRevert(row) {
      // B-16 owns the revert-handle vocabulary + dispatch (revert-executor.ts):
      // built-in reverters for the canonical kinds (work-item-state/-priority);
      // the Queen execution layer registers reverters for its own action kinds.
      // An unknown kind → reverted:false (the trip still demotes + alerts).
      const { executeRevertVia, makeRevertRegistry, defaultRevertHelpers } = await import('./revert-executor');
      return executeRevertVia(row, makeRevertRegistry(), defaultRevertHelpers());
    },
    markCleared: (id, nowMs) => markTripwireCleared(sql, workspaceId, id, nowMs),
    markTripped: (id, reason, nowMs, by) => markTripwireTripped(sql, workspaceId, id, reason, nowMs, by),
    markReverted: (id, nowMs) => markTripwireReverted(sql, workspaceId, id, nowMs),
    readEvidence: (o) => readTripwireEvidence(sql, workspaceId, o),
    listRecentlyReverted: (sinceMs) => listRecentlyRevertedTripwires(sql, workspaceId, sinceMs),
    quarantineRevertLoop: (input) => quarantineWorkItemRevertLoop(input),
    async readPolicy(category) {
      const { getAutonomyCategoryPolicy } = await import('../policy-store');
      return getAutonomyCategoryPolicy(sql, workspaceId, category);
    },
    async writeGraduatedLevel(category, level, reason) {
      const { setAutonomyPolicy } = await import('../policy-store');
      await setAutonomyPolicy(sql, workspaceId, { category, graduatedLevel: level, reason }, 'graduation-engine');
    },
    async notify(input) {
      const { captureImprovement } = await import('../../harness/improvements/capture-core');
      const res = await captureImprovement({
        title: input.title,
        kind: 'change',
        body: input.body,
        severity: 'major',
        subTopic: 'self-learning',
        scope: 'operator',
        watchdogKey: input.watchdogKey,
        dedupScope: 'all',
        sourceRole: 'system',
        origin: 'organic',
        createdBy: 'autonomy-trust-scan',
        // Under the autonomy lib (a protected surface) so the report/alert is
        // STRUCTURALLY barred from the auto lane it concerns.
        paths: ['packages/operator-core/lib/autonomy/tripwire/scan.ts'],
      });
      return !!res.created;
    },
    nowMs: () => Date.now(),
  };
}

// ───────────────────── the arming seam (P-080) ─────────────────────

export interface ArmTripwireForDecisionInput {
  decision: AutonomyDecision;
  revertHandle: RevertHandle;
  findingClass?: string;
  /** The decision-ledger link id (B-13) — mint it once + pass the SAME id to the
   *  ledger disposition emit so the feed can join tripwire ↔ disposition. */
  decisionId?: string;
  windowHours?: number;
}

export type ArmTripwireForDecisionResult =
  | { armed: true; id: string }
  | { armed: false; reason: string };

/**
 * THE arming seam (P-080 / D-006): the Queen execution layer calls this right
 * after it AUTO-takes a reversible action — it persists a revert-handle + arms a
 * watch window. Refuses (no row) when the decision isn't an auto reversible one
 * (the pure {@link armTripwire} re-checks the safety preconditions), or returns
 * null-id when the table isn't applied yet (subsystem dark). Pure decision +
 * one insert; nothing here arms anything by itself.
 */
export async function armTripwireForDecision(
  sql: Sql,
  workspaceId: string,
  input: ArmTripwireForDecisionInput,
  nowMs: number = Date.now(),
): Promise<ArmTripwireForDecisionResult> {
  const result: ArmTripwireResult = armTripwire({
    decision: input.decision,
    revertHandle: input.revertHandle,
    ...(input.findingClass !== undefined ? { findingClass: input.findingClass } : {}),
    ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
    windowHours: input.windowHours ?? 0, // 0 ⇒ the core's default window
    nowMs,
  });
  if ('refused' in result) return { armed: false, reason: result.refused };
  const id = await insertTripwire(sql, workspaceId, result.armed);
  if (id == null) return { armed: false, reason: 'autonomy_tripwires table not applied yet (subsystem dark)' };
  return { armed: true, id };
}

export { insertTripwire, getTripwire };
