/**
 * router-deps.ts — production wiring of the Scout router's dispatch ports
 * (hive-creative-ideation-2026-06-08, P-007).
 *
 * Mirrors `corpus-digest-deps.ts` / `change-feed-deps.ts`: the router core
 * (`router.ts`) stays pure + fake-testable behind the injected {@link RouterPorts};
 * this file binds the two CTX-FREE rails to their real backends and exposes the
 * `plansNew` factory that takes the cycle/scheduler's ctx-bound plan creator.
 *
 *   • capture (concrete → improvements:capture) — the real `captureImprovement`
 *     (search-first dedup, native kind), filed as the Queen (D-010 — Scout is
 *     prompt-free, the Queen is the autonomy gate / source role).
 *   • gymDispatch (testable → gym) — the real `seedDistantNiches` (P-012) against
 *     an injected {@link ArchivePort} (su-8075f's archive adapter, bound by the
 *     gym-QD lane). Ctx-free.
 *   • plansNew (broad → plans:new draft) — necessarily ctx-coupled (plans:new
 *     locks + captures a revision + emits a plan-event), so this file takes an
 *     injected {@link PlanDraftCreator} the cycle/scheduler supplies with its ctx,
 *     and shapes the proposal into the create call. The honest ctx seam.
 *
 * No flag here — these are inert helpers until P-008 wires the autonomous Scout
 * cadence (gate the run there, not the library).
 */

import { captureImprovement } from '../harness/improvements/capture-core';
import type { SignalOrigin } from '../harness/improvements/provenance';
import { seedDistantNiches, type ArchivePort, type SeedDistantOptions } from './gym-bridge';
import type { Proposal } from './types';
import {
  proposalTitle,
  type CapturePort,
  type GoalAmendmentDispatchPort,
  type GoalDispatchPort,
  type GymDispatchPort,
  type InstanceDispatchPort,
  type InstanceVariantView,
  type PlansNewPort,
} from './router';

/* ────────────────────────────────────────────────────────────────────────
 * concrete → improvements:capture
 * ──────────────────────────────────────────────────────────────────────── */

export interface CapturePortOptions {
  /** Who filed it (P-010 source-tag). Default 'Scout' — the artifact-side stamp that
      makes scout-routed EIs filterable (`improvement-source:Scout` topic); the Queen
      still gates them (D-010). */
  sourceRole?: 'Queen' | 'system' | 'Scout';
  /** Improvement scope ('operator' or 'harness:<slug>'). Default 'operator'. */
  scope?: string;
  /** Stamp on each capture (for the change-feed drill-back). Default 'scout-loop'. */
  foundDuring?: string;
  /** The capture kind. Scout proposals are desired improvements → 'change' by default. */
  kind?: 'bug' | 'change' | 'feature';
  /** Synthetic provenance for a bounded drill/replay/shadow run. Omitted keeps
   *  the production Scout path organic. */
  origin?: SignalOrigin;
  /**
   * Lowest semantic band that may DECLINE a Scout capture. Default `'soft'`
   * (plan learning-loop-identity-and-consumption-2026-08-08 P-008 / D-033) —
   * deliberately STRICTER than `captureImprovement`'s own `'hard'` default,
   * because this port is high-volume MACHINE ideation: a decline here is an
   * ATTRIBUTION to the existing sibling, not a lost filing, so the trade-off
   * that keeps soft advisory for agent filings does not apply.
   *
   * Set `'hard'` to restore the pre-D-033 behavior for a drill/replay.
   */
  semanticBlockBand?: 'hard' | 'soft';
}

/** Compose a readable improvement body from a proposal's structured fields. */
export function improvementBody(p: Proposal): string {
  const consultation = p.consultation;
  const consultationBlock = consultation
    ? [
        `\n**Independent Blender consult (${consultation.status}):** ` +
          `${consultation.conversationId ?? 'no conversation opened'}; state=${consultation.state}.`,
        consultation.feedback ? `\n**Consult feedback folded into this route:** ${consultation.feedback}` : '',
        consultation.reason ? `\n_Consult unavailable: ${consultation.reason}_` : '',
      ]
        .filter(Boolean)
        .join('')
    : '';
  const lines = [
    p.whyNew?.trim(),
    consultationBlock,
    p.mechanism ? `\n**Mechanism:** ${p.mechanism.trim()}` : '',
    p.bet ? `\n**The bet:** ${p.bet.trim()}` : '',
    p.cheapExperiment
      ? `\n**Cheap experiment (D-006):**\n- Hypothesis: ${p.cheapExperiment.hypothesis}\n- Method: ${p.cheapExperiment.method}\n- Falsified if: ${p.cheapExperiment.falsifiableSignal}`
      : '',
    p.sourceIdeaIds?.length ? `\n_Scout-generated. Source ideas: ${p.sourceIdeaIds.join(', ')}._` : '',
  ];
  return lines
    .filter((l) => l && l.length > 0)
    .join('\n')
    .trim();
}

/**
 * Production `capture` port — files the proposal as a captured improvement via
 * the shared `captureImprovement` (search-first dedup). When the capture is
 * declined as a likely duplicate, the routedRef points at the EXISTING item (the
 * idea was already captured — a meaningful, joinable outcome), so `id` is the top
 * duplicate's id and `created` is false.
 */
export function buildCapturePort(
  opts: CapturePortOptions = {},
  capture: typeof captureImprovement = captureImprovement,
): CapturePort {
  return async ({ proposal }) => {
    const res = await capture({
      title: proposalTitle(proposal) || `Scout idea ${proposal.id}`,
      kind: opts.kind ?? 'change',
      body: improvementBody(proposal),
      // allow-scope-default: an unscoped Scout idea is operator-level by design (issue scope, not a workspace).
      scope: opts.scope ?? 'operator',
      sourceRole: opts.sourceRole ?? 'Scout',
      foundDuring: opts.foundDuring ?? 'scout-loop',
      // D-033: soft-band hits decline HERE (machine ideation) though they stay
      // advisory for agent filings. Owner constraint D-004 holds by construction —
      // this is Scout's port; the agent-facing improvements:capture tool never
      // passes this and keeps the 'hard' default.
      semanticBlockBand: opts.semanticBlockBand ?? 'soft',
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
    if (res.created && res.issue) {
      return { id: res.issue.id, created: true };
    }
    // Declined as a duplicate → attribute to the existing item if we found one.
    return { id: res.possibleDuplicates[0]?.id ?? '', created: false };
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * testable → gym (seedDistantNiches against the real archive)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Production `gymDispatch` port — seeds the gym's MAP-Elites QD archive's distant
 * niches (P-012 / D-008). The `archive` is su-8075f's real archive bound through
 * the gym-QD lane's adapter; this stays ctx-free (no PG/LLM of its own — the
 * archive owns its persistence).
 */
export function buildGymDispatchPort(archive: ArchivePort, opts: SeedDistantOptions = {}): GymDispatchPort {
  return async (ideas) => seedDistantNiches(ideas, archive, opts);
}

/* ────────────────────────────────────────────────────────────────────────
 * broad → plans:new draft (ctx-coupled — injected creator)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The ctx-bound plan-draft creator the cycle/scheduler supplies. It wraps the
 * `plans:new` tool (which needs ctx for the write-lock + revision + plan-event),
 * so the ctx-coupling lives in the wiring layer (P-008 / cb4b9's runScoutCycle),
 * not here. Returns the created (or pre-existing) draft plan's slug.
 */
export type PlanDraftCreator = (args: { slug: string; title: string; rationale?: string }) => Promise<{ slug: string }>;

/**
 * Production `plansNew` port — shapes a proposal into a draft-plan create call
 * and delegates to the injected ctx-bound {@link PlanDraftCreator}. The created
 * plan is a DRAFT (owner/Queen-visible, not auto-active) per D-002/D-010 — the
 * Queen greenlights it by promoting the draft.
 */
export function buildPlansNewPort(create: PlanDraftCreator): PlansNewPort {
  return async ({ proposal, slugStem }) => {
    const title = proposalTitle(proposal) || `Scout idea ${proposal.id}`;
    const rationale = [
      `Scout-generated broad-scope proposal (sources: ${(proposal.sourceIdeaIds ?? []).join(', ') || 'n/a'}).`,
      proposal.whyNew ? `Why new: ${proposal.whyNew}` : '',
      proposal.bet ? `The bet: ${proposal.bet}` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1000);
    return create({ slug: slugStem, title, rationale });
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * whole-system → InstanceSubject (the apiary's genome-variant intake; P-005)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The InstanceSubject's variant intake the cycle supplies. A whole-system proposal becomes
 * a GENOME-delta candidate the apiary scores (the eval-battery InstanceSubject — a
 * whole-instance eval of the interacting wholes). The apiary loop
 * ([[apiary-2026-06-06]] / [[apiary-generation-0-battery-2026-06-08]]) consumes these as
 * same-origin variants. Returns the registered candidate ids.
 *
 * Until the apiary's intake queue is built, the routed-idea ledger (rail='instance',
 * routedRef='instance:<id>', persisted by the scheduler's `recordRoutedIdea`) IS the
 * pending-candidate record — so the default recorder simply ACKNOWLEDGES the candidates and
 * the apiary reads pending `instance:*` rows from there. The seam lets the apiary bind a
 * real enqueue without touching the router.
 */
export type InstanceCandidateRecorder = (candidates: InstanceVariantView[]) => Promise<string[]>;

/** Default recorder: acknowledge the candidates (the routed-idea ledger persists the
 *  rail='instance' rows; the apiary reads pending candidates from there). */
const echoInstanceCandidates: InstanceCandidateRecorder = async (candidates) => candidates.map((c) => c.id);

/**
 * Production `instanceDispatch` port (reconciliation P-005) — registers whole-system
 * proposals as InstanceSubject (apiary) genome-variant candidates via the injected
 * {@link InstanceCandidateRecorder} (defaults to acknowledge-only). Batch-shaped like the
 * gym rail; ctx-free (the ledger / apiary owns persistence).
 */
export function buildInstanceDispatchPort(
  record: InstanceCandidateRecorder = echoInstanceCandidates,
): InstanceDispatchPort {
  return async (views) => ({ registered: await record(views) });
}

/* ────────────────────────────────────────────────────────────────────────
 * goal-scale → goals create+start (P-013 / D-005 — full-auto goal rail)
 * ──────────────────────────────────────────────────────────────────────── */

export interface GoalDispatchPortOptions {
  /** Harness/install slug the goal is filed against and its agent boots in. */
  harnessSlug: string;
  /** Workspace override (default: the active workspace at dispatch time). */
  workspaceId?: string;
  /** Who caused the start (stamped as goal metadata.startedBy). Default 'scout-goal-rail'. */
  launchedBy?: string;
}

/**
 * Production `goalDispatch` port — creates the `harness_shared.goals` row AND starts
 * its headless GOAL-mode agent via {@link autoStartGoal} (the machine-caller sibling
 * of `goals:start`, same row→mode→spawn order and rollback). The router has already
 * drafted the two D-005 rails (kill criterion + spend ceiling) and the port's request
 * type requires both, so no auto-created goal can start without them. Loaded lazily:
 * the start core pulls the console-launcher machinery, which most router-deps
 * consumers (tests, drills) never need.
 */
export function buildGoalDispatchPort(opts: GoalDispatchPortOptions): GoalDispatchPort {
  return async ({ proposal, title, killCriterion, budgetCents }) => {
    const { autoStartGoal } = await import('../goals/goal-auto-start');
    const res = await autoStartGoal({
      harnessSlug: opts.harnessSlug,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts.launchedBy ? { launchedBy: opts.launchedBy } : {}),
      title,
      body: improvementBody(proposal),
      killCriterion,
      budgetCents,
      proposalId: proposal.id,
    });
    for (const w of res.warnings) {
      console.warn(`[scout/goal-rail] goal ${res.goalId}: ${w}`);
    }
    return { goalId: res.goalId };
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * goal-with-target → goals:update (D-004/D-013 — amendment, never creation)
 * ──────────────────────────────────────────────────────────────────────── */

export interface GoalAmendmentDispatchPortOptions {
  /** Harness that owns the Scout cycle; carried into the in-process tool ctx. */
  harnessSlug: string;
  /** Workspace override (default: the active workspace at dispatch time). */
  workspaceId?: string;
  /** Audit author written by goals:update history. */
  uiClientId?: string;
}

export interface GoalUpdateDispatchArgs {
  id: string;
  body: string;
  reason: string;
}

/** Injectable only so the proposal→goals:update mapping is unit-testable. The
 * production default dispatches the registered tool itself — never duplicate SQL. */
export type GoalUpdateDispatcher = (
  args: GoalUpdateDispatchArgs,
  opts: GoalAmendmentDispatchPortOptions,
) => Promise<unknown>;

async function dispatchGoalUpdateThroughTool(
  args: GoalUpdateDispatchArgs,
  opts: GoalAmendmentDispatchPortOptions,
): Promise<unknown> {
  const [{ handleHttpToolRequest }, { ADMIN_PROXY_HOST_EXTRAS }, { activeWorkspaceId }] = await Promise.all([
    import('@papercusp/agent-mcp'),
    import('../endpoint-route/routes/admin/proxy-host-extras'),
    import('../workspace-registry'),
  ]);
  const searchParams = new URLSearchParams({
    superuser: '1',
    client: opts.uiClientId ?? 'scout-goal-amendment',
    harness: opts.harnessSlug,
    workspace: opts.workspaceId ?? activeWorkspaceId(),
  });
  const response = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: '/api/agent-tools/goals/update',
      searchParams,
      headers: {},
      body: args,
    },
    ADMIN_PROXY_HOST_EXTRAS,
  );
  if (response.status !== 200) {
    throw new Error(`goals:update returned HTTP ${response.status}`);
  }
  const envelope = response.body as { content?: Array<{ type: string; text?: string }> };
  const text = envelope.content?.find((part) => part.type === 'text')?.text;
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const reasons = Array.isArray(parsed.degradedReasons)
    ? parsed.degradedReasons.filter((reason): reason is string => typeof reason === 'string').join('; ')
    : '';
  if (parsed.ok === false || parsed.data === null || parsed.degraded === true) {
    throw new Error(`goals:update refused amendment${reasons ? `: ${reasons}` : ''}`);
  }
  return parsed;
}

/**
 * Production amendment adapter. It changes only the goal body and records a
 * proposal-derived reason: title, budget, kill criterion, and status remain
 * untouched unless a future Proposal type explicitly carries those fields.
 * `goals:update` supplies the append-only before/after audit history.
 */
export function buildGoalAmendmentDispatchPort(
  opts: GoalAmendmentDispatchPortOptions,
  dispatch: GoalUpdateDispatcher = dispatchGoalUpdateThroughTool,
): GoalAmendmentDispatchPort {
  return async ({ proposal, targetGoalId }) => {
    const body = improvementBody(proposal).slice(0, 20_000);
    const reason = (
      `Scout proposal ${proposal.id}: ` +
      (proposal.whyNew?.trim() || proposal.bet?.trim() || proposal.framing?.trim() || 'amendment')
    ).slice(0, 500);
    await dispatch({ id: targetGoalId, body, reason }, opts);
    return { goalId: targetGoalId };
  };
}
