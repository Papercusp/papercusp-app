/**
 * change-ledger.ts — the APPEND-ONLY behavior-affecting change ledger
 * (self-learning-frontier-2026-06-12 P-004 / FB-02, decision D-003).
 *
 * One `harness_shared.behavior_change_ledger` row (migration 242) per
 * prompt/rule mutation, from any source. The gym, shadow ablation (FB-09), and
 * any future probation window all mutate the prompt layer; the fleet EKG
 * (P-030) conditions its distribution-shift attribution on THIS ledger — a
 * mutation that isn't ledgered is an unattributable shift.
 *
 * Writers (all best-effort — a ledger write must NEVER block the mutation it
 * records, mirroring dispatch-ledger.ts):
 *
 *   - the gym committer: `decideProposal` accept (lib/gym/control-plane.ts)
 *     → source 'gym:accept'
 *   - autonomous gym promotion: `promoteChampion`'s optional `recordChange`
 *     dep (lib/gym/promotion.ts) — bind `gymPromotionRecorder(...)` when the
 *     autonomous path gets production wiring → source 'gym:promotion'
 *   - the prompt-override API (endpoint-route/routes/harness/prompts.ts, both
 *     the commit-reproject and pg-override branches) → source 'prompts-api'
 *   - the repo prompt-file scanner (`system:change-ledger-scan`, see
 *     prompt-file-scan.ts) — playbook/persona/spawn-prompt FILE edits
 *     recovered from git history → source 'repo-scan'
 *   - the FB-09 ablation seam (future): any ablation-driven live prompt change
 *     calls `recordBehaviorChange` with source 'ablation' directly. Shadow
 *     ablations never mutate live prompts and so never write here.
 *
 * This module OWNS the vocabulary (the columns are plain text so the seam can
 * evolve it). `mutation_class` is the D-003 mutation-calendar serialization
 * unit; the one-live-class-at-a-time rule is ADVISORY (mutation-calendar.ts
 * surfaces overlap; nothing enforces it).
 *
 * Everything is flag-gated by FLAGS.CHANGE_LEDGER (default ON — this is Phase 0
 * foundation record-keeping: no LLM spend, no filing into queues; NOT one of
 * the D-001 dark-shipped frontier loops, which need attribution history to
 * already exist when they arm). OFF = every writer no-ops.
 */

import { getOrgPg } from '@papercusp/db-org';
import { coerceJson } from '../pg-jsonb';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

/** The writing system. Vocabulary owned here — see module doc for who is who. */
export type BehaviorChangeSource =
  | 'gym:accept'
  | 'gym:promotion'
  | 'prompts-api'
  | 'repo-scan'
  | 'ablation'
  | 'manual';

/** The D-003 calendar serialization unit. */
export type MutationClass = 'gym' | 'manual-prompt' | 'repo-prompt' | 'ablation';

/** What happened to the target. */
export type BehaviorChangeAction = 'set' | 'clear' | 'clear-all' | 'edit';

/** What kind of thing mutated. */
export type BehaviorChangeTargetKind = 'prompt-override' | 'prompt-file';

/** Default class per source (override per call for future sources). */
export const MUTATION_CLASS_FOR_SOURCE: Record<BehaviorChangeSource, MutationClass> = {
  'gym:accept': 'gym',
  'gym:promotion': 'gym',
  'prompts-api': 'manual-prompt',
  'repo-scan': 'repo-prompt',
  ablation: 'ablation',
  manual: 'manual-prompt',
};

export interface BehaviorChangeRow {
  id: string;
  workspaceId: string;
  /** ISO timestamp. */
  recordedAt: string;
  source: BehaviorChangeSource | string;
  mutationClass: MutationClass | string;
  action: BehaviorChangeAction | string;
  targetKind: BehaviorChangeTargetKind | string;
  target: string;
  harnessSlug: string | null;
  role: string | null;
  diffRef: string | null;
  actor: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
}

export interface RecordBehaviorChangeInput {
  workspaceId: string;
  source: BehaviorChangeSource;
  action: BehaviorChangeAction;
  targetKind: BehaviorChangeTargetKind;
  target: string;
  /** Defaults to MUTATION_CLASS_FOR_SOURCE[source]. */
  mutationClass?: MutationClass;
  harnessSlug?: string | null;
  role?: string | null;
  /** Change-content reference: gym proposal id, git sha, reproject commit, ablation run id. */
  diffRef?: string | null;
  actor?: string | null;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  /** When the mutation actually happened (ms). Defaults to now() in PG — pass
   *  it for after-the-fact writers (the repo scanner backfills commit time so
   *  the calendar's liveness window reads true mutation times). */
  recordedAtMs?: number;
}

/**
 * Append one ledger row. Best-effort: returns the row id, or null when the
 * flag is off, the row deduped (ON CONFLICT on (workspace, source, diff_ref,
 * target) — idempotent writers re-offering the same change), or the write
 * failed (warned loudly; the mutation it records proceeds regardless).
 */
export async function recordBehaviorChange(input: RecordBehaviorChangeInput): Promise<string | null> {
  try {
    if (!(await getFlag(FLAGS.CHANGE_LEDGER, 'change-ledger'))) return null;
    const mutationClass = input.mutationClass ?? MUTATION_CLASS_FOR_SOURCE[input.source];
    const { sql } = getOrgPg();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.behavior_change_ledger
        (workspace_id, source, mutation_class, action, target_kind, target,
         harness_slug, role, diff_ref, actor, summary, payload, recorded_at)
      VALUES
        (${input.workspaceId}, ${input.source}, ${mutationClass}, ${input.action},
         ${input.targetKind}, ${input.target}, ${input.harnessSlug ?? null},
         ${input.role ?? null}, ${input.diffRef ?? null}, ${input.actor ?? null},
         ${input.summary ?? null},
         ${input.payload ? JSON.stringify(input.payload) : null}::text::jsonb,
         ${input.recordedAtMs != null ? new Date(input.recordedAtMs).toISOString() : sql`now()`})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn(
      `[change-ledger] FAILED to record ${input.source} change on ${input.target} — EKG attribution has a hole here:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export interface ReadRecentChangesOptions {
  limit?: number;
  mutationClass?: MutationClass | string;
  /** Only rows recorded at/after this time (ms). */
  sinceMs?: number;
}

/** Recent ledger rows for a workspace, newest first. Throws on PG failure. */
export async function readRecentChanges(
  workspaceId: string,
  opts: ReadRecentChangesOptions = {},
): Promise<BehaviorChangeRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
  const rows = await sql<
    {
      id: string;
      workspace_id: string;
      recorded_at: Date | string;
      source: string;
      mutation_class: string;
      action: string;
      target_kind: string;
      target: string;
      harness_slug: string | null;
      role: string | null;
      diff_ref: string | null;
      actor: string | null;
      summary: string | null;
      payload: Record<string, unknown> | null;
    }[]
  >`
    SELECT id, workspace_id, recorded_at, source, mutation_class, action,
           target_kind, target, harness_slug, role, diff_ref, actor, summary, payload
      FROM harness_shared.behavior_change_ledger
     WHERE workspace_id = ${workspaceId}
       ${opts.mutationClass ? sql`AND mutation_class = ${opts.mutationClass}` : sql``}
       ${opts.sinceMs != null ? sql`AND recorded_at >= ${new Date(opts.sinceMs).toISOString()}` : sql``}
     ORDER BY recorded_at DESC
     LIMIT ${limit}`;
  const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    recordedAt: iso(r.recorded_at),
    source: r.source,
    mutationClass: r.mutation_class,
    action: r.action,
    targetKind: r.target_kind,
    target: r.target,
    harnessSlug: r.harness_slug,
    role: r.role,
    diffRef: r.diff_ref,
    actor: r.actor,
    summary: r.summary,
    payload: coerceJson<Record<string, unknown>>(r.payload),
  }));
}

/**
 * Ready-made `PromotionDeps.recordChange` for the autonomous gym promotion
 * path (promoteChampion). Nothing binds promoteChampion in production yet
 * (the live loop is human-gated through decideProposal, D-020); whoever wires
 * it binds this so autonomous promotions ledger by default.
 */
export function gymPromotionRecorder(
  workspaceId: string,
  harnessSlug: string,
): (entry: { role: string; action: 'set' | 'clear' }) => Promise<void> {
  return async ({ role, action }) => {
    await recordBehaviorChange({
      workspaceId,
      source: 'gym:promotion',
      action,
      targetKind: 'prompt-override',
      target: `${harnessSlug}/${role}`,
      harnessSlug,
      role,
      actor: 'gym:promotion',
      summary: `autonomous champion promotion ${action} → ${role}@${harnessSlug}`,
    });
  };
}
