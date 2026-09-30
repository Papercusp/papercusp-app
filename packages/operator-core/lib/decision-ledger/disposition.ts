/**
 * The Queen decision-ledger DECIDER-DISPOSITION layer — queen-autonomy-policy-2026-06-13
 * B-13 / P-111. The second of the two-layer D-012 ledger.
 *
 * Where the ACTION layer (B-06 / P-110, ./emit.ts) records one row per GOVERNED
 * ACTION that ran, the DISPOSITION layer records one row per item the Queen's
 * decision turn CONSIDERED — the disposition she chose and why. It consumes the
 * decider's `AutonomyDecision` record (B-12, ../autonomy/decider.ts) directly; it
 * does NOT fork the gate.
 *
 * The five P-111 dispositions:
 *   act               — she acted on it (an `auto` decision executed; links the
 *                        action row via links.actionLedgerId). On a `gated`
 *                        decision, "act" means she PROPOSED it for owner
 *                        ratification → posture 'proposed'.
 *   defer             — postponed; `revisitAt` carries when (defer +revisit).
 *   reject            — dropped the item (`why` carries the reason).
 *   route-to-research — needs more knowledge first; links the spawned research
 *                        task via links.researchTaskId. (The P-111 worked example:
 *                        a plan that "needs more research" → a plan-governance
 *                        disposition + a linked research-task.)
 *   no-op             — considered, nothing to do (`why` carries the reason).
 *
 * Behind the same `papercusp-decision-ledger` kill-switch as the action layer
 * (default-ON, additive, behavior-neutral): the rows accumulate so the surface
 * (P-113), the settings recent-auto-decisions feed (P-031), and B-16's
 * tripwire/graduation consume them.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { decideAutonomy, type AutonomyDecision, type AutonomyDecisionInput } from '../autonomy/decider';
import { trackDetached } from '../detached-imports';

/** The P-111 disposition verbs (the Queen's chosen response to a considered item). */
export const DISPOSITIONS = ['act', 'defer', 'reject', 'route-to-research', 'no-op'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The ledger posture vocabulary (migration 260 CHECK). */
export type DispositionPosture = 'auto' | 'proposed' | 'gated';

/** Provenance + cross-links carried in the row's `links` jsonb. */
export interface DispositionLinks {
  runId?: string;
  spawnId?: string;
  parentSpawnId?: string;
  featureId?: string;
  chunkId?: string;
  uiClientId?: string;
  /** The item the Queen considered (work-item / feature / plan-item / idea id). */
  itemRef?: string;
  /** disposition='act': the decision_ledger.id of the action row this realized. */
  actionLedgerId?: number;
  /** disposition='route-to-research': the spawned research-task work-item id. */
  researchTaskId?: string;
}

export interface RecordDispositionInput {
  workspaceId: string;
  harnessSlug?: string | null;
  /** The decider's verdict for this item (B-12). The disposition's substrate. */
  decision: AutonomyDecision;
  disposition: Disposition;
  /**
   * Override the derived ledger posture. Default is `dispositionPosture(decision,
   * disposition)`. The back-fill path (P-112) passes 'auto' for a proactive
   * decision the system ALREADY executed autonomously (model-tier, gym score,
   * governor budget) — it ran, even though the gate is unarmed; the gate's honest
   * "would it auto once armed?" still rides metadata.wouldAutoIfArmed.
   */
  posture?: DispositionPosture;
  /** Short human "why". Defaults to the decision's reasons, joined. */
  why?: string | null;
  links?: DispositionLinks | null;
  /** disposition='defer': when to reconsider. Ignored for other dispositions. */
  revisitAt?: Date | string | null;
  actorRole?: string | null;
  actorSpawnId?: string | null;
  actorPrincipal?: string | null;
  transport?: string | null;
  /** Decision-specific facts merged into the row's metadata (e.g. {score}, {tier}). */
  extraMetadata?: Record<string, unknown>;
}

/**
 * Map the decider's binary gate posture (auto|gated) onto the ledger posture
 * (260's auto|proposed|gated). An `auto` decision that the Queen acts on ran
 * autonomously → 'auto'. A `gated` decision she still ACTS on means she proposed
 * it for owner ratification → 'proposed' (the 260 `proposed` posture). Any other
 * disposition on a gated decision stays 'gated' (the owner Queue owns it).
 */
export function dispositionPosture(
  decision: AutonomyDecision,
  disposition: Disposition,
): DispositionPosture {
  if (decision.posture === 'auto') return 'auto';
  if (disposition === 'act') return 'proposed';
  return 'gated';
}

/** The columns one disposition-layer ledger row carries. */
export interface DispositionLedgerRow {
  workspaceId: string;
  harnessSlug: string | null;
  action: string | null;
  category: string | null;
  riskTier: string;
  reversibility: string;
  authority: string;
  posture: DispositionPosture;
  disposition: Disposition;
  why: string | null;
  links: Record<string, unknown> | null;
  revisitAt: string | null;
  reasons: string[];
  metadata: Record<string, unknown>;
  actorRole: string | null;
  actorSpawnId: string | null;
  actorPrincipal: string | null;
  transport: string | null;
}

function toIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  if (typeof d === 'string') return d;
  return d.toISOString();
}

/**
 * PURE row builder — maps an `AutonomyDecision` + the chosen disposition onto the
 * disposition-layer columns. No PG, no flag — directly unit-testable.
 */
export function buildDispositionRow(input: RecordDispositionInput): DispositionLedgerRow {
  const { decision } = input;
  const links: Record<string, unknown> = { ...(input.links ?? {}) };
  // `revisit_at` is a real column; only meaningful for a deferral.
  const revisitAt = input.disposition === 'defer' ? toIso(input.revisitAt) : null;
  const reasons = decision.reasons ?? [];
  const why = input.why ?? (reasons.length > 0 ? reasons.join('; ') : null);
  return {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug ?? null,
    action: decision.action ?? null,
    category: decision.category ?? null,
    riskTier: decision.riskTier,
    reversibility: decision.reversibility,
    authority: decision.authority,
    posture: input.posture ?? dispositionPosture(decision, input.disposition),
    disposition: input.disposition,
    why,
    links: Object.keys(links).length > 0 ? links : null,
    revisitAt,
    reasons,
    // The full decision context the gate-posture column can't hold — what the
    // surface (P-113) + B-16's graduation evidence read back.
    metadata: {
      wouldAutoIfArmed: decision.wouldAutoIfArmed,
      armed: decision.armed,
      effectiveCeiling: decision.effectiveCeiling,
      protected: decision.protected,
      ...(reasons.length > 0 ? { reasons } : {}),
      ...(decision.signals ? { signals: decision.signals } : {}),
      ...(decision.graduationEvidence ? { graduationEvidence: decision.graduationEvidence } : {}),
      ...(input.extraMetadata ?? {}),
    },
    actorRole: input.actorRole ?? null,
    actorSpawnId: input.actorSpawnId ?? null,
    actorPrincipal: input.actorPrincipal ?? null,
    transport: input.transport ?? null,
  };
}

/**
 * Record one disposition row. Flag-gated (the `papercusp-decision-ledger`
 * kill-switch) + best-effort: a flag-off / PG error returns null and never throws,
 * so a logging miss can never break the Queen's decision turn. Returns the new
 * row id on success (the action-row link target for a follow-on `act`).
 */
export async function recordDecisionDisposition(
  input: RecordDispositionInput,
): Promise<number | null> {
  if (!input.workspaceId) return null;
  if (!(await getFlag(FLAGS.DECISION_LEDGER, 'system'))) return null;
  const row = buildDispositionRow(input);
  try {
    const { sql } = getOrgPg();
    const id = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [row.workspaceId]);
      const inserted = await tx.unsafe(
        `INSERT INTO harness_shared.decision_ledger
           (workspace_id, harness_slug, layer, action, category,
            risk_tier, reversibility, authority, posture, outcome,
            disposition, why, links, revisit_at, metadata,
            actor_role, actor_spawn_id, actor_principal, transport)
         VALUES ($1,$2,'disposition',$3,$4,$5,$6,$7,$8,'ok',$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17)
         RETURNING id`,
        [
          row.workspaceId,
          row.harnessSlug,
          row.action,
          row.category,
          row.riskTier,
          row.reversibility,
          row.authority,
          row.posture,
          row.disposition,
          row.why,
          row.links ? JSON.stringify(row.links) : null,
          row.revisitAt,
          JSON.stringify(row.metadata),
          row.actorRole,
          row.actorSpawnId,
          row.actorPrincipal,
          row.transport,
        ],
      );
      const rows = inserted as unknown as Array<{ id: number | string }>;
      return rows[0]?.id != null ? Number(rows[0].id) : null;
    });
    // Refresh the recent-auto-decisions feed (P-031/P-113). Disposition writes are
    // the low-volume, feed-relevant layer — the action emit deliberately does NOT
    // invalidate. Fire-and-forget; a sync miss never breaks the decision turn.
    if (id != null) {
      void trackDetached(import('../sync-sse'))
        .then(({ notifySyncInvalidate }) => notifySyncInvalidate('decision.ledger'))
        .catch(() => {});
    }
    return id;
  } catch (err) {
     
    console.warn(
      `[decision-ledger] disposition insert failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface ProactiveDispositionInput {
  workspaceId: string;
  harnessSlug?: string | null;
  /** The action this proactive decision realizes (keys the category + the gate axes). */
  decisionInput: AutonomyDecisionInput;
  /** Defaults to 'act' — a proactive decision the system carried out. */
  disposition?: Disposition;
  why?: string | null;
  links?: DispositionLinks | null;
  /** Extra decision-specific facts to fold into metadata (e.g. {score}, {tier}). */
  metadata?: Record<string, unknown>;
  actorRole?: string | null;
  actorSpawnId?: string | null;
  actorPrincipal?: string | null;
}

/**
 * Back-fill a currently-unlogged PROACTIVE decision into the disposition log
 * (queen-autonomy P-112) — model-tier per spawn, gym:judge score+rationale,
 * governor budget changes. These don't pass the action chokepoint (they're not
 * governed MCP tool calls) and aren't a gated queue item, but they ARE autonomous
 * decisions the system makes; routing them here gives the ledger + the
 * recent-auto-decisions feed ONE honest record.
 *
 * Runs the PURE gate (`decideAutonomy`, unarmed) to derive the decision axes +
 * `wouldAutoIfArmed`, then records posture='auto' (it executed autonomously) with
 * disposition='act' by default. Best-effort + flag-gated via
 * recordDecisionDisposition — never throws into the caller's hot path.
 */
export async function recordProactiveDisposition(
  input: ProactiveDispositionInput,
): Promise<number | null> {
  const decision = decideAutonomy(input.decisionInput);
  return recordDecisionDisposition({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug ?? null,
    decision,
    disposition: input.disposition ?? 'act',
    posture: 'auto', // it executed autonomously today; wouldAutoIfArmed rides metadata
    ...(input.why !== undefined ? { why: input.why } : {}),
    ...(input.links ? { links: input.links } : {}),
    ...(input.metadata ? { extraMetadata: input.metadata } : {}),
    actorRole: input.actorRole ?? null,
    actorSpawnId: input.actorSpawnId ?? null,
    actorPrincipal: input.actorPrincipal ?? null,
  });
}
