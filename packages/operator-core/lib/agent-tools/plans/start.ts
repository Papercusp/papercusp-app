/**
 * plans:start — approve a plan and promote its items into work_items.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 1 P-002.
 *
 * ⚠ THE op_status WRITE IS GATED (retire-mug-kettle-su-only-2026-08-09 P-047 /
 * D-010). op_status ('started' | 'paused') is the OPERATIONAL axis — the
 * "pickable by the orchestrator" bit — and it retires with the Mug/Kettle tier.
 * P-068 DELETED `FLAGS.MUG_KETTLE_SYSTEM`, so the retirement is PERMANENT — there
 * is no flag left to flip. This tool does everything it always did EXCEPT write op_status:
 * terminal check, start gate, draft→'ready' auto-approve, and `promotePlanItems`
 * all still run. The verb is NOT refused, deliberately — promotion is what fills
 * the su queue, and gating the mechanism instead of the writer is exactly why
 * P-044 was dropped ("the cut was backwards").
 *
 * WHY THE WRITE IS THE HARMFUL HALF: op_status does not ENABLE anything for su.
 * `reservedPlanLaneExclusionSql` (work-items.ts) RESERVES a started/paused plan's
 * items FROM scheduler self-selection, because a DISPATCHER is meant to hand them
 * out. Retire the dispatcher and leave the writer, and every newly-started plan
 * silently strands its own items — reserved for nobody, presenting as "the queue
 * is empty". The READER half (dropping the op_status leg for already-reserved
 * plans) is P-048, deliberately NOT done here: D-055 measured 34 items across 6
 * plans behind it and requires the DBOS frontier to be settled in the same change.
 *
 * Sets op_status='started' on the plan's harness_shared.harness_plans row
 * (operational columns folded in from the retired harness_plan_status table —
 * plans-pg-canonical-migration-2026-06-03) when the tier IS enabled.
 * If the plan was previously paused or done it is re-activated.
 * Starting an already-started plan is a no-op (idempotent).
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): on a REAL
 * op_status transition (`transitioned: true` — not the idempotent re-start) a
 * `coord:emit` lifecycle notification fires to the plan's watchers. The Queen's
 * default wake subscription rides the same tool event (lib/hive/wake-defaults).
 * With the tier retired nothing transitions, so the demand event stays silent —
 * correct, since its subscriber is the retired Queen.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolvePlanWriteScope } from './_write-scope';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { evaluateConversationActivationGate } from './plan-activation-gate';
import { flipPlanFrontmatterStatus } from './set-plan-status';
import { readPlanBySlug } from './source';
import { isTerminalPlanStatus } from './plan-start-state';
import { checkPlanStartable } from './plan-start-gate';
import { evaluatePlanStartReadiness, type PlanStartReadiness } from './plan-input-validation';
import { parsePlan } from './parser';
import {
  invalidPlanDependenciesValue,
  validatePlanCandidateDependencies,
} from './plan-candidate-dependencies';
import { evaluatePlanSpecQualityGate, type PlanSpecQualityGateVerdict } from './plan-spec-quality-gate';
import { mugKettleSystemEnabled } from '../../pot/started';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { buildPromotedRows, upsertPromotedBlock } from '../coordination/tools/promote';
import { titleFromPlanItem } from '../../plan-workitem-promotion';
import type { PromotePlanResult } from '../../plan-workitem-promotion-run';
import type { ActivationAuditEditNotice } from '../../plan-audits';
import {
  planRevisionCapture,
  PlanRevisionUnavailableError,
  type PlanRevisionCtx,
} from './revisions';

/** Boolean that also accepts the exact wire strings 'true'/'false' — same
 * EI-302 manifest-pinned-schema tolerance as plans:new's `force`. */
const stringTolerantBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

// plans:start runs the approval, promotion, generated-block, admission, and
// claim-spec legs synchronously. Keep the transport/dispatch budget above the
// flat MCP deadline so a legitimate long saga returns its structured outcome
// instead of an ambiguous timeout (EI-22583060887975914).
export const PLANS_START_TIMEOUT_SEC = 120;

const argsSchema = z
  .object({
    slug: z.string().min(1).optional().describe('Plan slug to start (filename without .md).'),
    slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to start in one call.'),
    consulted: stringTolerantBool
      .optional()
      .describe(
        'Answer to a `consult_available` refusal (P-010 checkpoint consult). Pass true after actually consulting a listed candidate (name the consult in consult_reason), or false + consult_reason to proceed WITHOUT consulting (the reason is recorded). Omit on a first call — the checkpoint routing runs then. Applies to every slug in a bulk call. Accepts the wire strings "true"/"false" too.',
      ),
    consult_reason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('Why you are overriding (consulted: false) or what the consult concluded (consulted: true). Recorded.'),
    harness: harnessArg,
  })
  .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
    message: 'pass `slug` or `slugs`',
  })
  .refine((a) => a.consulted !== false || Boolean(a.consult_reason), {
    message:
      'consulted: false requires consult_reason — state why you are proceeding without consulting (it is recorded)',
  });

export default defineTool({
  name: 'plans:start',
  description:
    "Approve a plan and promote its open items to claimable work-items. A draft moves to ready only after `plans:audit { phase:'activation' }`; plans with first-class clauses also require the spec-quality chain and a settled non-author `grading-integrity` audit. Re-starting is a no-op. Runs a plan-start consult and may return `consult_available`; override with `consulted` + `consult_reason`.",
  guidance: {
    when: "After auditing the complete plan conversation and recording `plans:audit { phase:'activation' }`. For first-class clauses, finish `plans:evaluate-spec-quality` → terminal `scorecards:emit` → independent `grading-integrity` audit before starting.",
    notWhen: 'The plan is already started; use plans:pause or plans:set-run-status.',
    chaining: "Audit → `plans:audit { phase:'activation' }` → `plans:evaluate-spec-quality { slug }` → terminal `scorecards:emit` → non-author `grading-integrity` audit → verify it is settled → `plans:start { slug }`. Re-audit after material edits; cosmetic edits do not require it. See `/internal/docs/system/plan-inputs`.",
    seeAlso: [
      'plans:launch (have an agent autonomously advance the started plan)',
      'plans:set-status (manually move items along once started)',
      'plans:pause (suspend a started plan)',
    ],
  },
  capability: 'plans:write',
  // Idempotent-completion (backend-reliability-100pct-2026-07-03 W6/P-007;
  // EI-21832071416959895): plans:start is a multi-step approval/promotion
  // saga, but every leg is retry-safe — draft→ready is conditional, plan-item
  // promotion is condition-keyed, the generated Promoted block is an upsert,
  // and exact-plan admission is an idempotent binding. If the handler finishes
  // just after the transport deadline, surface its structured partial outcome
  // instead of a false timeout that hides what landed and invites a duplicate
  // retry. Inert except in the dispatch abort-race branch.
  idempotent: true,
  timeoutSec: PLANS_START_TIMEOUT_SEC,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  // Demand surfaces as an EVENT (start-hive-wake P-001 / D-001): a real
  // started-transition notifies the plan's watchers. The idempotent re-start
  // (`transitioned: false`) stays silent — no watcher value, no Queen demand.
  emits: [
    {
      fire: 'coord:emit',
      when: (e) => Boolean((e.result?.data as { transitioned?: boolean } | undefined)?.transitioned),
      render: (e) => {
        const data = e.result.data as {
          slug: string;
          harnessSlug?: string;
          previousOpStatus?: string | null;
          autoApproved?: boolean;
        };
        return {
          category: 'demand',
          summary: `plan started: ${data.slug}${data.previousOpStatus ? ` (was ${data.previousOpStatus})` : ''}`,
          ...(data.autoApproved ? { body: 'draft auto-approved → ready by the start' } : {}),
          plan_slug: data.slug,
          to: [`@plan:${data.slug}`],
        };
      },
    },
  ],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    // ⚠ WI-5125 / EI-16183 / WI-5825 class — resolved ONCE for the whole call
    // (the harness is a single arg) from the SAME authority the readers use.
    // This handler reads the plan via readPlanBySlug(ctxToPlanSourceOpts(sctx))
    // and then writes its harness_plans row, so deriving the write key on a
    // second path is precisely how the two come to disagree. See
    // resolvePlanWriteScope's doc comment for the three generations of this bug.
    // Never activeWorkspaceId(), never a DEFAULT_WORKSPACE_ID literal, never the
    // un-collapsed ctx slug.
    const { workspaceId: startWorkspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const now = new Date().toISOString();

        const read = await readPlanBySlug(slug, await ctxToPlanSourceOpts(sctx));
        // WI-7259 (sibling of WI-7246): a scheduled-run snapshot copies its
        // parent plan's body verbatim, frontmatter included — reading
        // frontmatter here would gate on the PARENT's lifecycle, not this
        // row's. `row.status` is the canonical column for the slug actually
        // being started.
        const lifecycle = read?.row.status ?? read?.parsed.frontmatter.status ?? null;
        if (isTerminalPlanStatus(lifecycle)) {
          ctxAny.metadata?.({ slug, harnessSlug, refused: 'plan_terminal', status: lifecycle });
          return {
            ok: false as const,
            slug,
            harnessSlug,
            error: 'plan_terminal',
            status: lifecycle,
            message: `Plan is ${lifecycle}; reopen it (set status back to ready/draft) before starting.`,
          };
        }

        // P-009: start is an execution door even with the retired op_status
        // axis. Validate the body under the TARGET executable state before the
        // consult, any operational write, auto-approval, or promotion. Passing
        // `started` is deliberate: scheduled-instance rows can carry copied
        // frontmatter, and a draft forward ref stops being allowable the moment
        // this call would make its items executable.
        if (read) {
          const dependencyVerdict = validatePlanCandidateDependencies(read.parsed, 'started');
          if (dependencyVerdict.state === 'rejected') {
            const refusal = invalidPlanDependenciesValue(slug, dependencyVerdict);
            ctxAny.metadata?.({ slug, harnessSlug, refused: refusal.code });
            return {
              ok: false as const,
              slug,
              harnessSlug,
              error: refusal.code,
              message: refusal.message,
              dependencyDiagnostics: refusal.dependencyDiagnostics,
            };
          }
        }

        // P-004: start is an execution/auto-approval door, so legacy ready
        // rows and draft→ready auto-approval cannot bypass the same audit gate
        // enforced by the content-write chokepoint.
        if (read) {
          const conversationGate = await withWorkspace(startWorkspaceId, (tx) =>
            evaluateConversationActivationGate(tx as never, {
              workspaceId: startWorkspaceId,
              harnessSlug,
              planSlug: slug,
            }),
          );
          if (!conversationGate.satisfied) {
            ctxAny.metadata?.({ slug, harnessSlug, refused: conversationGate.code });
            return {
              ok: false as const,
              slug,
              harnessSlug,
              error: conversationGate.code ?? 'conversation_audit_required',
              message: conversationGate.message,
              ...(conversationGate.unresolvedItems ? { unresolvedItems: conversationGate.unresolvedItems } : {}),
            };
          }
        }

        // P-006 start gate. `start` is gated even though it only flips status
        // (D-008 Q1): a started plan is one the orchestrator may pick promoted
        // features from, so it IS an execution signal. Gating the earliest door means
        // a plan missing its arguments is caught here rather than by whichever
        // downstream thing eventually tries to run it.
        // The 'start' door is named explicitly rather than left to the default: the
        // door is what the P-004 admission verdict is ABOUT, so a site that does not
        // say which door it is cannot be audited as wired.
        const gate = await checkPlanStartable(slug, await ctxToPlanSourceOpts(sctx), null, 'start');
        if (!gate.ok) {
          ctxAny.metadata?.({ slug, harnessSlug, refused: gate.refusal.code });
          // The refusal already carries `slug`; only harnessSlug is additive here.
          return { ok: false as const, harnessSlug, ...gate.refusal };
        }

        // P-004: first-class spec adopters fail closed on the exact current
        // specSetHash BEFORE the consult/status/promotion side effects. Legacy
        // plans with zero first-class clauses remain explicitly report-only.
        let specQuality: PlanSpecQualityGateVerdict | undefined;
        if (read) {
          const planItemIds = (read.row.items.length ? read.row.items : read.parsed.items).map((item) => item.id);
          specQuality = await evaluatePlanSpecQualityGate({
            harnessSlug,
            planSlug: slug,
            planItemIds,
          });
          ctxAny.metadata?.({
            slug,
            harnessSlug,
            specQualityMode: specQuality.mode,
            specQualitySatisfied: specQuality.satisfied,
            specSetHash: specQuality.specSetHash,
            ...(specQuality.code ? { specQualityCode: specQuality.code } : {}),
          });
          if (!specQuality.satisfied) {
            return {
              ok: false as const,
              slug,
              harnessSlug,
              error: 'spec_quality_not_current' as const,
              ...specQuality,
            };
          }
        }

        // EI-22641157890335835: establish that the exact-plan claim lane is
        // measurable BEFORE approval, promotion, or the generated Promoted
        // block write. The full admission check below intentionally runs again
        // after promotion because it is the authoritative coverage verdict;
        // this earlier read only prevents a lane-health UNKNOWN from allowing
        // durable start mutations that end in an admission_refused response.
        let laneHealthPreflight: Awaited<
          ReturnType<typeof import('./plan-admission-preflight').preflightExactPlanLaneHealth>
        > | null = null;
        let laneHealthPreflightError: string | null = null;
        try {
          const [{ preflightExactPlanLaneHealth }, { resolveAgentIdentity }] = await Promise.all([
            import('./plan-admission-preflight'),
            import('../coordination/identity'),
          ]);
          const ownerId = resolveAgentIdentity(ctx).ownerId;
          laneHealthPreflight = await preflightExactPlanLaneHealth({
            workspaceId: startWorkspaceId,
            harnessSlug,
            planSlug: slug,
            actor: ownerId,
            claimant: ownerId,
            specId: `plans-start-${slug}`,
          });
          if (!laneHealthPreflight || laneHealthPreflight.effective.claimable == null) {
            const message = laneHealthPreflight
              ? 'The exact-plan claim lane could not be read completely before approval or promotion.'
              : 'The exact-plan claim lane could not be measured before approval or promotion.';
            ctxAny.metadata?.({
              slug,
              harnessSlug,
              refused: 'admission_refused',
              admissionReason: 'lane-unknown',
              laneHealthPreflight: laneHealthPreflight ? 'unknown' : 'unavailable',
            });
            return {
              ok: false as const,
              error: 'admission_refused' as const,
              slug,
              harnessSlug,
              admissionReason: 'lane-unknown' as const,
              laneHealthPreflight,
              message,
            };
          }
        } catch (error) {
          laneHealthPreflightError = error instanceof Error ? error.message : String(error);
          ctxAny.metadata?.({
            slug,
            harnessSlug,
            refused: 'admission_refused',
            admissionReason: 'lane-unknown',
            laneHealthPreflight: 'error',
          });
          return {
            ok: false as const,
            error: 'admission_refused' as const,
            slug,
            harnessSlug,
            admissionReason: 'lane-unknown' as const,
            laneHealthPreflight,
            laneHealthPreflightError,
            message: `The exact-plan claim lane could not be measured before approval or promotion: ${laneHealthPreflightError}`,
          };
        }

        // P-010 (get-feedback-relevance-consults-2026-08-16) as amended by
        // consult-min-max-and-rubric-vetting-2026-08-17 P-002 (D-001 §2): the
        // plan-start CHECKPOINT consult runs with min:1 — a plan never
        // promotes with zero feedback merely because nobody cleared the
        // relevance floor. The ROUTING is mandatory (the plan body is the
        // system-authored query); a wake is not. ANY selectable live/parked
        // candidate — floor-qualified or best-available minimum fill, labeled
        // via:'floor'|'minimum' (D-002) — nudge-refuses ONCE (override:
        // consulted:false + consult_reason — the similar_exists/force shape);
        // a floor-qualified-but-all-owner-paused set injects transcript
        // excerpts instead (retrieval, not consult); the proceed verdicts
        // survive only where the minimum is physically unfillable (D-003:
        // all_responders_paused / no_qualified_responder — recorded, not
        // silent). Liveness partitions nothing here any more (D-002).
        // NUDGE, never a hard block: any router/infra fault proceeds.
        let checkpointConsult: Record<string, unknown> | undefined;
        if (args.consulted !== undefined) {
          // Override / acknowledgement path: routing already ran on the
          // refused call — record the caller's disposition durably (the
          // tool_invocations ledger via ctx.metadata + the result) and start.
          checkpointConsult = {
            overridden: true,
            consulted: args.consulted,
            ...(args.consult_reason ? { reason: args.consult_reason } : {}),
          };
          ctxAny.metadata?.({
            slug,
            harnessSlug,
            consultOverride: args.consulted,
            ...(args.consult_reason ? { consultReason: args.consult_reason } : {}),
          });
        } else if (read?.row.content) {
          try {
            const [
              { getOrgPg },
              { routeConsult },
              { buildQueryEmbedderResolved },
              { resolveProseProfileSelection },
              { resolveSessionStates },
              consult,
              { resolveAgentIdentity },
            ] = await Promise.all([
              import('@papercusp/db-org'),
              import('../../consult/relevance-router'),
              import('../search/embedder'),
              import('../../search/prose-vector-dims'),
              import('../coordination/liveness-oracle'),
              import('../../consult/plan-start-consult'),
              import('../coordination/identity'),
            ]);
            const resolved = await buildQueryEmbedderResolved();
            const embeddingProfile = resolved
              ? resolveProseProfileSelection(resolved.mode, resolved.profile)
              : null;
            const outcome = await consult.planStartConsult(
              {
                workspaceId: startWorkspaceId,
                requesterId: resolveAgentIdentity(ctx).ownerId,
                planSlug: slug,
                planContent: read.row.content,
              },
              {
                route: (params) =>
                  routeConsult(params, {
                    getSql: () => getOrgPg().sql,
                    embed: resolved?.embed ?? null,
                    embeddingProfile,
                    embeddingMode: embeddingProfile && resolved ? resolved.mode : null,
                    getLiveness: async (ownerIds) => {
                      const verdicts = await resolveSessionStates(
                        ownerIds.map((ownerId) => ({ ownerId })),
                        { hydratePerId: true },
                      );
                      return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, v.sessionState]));
                    },
                  }),
                getExcerpts: (refs) => consult.fetchTurnExcerpts(getOrgPg().sql, startWorkspaceId, refs),
              },
            );
            ctxAny.metadata?.({
              slug,
              harnessSlug,
              checkpointConsult: outcome.outcome,
              ...(outcome.outcome === 'proceed' ? { checkpointVerdict: outcome.verdict } : {}),
            });
            if (outcome.outcome === 'nudge') {
              const hasMinimumFill = outcome.selection.selected.some((s) => s.via === 'minimum');
              return {
                ok: false as const,
                slug,
                harnessSlug,
                error: 'consult_available' as const,
                candidates: outcome.candidates,
                selection: outcome.selection,
                hint:
                  'Peers with relevant transcript history were selected for this plan — `selection.selected` labels each: via "floor" = cleared the router\'s precision floor on real evidence; via "minimum" = best-available LIVE peer BELOW the floor, selected because the plan-step consult carries a minimum of 1 (a plan never promotes with zero feedback merely because nobody cleared the threshold; a wrong plan assumption multiplies across every promoted item, so this is the cheapest moment to check it). ' +
                  (hasMinimumFill
                    ? 'A via:"minimum" candidate should review from FIRST PRINCIPLES — their selection is best-available, not evidence-matched. '
                    : '') +
                  'Review the candidates + their evidence turns; consult via get_feedback { question } — its default minResponders:1 reaches at least the best-available live peer. ' +
                  'Then re-call plans:start with consulted: true (+ consult_reason naming what the consult concluded), or consulted: false + consult_reason to proceed without consulting — the override always works; this is a nudge, never a gate.',
              };
            }
            if (outcome.outcome === 'proceed' && outcome.verdict === 'all_responders_paused') {
              // Not silent (P-002): a candidate pool existed but the
              // owner-pause gate kept every one of them out — record the
              // honest verdict on the result.
              checkpointConsult = {
                verdict: 'all_responders_paused',
                note: "The plan-start consult found candidate peer history, but every matched expert's OWNER is paused (min:1 physically unfillable) — the start proceeded. Consider get_feedback later once an owner resumes.",
              };
            }
            if (outcome.outcome === 'proceed_with_excerpts') {
              checkpointConsult = {
                verdict: 'routed_paused_context',
                note: "The router found above-floor peer history for this plan, but every matched expert's OWNER is paused, so no session may be started from them — their matched transcript excerpts are injected here instead (retrieval, not consult). Read them before fanning out.",
                candidates: outcome.candidates.map((c) => ({
                  ownerId: c.ownerId,
                  score: c.score,
                  liveness: c.liveness,
                })),
                excerpts: outcome.excerpts,
              };
            }
          } catch {
            /* nudge, never block — a router/infra fault must not stop a start */
          }
        }

        let autoApproved = false;
        let activationAudit: ActivationAuditEditNotice | null = null;
        type CommitRefusal = {
          ok: false; code: string; message: string; readiness?: PlanStartReadiness; detail?: unknown;
        };
        try {
          const revision = planRevisionCapture(
            ctx as PlanRevisionCtx,
            slug,
            'plans:start → auto-approve draft',
            { workspaceId: startWorkspaceId, harnessSlug },
          );
          if (!revision.inTransaction) {
            return {
              ok: false as const,
              slug,
              harnessSlug,
              error: 'plan_revision_unavailable',
              message: 'Cannot auto-approve a draft plan without an attributable transactional revision writer.',
            };
          }
          const flipResult = await withPlanLock<boolean | CommitRefusal>(
            ctx as never,
            {
              slug,
              intent: 'plans:start → auto-approve draft',
              ...(harnessSlug ? { harnessSlug } : {}),
              workspaceId: startWorkspaceId,
              revisionInTransaction: revision.inTransaction,
            },
            async (current, meta) => {
              // Earlier readiness/consult reads are not write authority.
              // Validate the locked inputs even on an already-ready plan,
              // then require the plan revision that was preflighted.
              if (current === null || !meta) return {
                newBody: null,
                value: { ok: false, code: 'plan_not_found', message: `Plan '${slug}' disappeared before approval.` },
              };
              const lockedPlan = parsePlan(current, { filePath: `${slug}.md` });
              const readiness = evaluatePlanStartReadiness({
                template: lockedPlan.frontmatter.template ?? null, inputSchema: meta.inputSchema,
              }, meta.templateData);
              if (!readiness.ready) return {
                newBody: null,
                value: { ok: false, code: 'plan_inputs_not_ready', message: readiness.hint, readiness },
              };
              if (!read || meta.version !== read.row.version) return {
                newBody: null,
                value: {
                  ok: false, code: 'plan_changed',
                  message: `Plan '${slug}' changed after preflight. Retry against the current revision; no approval or promotion was written.`,
                },
              };
              // Admission/certificates and the acceptance class live outside
              // this row's version. Reuse their canonical readers at the write
              // boundary too: an earlier pass must not outlive a revocation or
              // a changed class/spec policy while the consult was running.
              const currentGate = await checkPlanStartable(slug, await ctxToPlanSourceOpts(sctx), null, 'start');
              if (!currentGate.ok) return {
                newBody: null,
                value: {
                  ok: false, code: currentGate.refusal.code,
                  message: 'Plan prerequisites no longer permit start at the approval boundary.',
                  detail: currentGate.refusal,
                },
              };
              const currentSpecQuality = await evaluatePlanSpecQualityGate({
                harnessSlug, planSlug: slug, planItemIds: lockedPlan.items.map((item) => item.id),
              });
              if (!currentSpecQuality.satisfied) return {
                newBody: null,
                value: {
                  ok: false, code: currentSpecQuality.code ?? 'spec_quality_not_current',
                  message: currentSpecQuality.message ?? 'Current spec policy no longer permits start.',
                  detail: currentSpecQuality,
                },
              };
              specQuality = currentSpecQuality;
              const flip = flipPlanFrontmatterStatus(current, 'ready', 'draft');
              if (flip.newBody === null) return { newBody: null, value: false };
              return { newBody: bumpUpdatedDate(flip.newBody), value: true };
            },
          );
          if (flipResult.kind === 'busy') {
            return { ok: false as const, slug, harnessSlug, error: 'plan_locked', busy: flipResult.busy };
          }
          if (typeof flipResult.value === 'object' && flipResult.value?.ok === false) {
            return { slug, harnessSlug, error: flipResult.value.code, ...flipResult.value };
          }
          autoApproved = flipResult.kind === 'applied' && flipResult.value === true;
          activationAudit = flipResult.kind === 'applied'
            ? (flipResult.activationAudit ?? null)
            : null;
        } catch (error) {
          if (error instanceof PlanRevisionUnavailableError) {
            return {
              ok: false as const,
              slug,
              harnessSlug,
              error: error.code,
              message: error.message,
            };
          }
          return {
            ok: false as const, slug, harnessSlug, error: 'plan_start_revalidation_unavailable',
            message: error instanceof Error ? error.message : String(error),
          };
        }

        // Commit-boundary refusals (including the body writer's own gates)
        // must leave operational state and calibration untouched. Begin those
        // side effects only after locked approval has successfully returned.
        // P-047 / D-010: the op_status axis retires with the Mug/Kettle tier.
        // Fail-CLOSED via mugKettleSystemEnabled (an unreadable flag resolves to
        // retired) — a false `true` re-reserves a plan's items for a dispatcher
        // that is not running, which is the failure this gate exists to stop.
        const axisLive = await mugKettleSystemEnabled();

        type StartRow = { op_status: string | null; op_updated_at: string | null; prev_op_status: string | null };
        // RETIRED branch: READ the row instead of writing it, on the SAME
        // (workspace, harness, slug) key the UPDATE used — so the plan_not_found
        // detection below (WI-5825) keeps working identically. `prev_op_status`
        // mirrors the current value, so `transitioned` is false by construction.
        const rows: StartRow[] = !axisLive
          ? await withWorkspace(startWorkspaceId, async (tx) => {
              return tx<StartRow[]>`
                SELECT op_status, op_updated_at, op_status AS prev_op_status
                  FROM harness_shared.harness_plans
                 WHERE workspace_id = ${startWorkspaceId}
                   AND harness_slug = ${harnessSlug}
                   AND plan_slug    = ${slug}
                 LIMIT 1
              `;
            })
          : await withWorkspace(startWorkspaceId, async (tx) => {
              return tx<StartRow[]>`
                UPDATE harness_shared.harness_plans AS p
                   SET op_status     = 'started',
                       op_started_at = COALESCE(p.op_started_at, ${now}),
                       op_updated_at = ${now}
                  FROM (
                    SELECT plan_slug, op_status AS prev_op_status
                      FROM harness_shared.harness_plans
                     WHERE workspace_id = ${startWorkspaceId}
                       AND harness_slug = ${harnessSlug}
                       AND plan_slug    = ${slug}
                       FOR UPDATE
                  ) prev
                 WHERE p.workspace_id = ${startWorkspaceId}
                   AND p.harness_slug = ${harnessSlug}
                   AND p.plan_slug    = prev.plan_slug
                RETURNING p.op_status, p.op_updated_at, prev.prev_op_status
              `;
            });

        const row = rows[0];
        // WI-5825: 0 rows means no such plan in this (workspace, harness) —
        // report it. This handler used to return ok:true / status:'started'
        // regardless of rows affected, so a mis-scoped UPDATE announced a start
        // that never happened (and then emitted the `plan started` demand event
        // on it). A write that matched nothing is a failure, not a start.
        if (!row) {
          ctxAny.metadata?.({ slug, harnessSlug, refused: 'plan_not_found' });
          return {
            ok: false as const,
            slug,
            harnessSlug,
            error: 'plan_not_found',
            message: `no plan '${slug}' in ${startWorkspaceId}/${harnessSlug}`,
          };
        }
        // `axisLive &&` is load-bearing, not belt-and-braces: in the retired
        // branch prev_op_status is the row's CURRENT value, so a never-started
        // plan would otherwise score `null !== 'started'` = transitioned and fire
        // the demand event for a start that never happened.
        const transitioned = axisLive && row.prev_op_status !== 'started';

        if (transitioned) {
          void Promise.all([import('../../calibration/capture'), import('../coordination/identity')])
            .then(([cal, ident]) =>
              cal.recordPrediction({
                predictor: ident.resolveAgentIdentity(ctx).ownerId,
                domain: 'plan-ship',
                subjectKind: 'plan',
                subjectId: slug,
                claim: `plan ${slug} reaches status shipped within the horizon of its start`,
                harnessSlug: harnessSlug ?? null,
              }),
            )
            .catch(() => {});
        }

        ctxAny.metadata?.({ slug, harnessSlug, status: row?.op_status, autoApproved, transitioned });

        // EI-21016597300738770: promotion used to run detached and its result was
        // discarded. A spec-triad refusal therefore returned `ok:true` from this
        // tool, then a fleet launch saw only a generic zero-row lane — even though
        // promotePlanItems had already produced the exact missing legs + repair WI.
        // Await the idempotent promotion so the approval result carries the actual
        // queue outcome. Promotion remains best-effort with respect to approval: a
        // failure is reported explicitly, but does not roll back the plan status.
        let promotion: PromotePlanResult | null = null;
        let promotionError: string | null = null;
        try {
          const [{ promotePlanItems }, { resolveAgentIdentity }] = await Promise.all([
            import('../../plan-workitem-promotion-run'),
            import('../coordination/identity'),
          ]);
          promotion = await promotePlanItems({
            workspaceId: startWorkspaceId,
            harnessSlug,
            planSlug: slug,
            createdBy: resolveAgentIdentity(ctx).ownerId,
          });
        } catch (error) {
          promotionError = (error as Error).message;
        }

        // EI-21594810094177772: plans:start promotes plan items into work-items,
        // but previously left the source plan without the generated `## Promoted`
        // block. That made a successful start lint-red until a separate
        // plans:promote/backfill call happened. Reuse the canonical row builder
        // and body writer from plans:promote so retries are idempotent and the
        // work-item ids are recorded with their source plan-item provenance.
        let promotedBlock: { ok: true; rows: number; changed: boolean } | null = null;
        let promotedBlockError: string | null = null;
        if (promotion && promotion.workItems.length > 0) {
          const sourceItems = new Map((read?.parsed.items ?? []).map((item) => [item.id, item]));
          const rowFeatures = promotion.workItems.map(({ planItemId, workItemId }) => {
            const sourceItem = sourceItems.get(planItemId);
            return {
              title: sourceItem ? titleFromPlanItem(sourceItem) : workItemId,
              from_items: [planItemId],
            };
          });
          const rowIds = promotion.workItems.map(({ workItemId }) => workItemId);
          const writeIntent = 'plans:start → write ## Promoted block for promoted work-items';
          try {
            const revision = planRevisionCapture(
              ctx as PlanRevisionCtx,
              slug,
              writeIntent,
              { workspaceId: startWorkspaceId, harnessSlug },
            );
            const writeResult = await withPlanLock<
              { ok: true; rows: number; changed: boolean } | { ok: false; error: string; message: string }
            >(
              ctx as never,
              {
                slug,
                intent: writeIntent,
                workspaceId: startWorkspaceId,
                harnessSlug,
                afterWrite: revision.afterWrite,
              },
              async (current) => {
                if (current === null) {
                  return {
                    newBody: null,
                    value: {
                      ok: false as const,
                      error: 'plan_not_found',
                      message: `no plan '${slug}' in ${startWorkspaceId}/${harnessSlug}`,
                    },
                  };
                }
                const rows = buildPromotedRows(rowFeatures, rowIds);
                const nextBody = upsertPromotedBlock(current, rows);
                return {
                  newBody: nextBody === current ? null : bumpUpdatedDate(nextBody),
                  value: { ok: true as const, rows: rows.length, changed: nextBody !== current },
                };
              },
            );
            if (writeResult.kind === 'busy') {
              promotedBlockError = 'plan_locked';
            } else if (!writeResult.value.ok) {
              promotedBlockError = writeResult.value.error;
            } else {
              promotedBlock = writeResult.value;
            }
          } catch (error) {
            promotedBlockError = error instanceof Error ? error.message : String(error);
          }
        }

        let admission: Awaited<ReturnType<typeof import('./plan-admission-preflight').preflightExactPlanAdmission>> | null = null;
        let admissionError: string | null = null;
        let claimSpecBinding: Awaited<ReturnType<typeof import('../../scheduler/claim-spec-store').setClaimSpec>> | null = null;
        let claimSpecBindingError: string | null = null;
        try {
          const [{ preflightExactPlanAdmission, buildExactPlanClaimSpec }, { resolveAgentIdentity }] = await Promise.all([
            import('./plan-admission-preflight'),
            import('../coordination/identity'),
          ]);
          const ownerId = resolveAgentIdentity(ctx).ownerId;
          admission = await preflightExactPlanAdmission({
            workspaceId: startWorkspaceId,
            harnessSlug,
            planSlug: slug,
            actor: ownerId,
            claimant: ownerId,
            specId: `plans-start-${slug}`,
            // The starter may already hold the plan's sole ready row. That is a
            // successful start, not a floor-gated admission failure; fleet launch
            // keeps the stricter unclaimed-row requirement.
            allowCallerHeld: true,
          });

          // The preflight's exact-plan spec is an in-memory admission oracle. Persist
          // the same property-filtered spec under the starter's identity before this
          // tool returns, otherwise its immediately-following scheduler:get_next falls
          // back to DEFAULT_CLAIM_SPEC and can claim a different plan's work.
          if (admission.ready) {
            try {
              const { setClaimSpec } = await import('../../scheduler/claim-spec-store');
              claimSpecBinding = await setClaimSpec({
                cupId: ownerId,
                workspaceId: startWorkspaceId,
                spec: buildExactPlanClaimSpec(`plans-start-${slug}`, slug, admission.claimKinds ?? undefined),
                updatedBy: ownerId,
                potSlug: harnessSlug,
              });
              if (!claimSpecBinding.ok) {
                claimSpecBindingError = claimSpecBinding.errors.filter(Boolean).join('; ') ||
                  'the claim-spec store rejected the exact-plan binding';
              }
            } catch (error) {
              claimSpecBindingError = (error as Error).message;
            }
          }
        } catch (error) {
          admissionError = (error as Error).message;
        }

        const promotionMessage = promotionError
          ? `Item promotion failed: ${promotionError}. The plan approval remains recorded, but no queue outcome can be claimed.`
          : promotion?.specTriadBlocked
            ? `Item promotion is blocked by the spec triad (missing: ${(promotion.specTriadMissing ?? []).join(', ') || 'required sections'}).${promotion.specTriadWorkItem ? ` Resolve ${promotion.specTriadWorkItem}, then rerun plans:start.` : ''}`
            : promotion?.specQualityBlocked
              ? 'Item promotion is blocked by the current first-class spec-quality verdict; inspect `promotion.specQuality` before retrying.'
              : promotion?.acceptanceBarBlocked
                ? `Item promotion is blocked by the acceptance BAR contract: ${promotion.acceptanceBarLifecycle?.message ?? 'inspect `promotion.acceptanceBarLifecycle` before retrying.'}`
              : promotion?.flagOff
                ? 'Item promotion is disabled by papercusp-plan-workitem-promotion; no queue rows were minted.'
                : promotion
                  ? `Item promotion completed before this response: promoted ${promotion.promoted}, skipped ${promotion.skipped}.`
                  : 'Item promotion returned no outcome; verify claimable work-items before launching a fleet.';
        const promotedBlockMessage = promotedBlockError
          ? ` Generated \`## Promoted\` block write failed: ${promotedBlockError}.`
          : promotedBlock
            ? ` Generated \`## Promoted\` block ${promotedBlock.changed ? 'written' : 'already current'} for ${promotedBlock.rows} work-item(s).`
            : '';

        if (!admission?.ready) {
          ctxAny.metadata?.({
            slug,
            harnessSlug,
            refused: 'admission_refused',
            admissionReason: admission?.reason ?? 'lane-unknown',
          });
          return {
            ok: false as const,
            error: 'admission_refused' as const,
            slug,
            harnessSlug,
            status: axisLive ? 'started' : null,
            updatedAt: row?.op_updated_at,
            autoApproved,
            transitioned,
            previousOpStatus: row?.prev_op_status ?? null,
            ...(activationAudit ? { activationAudit } : {}),
            promotion,
            ...(promotionError ? { promotionError } : {}),
            ...(promotedBlock ? { promotedBlock } : {}),
            ...(promotedBlockError ? { promotedBlockError } : {}),
            admission,
            ...(admissionError ? { admissionError } : {}),
            ...(specQuality ? { specQuality } : {}),
            ...(checkpointConsult ? { checkpointConsult } : {}),
            message: `${promotionMessage}${promotedBlockMessage} ${admission ? admission.message : `Exact-plan admission could not be measured: ${admissionError ?? 'unknown error'}`}`,
            ...(axisLive ? {} : { opStatusRetired: true as const }),
          };
        }

        if (claimSpecBindingError) {
          ctxAny.metadata?.({
            slug,
            harnessSlug,
            refused: 'claim_spec_binding_failed',
            claimSpecBindingError,
          });
          return {
            ok: false as const,
            error: 'claim_spec_binding_failed' as const,
            slug,
            harnessSlug,
            status: axisLive ? 'started' : null,
            updatedAt: row?.op_updated_at,
            autoApproved,
            transitioned,
            previousOpStatus: row?.prev_op_status ?? null,
            ...(activationAudit ? { activationAudit } : {}),
            promotion,
            ...(promotionError ? { promotionError } : {}),
            ...(promotedBlock ? { promotedBlock } : {}),
            ...(promotedBlockError ? { promotedBlockError } : {}),
            admission,
            claimSpecBinding,
            claimSpecBindingError,
            ...(specQuality ? { specQuality } : {}),
            ...(checkpointConsult ? { checkpointConsult } : {}),
            message: `${promotionMessage}${promotedBlockMessage} Exact-plan claim-spec binding failed: ${claimSpecBindingError}`,
            ...(axisLive ? {} : { opStatusRetired: true as const }),
          };
        }

        return {
          ok: true as const,
          slug,
          harnessSlug,
          // NOT 'started' while retired — reporting a status the row does not
          // carry is precisely the "announced a start that never happened" bug
          // WI-5825 fixed one layer down.
          status: axisLive ? 'started' : null,
          updatedAt: row?.op_updated_at,
          autoApproved,
          transitioned,
          previousOpStatus: row?.prev_op_status ?? null,
          ...(activationAudit ? { activationAudit } : {}),
          promotion,
          admission,
          claimSpecBinding,
          ...(promotionError ? { promotionError } : {}),
          ...(promotedBlock ? { promotedBlock } : {}),
          ...(promotedBlockError ? { promotedBlockError } : {}),
          ...(specQuality ? { specQuality } : {}),
          ...(checkpointConsult ? { checkpointConsult } : {}),
          message:
            promotionMessage +
            promotedBlockMessage +
            (axisLive
              ? ''
              : ' The operational started axis is PERMANENTLY RETIRED (P-068 DELETED papercusp-mug-kettle-system — there is no flag to flip and no toggle in /admin/features), so op_status was not written — su agents self-select these items via scheduler:get_next instead of waiting for a dispatcher.'),
          ...(axisLive
            ? {}
            : {
                opStatusRetired: true as const,
              }),
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
