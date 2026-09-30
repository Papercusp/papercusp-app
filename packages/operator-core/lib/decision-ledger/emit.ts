/**
 * The Queen decision-ledger ACTION-CHOKEPOINT emit — agent-capability-confinement-2026-06-13
 * B-06 (P-011) ⨯ queen-autonomy-policy-2026-06-13 D-012 / P-110.
 *
 * One compressed row per GOVERNED action, written from the shared endpoint dispatch
 * `postInvoke` seam (best-effort, fire-and-forget, never blocks/breaks the trigger — same
 * contract as the event-reaction postInvoke). "Complete for actions by construction" once
 * capability-confinement lands: every governed action MUST pass dispatch.
 *
 * This is a DIFFERENT projection from `harness_shared.tool_invocations` (which records
 * EVERY call incl. reads). The ledger keeps only:
 *   - GOVERNED actions — `tier != 'low'` (reads are not governance actions, D-003);
 *   - by NON-superuser principals — SU = supervised human, not autonomous Queen activity (D-002);
 * and adds the decision-semantics columns (posture / category / why / links + the
 * NULLABLE risk_tier·reversibility·authority the autonomy briefs B-01/B-02/B-04 populate).
 *
 * The DECIDER-DISPOSITION layer (queen-autonomy P-111), the ledger SURFACE (P-113), and
 * the back-fill of model-tier/gym-judge/budget (P-112) are queen-autonomy B-13 — they
 * CONSUME these rows; B-06 produces them.
 *
 * Default-ON (`papercusp-decision-ledger`): pure additive record-keeping, no LLM spend, a
 * subset of tool_invocations — the same Phase-0-foundation call as `papercusp-change-ledger`
 * (the rows must accumulate before B-13's surface + the autonomy gate consume them). The
 * flag is the kill-switch.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { papercuspTierFor, type CapabilityTier, type PostInvokeEvent } from '@papercusp/agent-mcp';
import { categoryForAction } from '../autonomy/capability-category-map';
import { ACTION_SURFACE } from '../autonomy/action-surface';

const TIER_RANK: Record<CapabilityTier, number> = { low: 0, medium: 1, high: 2 };

/**
 * Per-action-TYPE autonomy axes (queen-autonomy B-04 ACTION_SURFACE): tool name →
 * its FIXED reversibility + authority. Built once. Only the human-driving Queen
 * actions are catalogued; a governed action outside the surface gets NULL axes
 * here — honest, since its per-call footprint isn't known at the chokepoint
 * (reversibility's path/keyword classifier needs the candidate's footprint, which
 * a settled tool call doesn't carry). The authoritative CATEGORY map (B-04) covers
 * far more than the surface, so category is populated separately below.
 */
const ACTION_AXES: ReadonlyMap<string, { reversibility: string; authority: string }> = (() => {
  const m = new Map<string, { reversibility: string; authority: string }>();
  for (const a of ACTION_SURFACE) {
    for (const v of a.queenVerbs) m.set(v, { reversibility: a.reversibility, authority: a.authority });
  }
  return m;
})();

/**
 * Normalize a settled tool name to the `group:verb` colon form the category map +
 * the action surface key on. The dispatch chokepoint uses colon names
 * (`plans:set-status`), but the in-process/IPC legs can hand a dotted form
 * (`plans.set-status`); coerce the first `.` to `:` only when there's no `:`
 * already so a lookup never silently misses on a form mismatch.
 */
function normalizeAction(toolName: string): string {
  if (toolName.includes(':')) return toolName;
  const dot = toolName.indexOf('.');
  return dot > 0 ? `${toolName.slice(0, dot)}:${toolName.slice(dot + 1)}` : toolName;
}

/**
 * EI-597 — `coord:wake-mode` + `coord:wake-queue` declare `coord:write` (tier
 * medium) yet have READ modes: `wake-mode` with no `mode` only reads the current
 * mode; `wake-queue` with action `list` (its default) only lists staged wakes. A
 * client polling those reads (the loopback `palette` command-palette / TUI wake
 * board, ~37/min) floods the decision ledger with read rows — crowding genuine
 * governed actions out of the retained window and reading back as "N
 * auto-actions" (the queen-loop-alignment D-006 misdiagnosis). The emit's own
 * contract is that reads are execution, not governance (D-003) — they belong in
 * `tool_invocations` only — but the tier='low' read-exclusion misses these
 * because their declared capability is write-tier. Skip the read-shaped
 * invocation here. The WRITE paths (set a mode; release/skip a wake) are not
 * read-shaped, so they still log; `tool_invocations` still records every read.
 */
function isReadShapedCoordPoll(action: string, args: unknown): boolean {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (action === 'coord:wake-mode') return a.mode == null; // no mode ⇒ read
  if (action === 'coord:wake-queue') return a.action == null || a.action === 'list'; // list (default) ⇒ read
  return false;
}

/** The columns one action-chokepoint ledger row carries (the host fills the rest by default). */
export interface DecisionLedgerRow {
  workspaceId: string;
  harnessSlug: string | null;
  action: string;
  capability: string | null;
  tier: CapabilityTier;
  category: string | null;
  /** Per-action-TYPE reversibility (B-02 vocab) from the action surface; null off-surface. */
  reversibility: string | null;
  /** Decision authority (B-01) from the action surface; null off-surface. */
  authority: string | null;
  posture: 'auto' | 'gated' | 'rejected';
  outcome: 'ok' | 'error';
  outcomeCode: string | null;
  why: string | null;
  links: Record<string, unknown> | null;
  actorRole: string | null;
  actorSpawnId: string | null;
  actorPrincipal: string | null;
  transport: string | null;
  durationMs: number | null;
  argsDigest: string | null;
}

/**
 * PURE decision + field computation: does this settled call earn a ledger row, and if so
 * what does it hold? Returns null to SKIP (no workspace · superuser · no declared
 * capability · a read (tier 'low')). No PG, no flag — those are the impl's job — so this is
 * directly unit-testable. Exported for the emit tests.
 */
export function buildDecisionLedgerRow(event: PostInvokeEvent): DecisionLedgerRow | null {
  const { ctx, toolName, result, durationMs } = event;
  if (!ctx.workspaceId) return null;
  // SU = supervised human driving directly, not the autonomous Queen/fleet (D-002).
  if (ctx.isSuperuser) return null;

  const caps = event.capabilities ?? [];
  // No declared capability ⇒ a public/ungated utility — not a classifiable governed action.
  if (caps.length === 0) return null;
  const tier = highestTier(caps);
  // Reads (tier 'low') are execution, not governance — they belong in tool_invocations only.
  if (tier === 'low') return null;

  const verdict = event.envelopeVerdict ?? null;
  const primaryCap = caps[0] ?? null;
  const normAction = normalizeAction(toolName);
  // EI-597: a read-shaped poll of a dual-mode coord verb is a read, not a
  // governed action — skip it (see isReadShapedCoordPoll). Stops the `palette`
  // wake-board poll loop from flooding the ledger out of its retained window.
  if (isReadShapedCoordPoll(normAction, event.args)) return null;
  const axes = ACTION_AXES.get(normAction);
  return {
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.harnessSlug ?? null,
    action: toolName,
    capability: primaryCap,
    tier,
    // The AUTHORITATIVE 13-category map (B-04) when it resolves; the coarse
    // capability-group placeholder otherwise (covers governed actions outside the
    // mapped Queen surface so the column is never empty for filtering).
    category: categoryForAction(normAction, primaryCap ?? undefined) ?? categoryFor(primaryCap, toolName),
    reversibility: axes?.reversibility ?? null,
    authority: axes?.authority ?? null,
    posture: verdict?.posture ?? 'auto',
    outcome: result.ok ? 'ok' : 'error',
    outcomeCode: result.ok ? null : (result.error?.code ?? null),
    why: verdict?.reason ?? null,
    links: buildLinks(ctx),
    actorRole: ctx.role ?? null,
    actorSpawnId: ctx.spawnId ?? null,
    actorPrincipal: ctx.principal?.slug ?? null,
    transport: ctx.transport ?? null,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    argsDigest: digestArgs(event.args),
  };
}

/** Fire-and-forget entry point wired into PROJECTED_DEPS.postInvoke. Never throws. */
export function recordDecisionLedger(event: PostInvokeEvent): void {
  void recordDecisionLedgerImpl(event).catch((err) => {
     
    console.warn(`[decision-ledger] emit failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function recordDecisionLedgerImpl(event: PostInvokeEvent): Promise<void> {
  const row = buildDecisionLedgerRow(event);
  if (!row) return; // cheap governed-action filter first (no flag read on read-heavy traffic)
  // Kill-switch. getFlag is cached (no per-call network).
  if (!(await getFlag(FLAGS.DECISION_LEDGER, 'system'))) return;

  try {
    const { sql } = getOrgPg();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [row.workspaceId]);
      await tx.unsafe(
        `INSERT INTO harness_shared.decision_ledger
           (workspace_id, harness_slug, action, capability, tier, category,
            reversibility, authority,
            posture, outcome, outcome_code, why, links,
            actor_role, actor_spawn_id, actor_principal, transport, duration_ms, args_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)`,
        [
          row.workspaceId,
          row.harnessSlug,
          row.action,
          row.capability,
          row.tier,
          row.category,
          row.reversibility,
          row.authority,
          row.posture,
          row.outcome,
          row.outcomeCode,
          row.why,
          row.links ? JSON.stringify(row.links) : null,
          row.actorRole,
          row.actorSpawnId,
          row.actorPrincipal,
          row.transport,
          row.durationMs,
          row.argsDigest,
        ],
      );
    });
  } catch (err) {
    // 42P01 = undefined_table: harness_shared.decision_ledger is absent in isolated
    // test/e2e PG fixtures (no migrations run there). This emit is fire-and-forget
    // bookkeeping that degrades gracefully, so the missing-table case is expected —
    // swallow it silently (otherwise vitest-fail-on-console reds every e2e that
    // drives a governed dispatch). Warn loudly on any real insert failure. Mirrors
    // the expirable-registry.ts / work-items.ts 42P01-swallow precedent. (EI-499)
    if ((err as { code?: string })?.code !== '42P01') {
       
      console.warn(`[decision-ledger] insert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function highestTier(capabilities: readonly string[]): CapabilityTier {
  let best: CapabilityTier = 'low';
  for (const cap of capabilities) {
    const t = papercuspTierFor(cap);
    if (TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}

/**
 * Coarse functional-domain category: the capability group (the token before the first
 * ':'), e.g. `plans:write` → `plans`, `cup:spawn` → `fleet`. The AUTHORITATIVE
 * 13-category taxonomy + capability→category map is queen-autonomy B-04 (P-015 / P-020);
 * this is the best-effort placeholder until that lands.
 */
function categoryFor(capability: string | null, toolName: string): string | null {
  const src = capability ?? toolName;
  const sep = src.indexOf(':');
  if (sep > 0) return src.slice(0, sep);
  const dot = src.indexOf('.');
  if (dot > 0) return src.slice(0, dot);
  return src || null;
}

/** Provenance links — enough to drill from a ledger row to its run/transcript. */
function buildLinks(ctx: PostInvokeEvent['ctx']): Record<string, unknown> | null {
  const links: Record<string, unknown> = {};
  if (ctx.runId) links.runId = ctx.runId;
  if (ctx.spawnId) links.spawnId = ctx.spawnId;
  if (ctx.parentSpawnId) links.parentSpawnId = ctx.parentSpawnId;
  if (ctx.featureId) links.featureId = ctx.featureId;
  if (ctx.chunkId) links.chunkId = ctx.chunkId;
  if (ctx.uiClientId) links.uiClientId = ctx.uiClientId;
  if (ctx.reactionCause) links.reaction = ctx.reactionCause;
  return Object.keys(links).length > 0 ? links : null;
}

/**
 * A privacy-preserving digest of the call args: the sorted top-level key names only (never
 * the values — those live in tool_invocations.args_json). Shows the call SHAPE in the
 * ledger without duplicating payloads.
 */
function digestArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const keys = Object.keys(args as Record<string, unknown>).sort();
  if (keys.length === 0) return null;
  const joined = keys.join(',');
  return joined.length > 512 ? `${joined.slice(0, 509)}...` : joined;
}
