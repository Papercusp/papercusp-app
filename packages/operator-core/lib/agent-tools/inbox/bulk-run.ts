/**
 * inbox:bulk-run-* — the resolver agent's interface to a BULK RESOLVE run
 * (inbox-bulk-resolve-2026-08-23, P-003).
 *
 * The owner clicks the Inbox pane's command strip; the server creates a run over
 * the exact items the pane was displaying and launches ONE resolver agent
 * (D-002). These four tools are that agent's whole contract:
 *
 *   inbox:bulk-run-manifest — what am I working on? (the run + its items, each
 *       with the LIVE `actions` the item currently offers, which is what makes a
 *       recommendation checkable rather than invented)
 *   inbox:bulk-run-act      — take ONE terminal action while the run row is
 *       locked as a revocable authority token; dispatch + audit + outcome are
 *       one serialized operation
 *   inbox:bulk-run-report   — record what I did / what I recommend (bulk, the
 *       house keyed-array contract)
 *   inbox:bulk-run-settle   — I am done; work out from the item rows whether the
 *       owner has anything left to review
 *
 * TWO INVARIANTS LIVE HERE, deliberately, rather than in the agent's prompt —
 * a prompt cannot enforce anything:
 *
 *  1. **A recommended/dispatched action id must be one the item actually
 *     offers.** The resolver sees each item's real `actions` in the manifest and
 *     `report` REJECTS an id that is not among them (Requirement 5). A
 *     hallucinated option id would otherwise reach the owner's review list
 *     pre-selected and one click from being dispatched.
 *  2. **A navigate id is never a resolution.** `discuss` / `answer` / `open` /
 *     `chat` / `view-log` open a sub-surface and change nothing server-side;
 *     accepting one as an `auto_resolved` outcome would report work that never
 *     happened. This is the same class as the EI-13037 Discuss incident, where a
 *     navigate id missing from the navigate set silently resolved real owner
 *     gates.
 */

import { z } from 'zod';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { defineTool } from '@papercusp/agent-mcp';
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { inProcessCall, type InnerCall } from '../_compound-dispatch';
import { softText, clampText, LIMITS } from '../limits';
import {
  executeBulkRunAction,
  failRunIfExecuting,
  getRun,
  getActiveRun,
  getRunItems,
  recordRunHeartbeat,
  reportOutcomes,
  settleRunPhase,
  type BulkOutcomeReport,
} from '../../attention/bulk-run-store';
import { upsertTriage } from '../../attention/triage-store';
import { notifyBulkRunAndAttentionChanged, notifyBulkRunChanged } from '../../attention/bulk-run-sync';
import {
  dispatchAttentionTerminalAction,
  type TerminalActionDependencies,
  type TerminalAttentionItem,
} from '../../attention/terminal-action-dispatch';
import { deliverInboxOwnerReply } from '../coordination/inbox-reply';
import {
  BULK_CONFIDENCE_LEVELS,
  BULK_RECOMMENDATION_KINDS,
  type BulkConfidence,
  type BulkDispositionKind,
  type BulkRecommendationKind,
  type BulkResponsibility,
} from '../../attention/bulk-dispositions';
import { readStandingBulkAutomationPolicy, standingAutomationEligibility } from '../../attention/automation-policy';

/**
 * WI-41021 — the resolver's own verbs have to honour the kill switch.
 *
 * The feature flag used to be read in exactly two places: the client strip
 * (InboxPane's useFlag) and the owner's HTTP route. Neither is on the path an
 * ALREADY-LAUNCHED resolver takes — it drives its run entirely through the three
 * tools in this file. So flipping the feature off stopped the next start and did
 * nothing at all to the agent that was already acting on the owner's inbox.
 *
 * The rule, matching the route: the flag gates ACTING, never STOPPING.
 *   - manifest: on OFF, report the run as `stopped` (below). This reuses the
 *     WI-41013 halt signal the resolver already obeys, so the flag revokes
 *     in-flight authority through machinery that exists rather than a new
 *     channel. Deliberately NOT a refusal — a refused manifest read leaves the
 *     resolver blind, and a blind resolver keeps acting on stale item state.
 *   - report: on OFF, refuse the write, same shape as a settled run.
 *   - settle: NEVER gated. It is the wind-down path; refusing it would strand
 *     runs in `running` forever, which is the same inversion one level down.
 */
async function bulkResolveEnabled(): Promise<boolean> {
  // Fail CLOSED on a flag-backend error: getFlag already falls back to
  // FLAG_DEFAULTS, and "we cannot verify the kill switch" must read as stopped,
  // never as licence to keep taking terminal actions on the owner's inbox.
  return await getFlag(FLAGS.INBOX_BULK_RESOLVE, 'system:inbox-bulk-run').catch(() => false);
}

/**
 * Action ids that open a sub-surface instead of resolving anything.
 *
 * Re-exported from the canonical declaration in `../../attention/types`, which
 * the client card re-exports too. This used to be a second hand-maintained
 * copy kept in lockstep with the client's by a test that parsed the other
 * file's source; there is now ONE set, so that drift is no longer expressible.
 */
import { NAVIGATE_ACTION_IDS, isNavigateAction } from '../../attention/types';

export { NAVIGATE_ACTION_IDS, isNavigateAction };

/** An attention item as the manifest presents it to the resolver. */
interface ManifestItem {
  itemId: string;
  position: number;
  kind: string | null;
  title: string | null;
  ref: Record<string, unknown>;
  ownerAgentId: string | null;
  outcome: string;
  /** The option ids this item genuinely offers, split by what they DO. */
  actions: { id: string; label: string; terminal: boolean }[];
  /** Already-reported disposition, so a resumed resolver does not redo work. */
  reported: { actionId: string | null; rationale: string | null; confidence: string | null } | null;
  disposition?: BulkDispositionKind;
  recommendation?: {
    kind: BulkRecommendationKind;
    label: string;
    rationale: string;
    confidence: BulkConfidence;
    responsibility: BulkResponsibility;
    actionId: string | null;
    evidenceBasis: string[];
    retryCondition: string | null;
  } | null;
}

type LiveAction = { id: string; label: string; terminal: boolean };
type LiveActionIndex = Map<string, LiveAction[]>;

interface AttentionFeedItem {
  id?: string;
  actions?: { id?: string; label?: string }[];
  ref?: { kind?: string; options?: unknown };
}

/** Normalize one canonical attention-feed item into the resolver's authority vocabulary. */
function normalizeLiveActions(it: AttentionFeedItem): LiveAction[] {
  const out: LiveAction[] = [];
  for (const action of it.actions ?? []) {
    if (typeof action?.id !== 'string') continue;
    if (
      it.ref?.kind === 'coord-escalation' &&
      (action.id === 'resolve' || action.id === 'mark-done') &&
      Array.isArray(it.ref.options)
    ) {
      for (const rawOption of it.ref.options) {
        if (!rawOption || typeof rawOption !== 'object') continue;
        const option = rawOption as { id?: unknown; label?: unknown };
        if (typeof option.id !== 'string') continue;
        out.push({
          id: option.id,
          label: typeof option.label === 'string' ? option.label : option.id,
          terminal: true,
        });
      }
      continue;
    }
    out.push({
      id: action.id,
      label: String(action.label ?? action.id),
      terminal: !isNavigateAction(action.id),
    });
  }
  return out;
}

/**
 * Read the canonical action-bearing attention feed ONCE and index it for every
 * run item. A max-size run contains 200 rows; re-reading the full feed per row
 * made manifest latency O(run size) full-feed calls and could never fit the MCP
 * deadline. Invocation-local reuse keeps membership live without creating a
 * cross-call cache whose authority could go stale.
 */
async function liveActionsById(): Promise<LiveActionIndex | null> {
  try {
    const { callPlansRead } = await import('../plans/read-dispatch');
    // The UI list projection deliberately DROPS `actions` to keep the ~1MB
    // attention feed small; the detail pane fetches them separately. A resolver
    // cannot do that: actions are its authority vocabulary. Reading the default
    // projection made every real item look like `actions:[]`, so the agent skipped
    // the entire run even though the middle pane showed Acknowledge/Resolve.
    // Ask the shared reader for the canonical shape, not the list display shape.
    const r = (await callPlansRead('attention', {}, { uiProjection: false })) as {
      groups?: { items?: unknown[] }[];
    };
    const groups = Array.isArray(r?.groups) ? r.groups : [];
    const byId: LiveActionIndex = new Map();
    for (const g of groups) {
      for (const raw of g?.items ?? []) {
        const it = raw as AttentionFeedItem;
        if (typeof it?.id !== 'string' || byId.has(it.id)) continue;
        byId.set(it.id, normalizeLiveActions(it));
      }
    }
    return byId;
  } catch {
    return null;
  }
}

/**
 * Read one item's live actions freshly. Terminal execution deliberately keeps
 * this separate lookup inside the run-row authority lock; manifest/report may
 * reuse an invocation-local index, but an irreversible action may not.
 */
async function liveActionsFor(itemId: string): Promise<LiveAction[] | null> {
  const byId = await liveActionsById();
  return byId?.get(itemId) ?? null;
}

function innerFailure(name: string, result: unknown): Error | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as Record<string, unknown>;
  if (value.ok === false || typeof value.error === 'string') {
    return new Error(`${name}: ${String(value.error ?? 'operation refused')}`);
  }
  const failed = Array.isArray(value.results)
    ? (value.results.find((entry) => entry && typeof entry === 'object' && (entry as { ok?: unknown }).ok === false) as
        | Record<string, unknown>
        | undefined)
    : undefined;
  return failed ? new Error(`${name}: ${String(failed.error ?? failed.detail ?? 'operation refused')}`) : null;
}

async function callRequired(call: InnerCall, name: string, args: Record<string, unknown>): Promise<void> {
  const result = await call(name, args);
  const failure = innerFailure(name, result);
  if (failure) throw failure;
}

/** Exported for the arg-shape contract test (WI-41370) — the inner-call names/keys here are wire contracts, not internals. */
export function terminalDependencies(input: { call: InnerCall; workspaceId?: string }): TerminalActionDependencies {
  const { call } = input;
  return {
    resolveEscalation: ({ msgId, choice }) => callRequired(call, 'coord:resolve', { msg_id: msgId, choice }),
    acknowledgeMessage: ({ msgId }) => callRequired(call, 'coord:ack', { msg_id: msgId }),
    setPlanItemStatus: ({ slug, itemId, status, rationale }) =>
      // plans:set-status takes `item` (P-NNN), NOT `itemId` — it REJECTS undeclared keys
      // (EI-10883), and `dropped` additionally requires a nonblank rationale/note (WI-41370).
      callRequired(call, 'plans:set-status', {
        slug,
        item: itemId,
        status,
        rationale: rationale?.trim() ? `Bulk resolve: ${rationale.trim()}` : 'Bulk resolve terminal action',
      }),
    async wakePlanLoop({ reason }) {
      await callRequired(call, 'pot:wake', { source: 'user', reason });
    },
    dismissImprovement: ({ issueId, rationale }) =>
      callRequired(call, 'improvements:triage', {
        mode: 'triage-one',
        ideaId: issueId,
        decision: 'reject',
        reason: rationale,
      }),
    decideStandingApproval: (args) => callRequired(call, 'operator:standing_approvals_decide', args),
    triageAttentionItem: (args) => callRequired(call, 'inbox:triage', args),
    // P-003 — the owner-gate clear. `needsHuman:false` is the compatibility input
    // that unsets BOTH the strict `payload.needsOwnerAction` and the legacy
    // `payload.needsHuman` key; unsetting only one is precisely how
    // EI-21675115869134466 leaked rows back into the inbox forever. The status
    // leg runs SECOND and only when the row's own status is the gate, so an item
    // sitting in wip/blocked for its own reasons is never yanked back to open.
    async clearWorkItemOwnerGate({ workItemId, harnessSlug, statusGated }) {
      await callRequired(call, 'work_items:update', {
        id: workItemId,
        needsHuman: false,
        ...(harnessSlug ? { harness: harnessSlug } : {}),
      });
      if (statusGated) {
        await callRequired(call, 'work_items:set_state', {
          id: workItemId,
          state: 'open',
          ...(harnessSlug ? { harness: harnessSlug } : {}),
        });
      }
    },
    retractStandingFact: ({ scope, scopeRef, key, reason }) =>
      callRequired(call, 'facts:retract', {
        scope,
        ...(scopeRef ? { scopeRef } : {}),
        key,
        reason,
      }),
    // A terminal state REQUIRES completion evidence and an explicit assumptions
    // declaration (work_items:set_state's own refines reject the call otherwise),
    // so the caller's audit rationale is threaded in as the completionRef rather
    // than inventing one at the tool boundary.
    closeWorkItem: ({ workItemId, harnessSlug, rationale }) =>
      callRequired(call, 'work_items:set_state', {
        id: workItemId,
        state: 'dropped',
        completionRef: rationale,
        assumptions: 'none',
        ...(harnessSlug ? { harness: harnessSlug } : {}),
      }),
    resolveConversation: ({ conversationId, acceptedAnswer, capture }) =>
      callRequired(call, 'conversations:resolve', {
        conversation_id: conversationId,
        accepted_answer: acceptedAnswer,
        capture,
      }),
    // `closeGate` is idempotent by contract (an already-closed or never-opened
    // ref is REPORTED, not thrown), which is what makes it safe as a terminal
    // effect a resolver may retry. `client` is not part of its key — the
    // (workspace, session, ref) triple is — so it is deliberately unused here.
    async closeSessionGate({ sessionId, refId }) {
      const [{ closeGate }, { activeWorkspaceId }] = await Promise.all([
        import('../../attention/gate-store'),
        import('../../workspace-registry'),
      ]);
      await closeGate({
        workspaceId: input.workspaceId ?? activeWorkspaceId(),
        sessionId,
        refId,
        reason: 'hook_cleared',
      });
    },
    async deliverOwnerReply(args) {
      const result = await deliverInboxOwnerReply({
        ...args,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      });
      return { live: result.live, woken: result.woken };
    },
  };
}

/** Resolve which run the caller means: an explicit id, else the active one. */
async function resolveRunId(runId?: string): Promise<string | null> {
  if (runId) return runId;
  const active = await getActiveRun();
  return active?.runId ?? null;
}

export const bulkRunManifest = defineTool({
  name: 'inbox:bulk-run-manifest',
  description:
    "Read the BULK RESOLVE run you were launched for: the run row (phase, counters, automation policy, and the owner's filter provenance) plus every item with its LIVE options and any persisted typed recommendation. Omit `runId` for the workspace's active run. Each item carries `actions:[{ id, label, terminal }]`; terminal:false only opens a sub-surface. You may only report an action id that appears in that list. If actions are empty, report a typed `retry_needed` recommendation with evidence and confidence rather than silently skipping.",
  guidance: {
    when: 'FIRST call when you are woken as a bulk-resolve resolver — it tells you what you are working on and what each item can actually do. Re-read it after a consult reply lands to pick up any item whose options changed.',
    notWhen:
      "Acting on a single attention item outside a run (use the item's own verb: coord:resolve, plans:set-status, inbox:triage). Reading the human inbox generally → plans:attention.",
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional().describe("the run to read; omit for the workspace's active run"),
    includeReported: z
      .boolean()
      .optional()
      .describe('include items already reported (default false — you normally want only what is left)'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const featureEnabled = await bulkResolveEnabled();
    const runId = await resolveRunId(args.runId);
    if (!runId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_active_run',
              hint: 'No bulk-resolve run is active in this workspace. Nothing to do — end your turn.',
            }),
          },
        ],
      };
    }

    const storedRun = await getRun(runId);
    if (!storedRun) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'run_not_found', runId }) }],
      };
    }
    const executing = storedRun.phase === 'pending' || storedRun.phase === 'running';
    const heartbeat =
      featureEnabled && executing
        ? await recordRunHeartbeat({
            runId,
            resolverOwner: identity.ownerId,
            workspaceId: storedRun.workspaceId,
          }).catch(() => null)
        : null;
    const ownershipRevoked = featureEnabled && executing && heartbeat === null;
    const run = heartbeat ?? storedRun;

    const rows = await getRunItems(runId);
    const wanted = args.includeReported ? rows : rows.filter((r) => r.outcome === 'pending');

    const liveActions = wanted.length > 0 ? await liveActionsById() : null;
    const items: ManifestItem[] = [];
    for (const r of wanted) {
      const actions = liveActions?.get(r.itemId) ?? [];
      items.push({
        itemId: r.itemId,
        position: r.position,
        kind: r.kind,
        title: r.title,
        ref: r.ref,
        ownerAgentId: r.ownerAgentId,
        outcome: r.outcome,
        actions,
        disposition: r.disposition,
        recommendation: r.recommendation
          ? {
              kind: r.recommendation.kind,
              label: r.recommendation.label,
              rationale: r.recommendation.rationale,
              confidence: r.recommendation.confidence,
              responsibility: r.recommendation.responsibility,
              actionId: r.recommendation.actionId,
              evidenceBasis: r.recommendation.evidenceBasis,
              retryCondition: r.recommendation.retryCondition ?? null,
            }
          : null,
        reported:
          r.outcome === 'pending' ? null : { actionId: r.actionId, rationale: r.rationale, confidence: r.confidence },
      });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            run: {
              runId: run.runId,
              phase: run.phase,
              totalItems: run.totalItems,
              autoResolved: run.autoResolved,
              recommended: run.recommended,
              skipped: run.skipped,
              failed: run.failed,
              filter: run.filterSnapshot,
              requestedBy: run.requestedBy,
              heartbeatAt: run.heartbeatAt,
              resolverOwner: run.resolverOwner,
              automationPolicy: run.automationPolicy,
            },
            items,
            remaining: rows.filter((r) => r.outcome === 'pending').length,
            // WI-41021 — a run is ALSO stopped when the owner flips the feature
            // off underneath you. The flag is the kill switch; you are a separate
            // process that would otherwise never notice it moved, so it reaches
            // you through this same `stopped` bit rather than a second channel.
            featureDisabled: !featureEnabled,
            ownershipRevoked,
            // WI-41013 — the owner's Stop settles the run row; you are a
            // separate process and will not otherwise notice. When this is
            // true the run is NO LONGER YOURS: stop immediately, take no
            // further terminal action on any item, and do not report. Reports
            // for a stopped run are refused, and a refusal after you have
            // already acted means the action happened with nothing recording
            // it — which is exactly the state to avoid.
            stopped: !featureEnabled || ownershipRevoked || !['pending', 'running'].includes(run.phase),
          }),
        },
      ],
    };
  },
});

export const bulkRunAct = defineTool({
  name: 'inbox:bulk-run-act',
  description:
    'Take ONE terminal action for a BULK RESOLVE run. This is the only verb allowed to create an `auto_resolved` outcome: it locks the run row as a revocable authority token, re-validates that the item still offers the terminal action, dispatches through the exact same shared action map as the Inbox button, writes the REQUIRED attention-triage audit row, records the item outcome, and recomputes counters before releasing the lock. If the owner Stop won first, the action callback is never entered.',
  guidance: {
    when: "You have direct evidence for one item and will take a terminal action on the owner's behalf. Call once per action; use inbox:bulk-run-report only for recommended/skipped/failed records.",
    notWhen:
      'The option only navigates (discuss/answer/open/chat/view-log), the item no longer offers it, or you only want to recommend it for owner review.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional().describe('the run; omit for the active one'),
    itemId: z.string().min(1),
    actionId: z.string().min(1),
    rationale: softText(LIMITS.ANNOTATION).describe('why this terminal action is correct; REQUIRED audit note'),
    draftAnswer: softText(LIMITS.ANNOTATION).optional(),
    confidence: z.enum(['low', 'high']).optional(),
    confidenceLevel: z.enum(BULK_CONFIDENCE_LEVELS).optional(),
    recommendationKind: z.enum(BULK_RECOMMENDATION_KINDS).optional(),
    recommendationLabel: softText(LIMITS.ANNOTATION).optional(),
    recommendationRationale: softText(LIMITS.ANNOTATION).optional(),
    evidenceBasis: z.array(softText(LIMITS.ANNOTATION)).max(20).optional(),
    responsibility: z.enum(['owner', 'agent', 'system', 'engineering', 'unknown']).optional(),
    retryCondition: softText(LIMITS.ANNOTATION).optional(),
    consulted: z.boolean().optional(),
    consultReply: softText(LIMITS.ANNOTATION).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'no_active_run' }) }],
      };
    }

    if (!(await bulkResolveEnabled())) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: 'feature_disabled',
              flag: FLAGS.INBOX_BULK_RESOLVE,
              runId,
              actionDispatched: false,
              message: 'Bulk resolve is OFF. The terminal action was not entered; stop this run.',
            }),
          },
        ],
      };
    }

    const run = await getRun(runId);
    if (!run) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'run_not_found', runId }) }],
      };
    }
    const heartbeat = await recordRunHeartbeat({
      runId,
      resolverOwner: identity.ownerId,
      workspaceId: run.workspaceId,
    }).catch(() => null);
    if (!heartbeat) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: 'resolver_owner_mismatch_or_not_executing',
              runId,
              actionDispatched: false,
            }),
          },
        ],
      };
    }
    const row = (await getRunItems(runId)).find((item) => item.itemId === args.itemId);
    if (!row) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: 'item_not_in_run', runId, itemId: args.itemId }),
          },
        ],
      };
    }

    // P-007 / D-012: the mutable standing policy is the authority source of
    // truth; run.automationPolicy is only the immutable launch receipt. Gate
    // the ref kind because that is what the terminal dispatcher will execute,
    // so a stale/mismatched display kind can never widen the action's authority.
    const policy = await readStandingBulkAutomationPolicy(run.workspaceId);
    const confidenceLevel =
      args.confidenceLevel ?? (args.confidence === 'high' ? 'high' : args.confidence === 'low' ? 'low' : null);
    const actionKind = typeof row.ref.kind === 'string' ? row.ref.kind : (row.kind ?? '');
    const eligibility = standingAutomationEligibility(policy, actionKind, confidenceLevel);
    if (!eligibility.allowed) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: 'automation_policy',
              reason: eligibility.reason,
              policy,
              runId,
              itemId: row.itemId,
              message:
                'The standing authority and confidence policy does not permit auto-application. Report a typed recommendation with the evidence and confidence instead.',
            }),
          },
        ],
      };
    }

    const rationale = clampText(args.rationale, LIMITS.ANNOTATION)?.trim() ?? '';
    if (!rationale) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'rationale_required' }) }],
      };
    }

    const item: TerminalAttentionItem = {
      id: row.itemId,
      kind: row.kind ?? 'attention-item',
      title: row.title ?? row.itemId,
      harnessSlug: run.harnessSlug,
      planSlug: typeof row.ref.planSlug === 'string' ? row.ref.planSlug : null,
      ownerAgentId: row.ownerAgentId,
      ref: { kind: String(row.ref.kind ?? ''), ...row.ref },
    };
    const call = inProcessCall(ctx);
    // P-003: the resolver's drafted answer used to be RECORDED and nothing else —
    // the only code that could apply one lived in the browser card. Hoisted so the
    // terminal dispatch can carry it into effects that accept the owner's text
    // (today: the accepted answer on a conversation resolve).
    const draftAnswer = clampText(args.draftAnswer, LIMITS.ANNOTATION)?.trim() ?? null;
    let actionDispatched = false;

    try {
      const result = await executeBulkRunAction({
        runId,
        itemId: row.itemId,
        actionId: args.actionId,
        rationale,
        draftAnswer,
        confidence: args.confidence ?? null,
        confidenceLevel: args.confidenceLevel ?? null,
        recommendationKind: args.recommendationKind ?? null,
        recommendationLabel: clampText(args.recommendationLabel, LIMITS.ANNOTATION)?.trim() ?? null,
        recommendationRationale: clampText(args.recommendationRationale, LIMITS.ANNOTATION)?.trim() ?? null,
        evidenceBasis: args.evidenceBasis ?? null,
        responsibility: args.responsibility ?? null,
        retryCondition: clampText(args.retryCondition, LIMITS.ANNOTATION)?.trim() ?? null,
        consulted: args.consulted === true,
        consultReply: clampText(args.consultReply, LIMITS.ANNOTATION)?.trim() ?? null,
        resolverOwner: identity.ownerId,
        workspaceId: run.workspaceId,
        async execute() {
          // Re-read INSIDE the run-row authority window. A manifest read is
          // advisory; this is the last check before the irreversible effect.
          const actions = await liveActionsFor(row.itemId);
          const offered = actions?.find((action) => action.id === args.actionId);
          if (!offered) {
            throw new Error(
              `action "${args.actionId}" is not currently offered by ${row.itemId} (offered: ${
                actions?.map((action) => action.id).join(', ') || 'none'
              })`,
            );
          }
          if (!offered.terminal) {
            throw new Error(`action "${args.actionId}" only opens a sub-surface and cannot resolve the item`);
          }
          const dispatched = await dispatchAttentionTerminalAction({
            item,
            actionId: args.actionId,
            rationale,
            ...(draftAnswer ? { answerText: draftAnswer } : {}),
            deps: terminalDependencies({ call, workspaceId: run.workspaceId }),
          });
          if (!dispatched.resolved) {
            throw new Error(`action "${args.actionId}" has no terminal dispatcher for ref kind "${item.ref.kind}"`);
          }
          actionDispatched = true;
          return dispatched;
        },
        audit: (tx) =>
          upsertTriage({
            itemId: row.itemId,
            action: 'resolve',
            note: `Bulk resolve: ${rationale}`,
            triagedBy: identity.ownerId,
            workspaceId: run.workspaceId,
            sql: tx,
          }),
      });

      if (result.refused) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                refused: result.refused.reason,
                phase: result.refused.phase,
                runId,
                itemId: row.itemId,
                actionDispatched: false,
                message: 'The owner Stop/settle won the authority lock. No terminal action was entered.',
              }),
            },
          ],
        };
      }

      try {
        await notifyBulkRunAndAttentionChanged();
      } catch {
        /* poll fallback */
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              runId,
              itemId: row.itemId,
              actionId: args.actionId,
              actionDispatched: true,
              outcome: result.item?.outcome ?? 'auto_resolved',
              counters: result.run
                ? {
                    autoResolved: result.run.autoResolved,
                    recommended: result.run.recommended,
                    skipped: result.run.skipped,
                    failed: result.run.failed,
                  }
                : null,
              dispatch: result.actionResult,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: actionDispatched ? 'post_dispatch_persistence_failed' : 'terminal_action_failed',
              message: error instanceof Error ? error.message : String(error),
              runId,
              itemId: row.itemId,
              actionId: args.actionId,
              actionDispatched,
              reconciliationRequired: actionDispatched,
            }),
          },
        ],
      };
    }
  },
});

interface AutoAcceptAttempt {
  itemId: string;
  actionId: string;
  ok: boolean;
  outcome: string | null;
  refused: string | null;
  reason: string | null;
  error: string | null;
  message: string | null;
  reconciliationRequired: boolean;
}

function toolJsonPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return {};
  const block = content.find(
    (entry) =>
      entry != null &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string',
  ) as { text: string } | undefined;
  if (!block) return {};
  try {
    const parsed = JSON.parse(block.text) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function autoAcceptSummary(input: {
  reportedRecommendations: number;
  actionCandidates: number;
  terminalCandidates: number;
  attempts: AutoAcceptAttempt[];
}) {
  const resolved = input.attempts.filter((attempt) => attempt.ok && attempt.outcome === 'auto_resolved').length;
  const unresolved = input.attempts
    .filter((attempt) => !attempt.ok || attempt.outcome !== 'auto_resolved')
    .map((attempt) => ({
      itemId: attempt.itemId,
      actionId: attempt.actionId,
      ...(attempt.refused ? { refused: attempt.refused } : {}),
      ...(attempt.reason ? { reason: attempt.reason } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
      ...(attempt.message ? { message: attempt.message } : {}),
      ...(attempt.reconciliationRequired ? { reconciliationRequired: true } : {}),
    }));
  return {
    reportedRecommendations: input.reportedRecommendations,
    actionCandidates: input.actionCandidates,
    terminalCandidates: input.terminalCandidates,
    attempted: input.attempts.length,
    resolved,
    leftForReview: input.reportedRecommendations - resolved,
    unresolved,
  };
}

const OutcomeItem = z
  .object({
    itemId: z.string().min(1),
    outcome: z.enum(['recommended', 'skipped', 'failed']),
    disposition: z
      .enum([
        'recommended',
        'owner_action',
        'cleanup_candidate',
        'retry_needed',
        'routed',
        'investigate',
        'failed',
        'legacy_skipped',
      ])
      .optional()
      .describe('typed owner-facing disposition; legacy_skipped is compatibility-only'),
    actionId: z
      .string()
      .min(1)
      .optional()
      .describe('the option id to pre-select for the owner (recommended). MUST be one the item offers.'),
    rationale: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('≤2 sentences of WHY — what the owner reads on a recommended item'),
    draftAnswer: softText(LIMITS.ANNOTATION)
      .optional()
      .describe(
        'a drafted free-text reply where the resolution path takes prose, so the owner edits rather than composes',
      ),
    confidence: z
      .enum(['low', 'high'])
      .optional()
      .describe(
        "'high' = settled from direct evidence or the asker's own reply; 'low' = a consult deadline lapsed and you inferred it anyway",
      ),
    consulted: z
      .boolean()
      .optional()
      .describe('true when you sent the asking agent a directed consult about this item'),
    consultReply: softText(LIMITS.ANNOTATION).optional().describe("the asker's reply, verbatim, when one arrived"),
    error: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('why it was skipped, or how the dispatch failed — never leave this blank on skipped/failed'),
    recommendationKind: z.enum(BULK_RECOMMENDATION_KINDS).optional(),
    recommendationLabel: softText(LIMITS.ANNOTATION).optional(),
    recommendationRationale: softText(LIMITS.ANNOTATION).optional(),
    evidenceBasis: z.array(softText(LIMITS.ANNOTATION)).max(20).optional(),
    responsibility: z.enum(['owner', 'agent', 'system', 'engineering', 'unknown']).optional(),
    confidenceLevel: z.enum(BULK_CONFIDENCE_LEVELS).optional(),
    retryCondition: softText(LIMITS.ANNOTATION).optional(),
  })
  .refine((d) => d.outcome !== 'recommended' || !!d.actionId || !!d.recommendationKind, {
    message: 'actionId is required for recommended outcomes',
    path: ['actionId'],
  })
  .refine((d) => !(d.outcome === 'skipped' || d.outcome === 'failed') || !!d.error?.trim(), {
    message: 'error (the why) is required when skipping or failing an item',
    path: ['error'],
  })
  .superRefine((d, ctx) => {
    if (!d.recommendationKind) return;
    if (!d.recommendationLabel?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendationLabel'],
        message: 'recommendationLabel is required with a typed recommendation',
      });
    }
    if (!d.recommendationRationale?.trim() && !d.rationale?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendationRationale'],
        message: 'recommendationRationale or rationale is required with a typed recommendation',
      });
    }
    if (!d.confidenceLevel && !d.confidence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confidenceLevel'],
        message: 'confidenceLevel is required with a typed recommendation',
      });
    }
    if (!d.responsibility) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['responsibility'],
        message: 'responsibility is required with a typed recommendation',
      });
    }
    if (d.disposition && d.disposition !== d.recommendationKind && d.disposition !== 'recommended') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposition'],
        message: 'disposition must match recommendationKind',
      });
    }
  });

export const bulkRunReport = defineTool({
  name: 'inbox:bulk-run-report',
  description:
    'Report non-action outcomes for a BULK RESOLVE run. Every item must carry a typed disposition/recommendation: `recommended` may pre-select a real offered action, while `owner_action`, `cleanup_candidate`, `retry_needed`, `routed`, and `investigate` may omit actionId but require a label, rationale/evidence, responsibility, and confidence. `skipped` is legacy compatibility only and must include its reason. This verb cannot claim `auto_resolved`; terminal effects use inbox:bulk-run-act. Re-reporting overwrites the row and counters remain derived.',
  guidance: {
    when: 'After deciding each item in a bulk-resolve run. Batch several via `items:[…]` rather than one call per item.',
    notWhen: 'Ending the run (inbox:bulk-run-settle). Triaging an attention item outside a run (inbox:triage).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      runId: z.string().min(1).optional().describe('the run; omit for the active one'),
      itemId: z.string().min(1).optional().describe('single-item shorthand'),
      outcome: z.enum(['recommended', 'skipped', 'failed']).optional(),
      disposition: z
        .enum([
          'recommended',
          'owner_action',
          'cleanup_candidate',
          'retry_needed',
          'routed',
          'investigate',
          'failed',
          'legacy_skipped',
        ])
        .optional(),
      actionId: z.string().min(1).optional(),
      rationale: softText(LIMITS.ANNOTATION).optional(),
      draftAnswer: softText(LIMITS.ANNOTATION).optional(),
      confidence: z.enum(['low', 'high']).optional(),
      consulted: z.boolean().optional(),
      consultReply: softText(LIMITS.ANNOTATION).optional(),
      error: softText(LIMITS.ANNOTATION).optional(),
      recommendationKind: z.enum(BULK_RECOMMENDATION_KINDS).optional(),
      recommendationLabel: softText(LIMITS.ANNOTATION).optional(),
      recommendationRationale: softText(LIMITS.ANNOTATION).optional(),
      evidenceBasis: z.array(softText(LIMITS.ANNOTATION)).max(20).optional(),
      responsibility: z.enum(['owner', 'agent', 'system', 'engineering', 'unknown']).optional(),
      confidenceLevel: z.enum(BULK_CONFIDENCE_LEVELS).optional(),
      retryCondition: softText(LIMITS.ANNOTATION).optional(),
      items: z.array(OutcomeItem).min(1).max(100).optional().describe('outcomes to record (1–100)'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.itemId) && Boolean(a.outcome)), {
      message: 'pass `{ itemId, outcome }` (one) or `items:[{ itemId, outcome }]` (many)',
    })
    .superRefine((a, ctx) => {
      if (a.items?.length || a.outcome !== 'recommended') return;
      if (!a.actionId && !a.recommendationKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actionId'],
          message: 'actionId or recommendationKind is required for recommended outcomes',
        });
      }
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'no_active_run' }) }],
      };
    }

    // WI-41021 — the owner flipped the kill switch. Refuse BEFORE any write, and
    // in the same shape as a stopped run (below), because to the resolver these
    // are the same event: its authority to act was revoked mid-run. Distinct
    // `refused` reason so an operator reading a log can tell a flag flip from an
    // owner Stop without guessing.
    if (!(await bulkResolveEnabled())) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: 'feature_disabled',
              flag: FLAGS.INBOX_BULK_RESOLVE,
              runId,
              wrote: 0,
              message:
                "Bulk resolve has been turned OFF by the owner while this run was in flight. Nothing from this report was written. STOP: take no further action on any item in this run, and do NOT re-route the work to the item's own verb outside the run. If you already took an action before this refusal, say so plainly in your final message rather than retrying or hiding it.",
            }),
          },
        ],
      };
    }
    const run = await getRun(runId);
    const heartbeat = run
      ? await recordRunHeartbeat({
          runId,
          resolverOwner: identity.ownerId,
          workspaceId: run.workspaceId,
        }).catch(() => null)
      : null;
    if (!heartbeat) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: 'resolver_owner_mismatch_or_not_executing',
              runId,
              wrote: 0,
            }),
          },
        ],
      };
    }

    const reports = args.items?.length
      ? args.items
      : [
          {
            itemId: args.itemId!,
            outcome: args.outcome!,
            actionId: args.actionId,
            rationale: args.rationale,
            draftAnswer: args.draftAnswer,
            confidence: args.confidence,
            consulted: args.consulted,
            consultReply: args.consultReply,
            error: args.error,
            disposition: args.disposition,
            recommendationKind: args.recommendationKind,
            recommendationLabel: args.recommendationLabel,
            recommendationRationale: args.recommendationRationale,
            evidenceBasis: args.evidenceBasis,
            responsibility: args.responsibility,
            confidenceLevel: args.confidenceLevel,
            retryCondition: args.retryCondition,
          } as z.infer<typeof OutcomeItem>,
        ];

    // Validate each proposed action id against what the item ACTUALLY offers,
    // before anything is written. One invocation gets one canonical snapshot;
    // a bad id still fails only its own item.
    const liveActions = reports.some((report) => Boolean(report.actionId)) ? await liveActionsById() : null;
    const accepted: BulkOutcomeReport[] = [];
    const env = await runBulk(
      reports,
      async (r) => {
        if (r.actionId) {
          const actions = liveActions?.get(r.itemId) ?? null;
          if (actions && actions.length > 0) {
            const match = actions.find((a) => a.id === r.actionId);
            if (!match) {
              throw new Error(
                `action "${r.actionId}" is not offered by ${r.itemId} (offered: ${actions.map((a) => a.id).join(', ') || 'none'})`,
              );
            }
          }
        }

        accepted.push({
          itemId: r.itemId,
          outcome: r.outcome,
          actionId: r.actionId ?? null,
          rationale: clampText(r.rationale, LIMITS.ANNOTATION)?.trim() ?? null,
          draftAnswer: clampText(r.draftAnswer, LIMITS.ANNOTATION)?.trim() ?? null,
          confidence: r.confidence ?? null,
          confidenceLevel: r.confidenceLevel ?? null,
          consulted: r.consulted === true,
          consultReply: clampText(r.consultReply, LIMITS.ANNOTATION)?.trim() ?? null,
          error: clampText(r.error, LIMITS.ANNOTATION)?.trim() ?? null,
          disposition: r.disposition ?? null,
          recommendationKind: r.recommendationKind ?? null,
          recommendationLabel: clampText(r.recommendationLabel, LIMITS.ANNOTATION)?.trim() ?? null,
          recommendationRationale: clampText(r.recommendationRationale, LIMITS.ANNOTATION)?.trim() ?? null,
          evidenceBasis: r.evidenceBasis ?? null,
          responsibility: r.responsibility ?? null,
          retryCondition: clampText(r.retryCondition, LIMITS.ANNOTATION)?.trim() ?? null,
        });
        return { ok: true as const, itemId: r.itemId, outcome: r.outcome };
      },
      { keyOf: ({ itemId }) => ({ itemId }) },
    );

    let unknown: string[] = [];
    let autoAccept = autoAcceptSummary({
      reportedRecommendations: 0,
      actionCandidates: 0,
      terminalCandidates: 0,
      attempts: [],
    });
    if (accepted.length > 0) {
      const res = await reportOutcomes({
        runId,
        outcomes: accepted,
        resolverOwner: identity.ownerId,
        workspaceId: heartbeat.workspaceId,
      });
      unknown = res.unknown;

      // WI-41013 — the run was stopped (or settled) between your last read and
      // this report, so NOTHING was written. Return immediately and loudly:
      // skipping the triage overlay below matters, because writing an audit row
      // for an outcome the run never recorded would leave the two stores
      // disagreeing about what happened. If you had already taken the action,
      // say so to the owner rather than retrying it outside the run.
      if (res.refused) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                refused: res.refused.reason,
                phase: res.refused.phase,
                runId,
                wrote: 0,
                message:
                  'This run is no longer accepting reports — the owner stopped it, or it has already settled. STOP: take no further action on any item in this run. Nothing from this report was written.',
              }),
            },
          ],
        };
      }

      try {
        await notifyBulkRunAndAttentionChanged();
      } catch {
        /* the poll fallback still picks it up */
      }

      // P-008: persist the resolver's recommendation FIRST, then let the
      // existing action verb decide whether the live standing policy permits
      // it. This ordering makes every refusal/failure reviewable and keeps the
      // Stop lock, fresh action check, terminal dispatcher, audit transaction,
      // and post-dispatch reconciliation rail single-sourced in bulkRunAct.
      const unknownIds = new Set(unknown);
      const recommendations = accepted.filter(
        (report) => report.outcome === 'recommended' && !unknownIds.has(report.itemId),
      );
      const actionCandidates = recommendations.filter(
        (report): report is BulkOutcomeReport & { actionId: string } =>
          typeof report.actionId === 'string' && report.actionId.length > 0,
      );
      const terminalCandidates = actionCandidates.filter((report) =>
        liveActions?.get(report.itemId)?.some((action) => action.id === report.actionId && action.terminal),
      );
      const attempts: AutoAcceptAttempt[] = [];
      for (const report of terminalCandidates) {
        const result = toolJsonPayload(
          await bulkRunAct.handler(
            {
              runId,
              itemId: report.itemId,
              actionId: report.actionId,
              rationale: report.rationale ?? report.recommendationRationale ?? '',
              draftAnswer: report.draftAnswer ?? undefined,
              confidence: report.confidence ?? undefined,
              confidenceLevel: report.confidenceLevel ?? undefined,
              recommendationKind: report.recommendationKind ?? undefined,
              recommendationLabel: report.recommendationLabel ?? undefined,
              recommendationRationale: report.recommendationRationale ?? report.rationale ?? undefined,
              evidenceBasis: report.evidenceBasis ?? undefined,
              responsibility: report.responsibility ?? undefined,
              retryCondition: report.retryCondition ?? undefined,
              consulted: report.consulted === true,
              consultReply: report.consultReply ?? undefined,
            },
            ctx,
          ),
        );
        const attempt: AutoAcceptAttempt = {
          itemId: report.itemId,
          actionId: report.actionId,
          ok: result.ok === true,
          outcome: typeof result.outcome === 'string' ? result.outcome : null,
          refused: typeof result.refused === 'string' ? result.refused : null,
          reason: typeof result.reason === 'string' ? result.reason : null,
          error: typeof result.error === 'string' ? result.error : null,
          message: typeof result.message === 'string' ? result.message : null,
          reconciliationRequired: result.reconciliationRequired === true,
        };
        attempts.push(attempt);

        // A revoked run/feature is a run-wide stop signal. A reconciliation
        // incident means an external effect may have landed without its row;
        // multiplying effects after either signal would make recovery harder.
        if ((attempt.refused != null && attempt.refused !== 'automation_policy') || attempt.reconciliationRequired) {
          break;
        }
      }
      autoAccept = autoAcceptSummary({
        reportedRecommendations: recommendations.length,
        actionCandidates: actionCandidates.length,
        terminalCandidates: terminalCandidates.length,
        attempts,
      });
    }

    if (unknown.length === 0) {
      return bulkContent({ ...(env as unknown as Record<string, unknown>), autoAccept });
    }
    // Unknown ids are surfaced BESIDE the bulk envelope rather than as failures:
    // each reported item that existed still landed, and the resolver needs to
    // know which ids it invented or carried over from a different run.
    return bulkContent({
      ...(env as unknown as Record<string, unknown>),
      ignored: {
        reason: "not in this run's snapshot",
        itemIds: unknown,
        why: 'A run acts on exactly the items the owner was looking at; widening it silently would break that guarantee.',
      },
      autoAccept,
    });
  },
});

// WI-41021 — DELIBERATELY NOT FLAG-GATED. Do not "fix" this by adding a
// bulkResolveEnabled() check to match its two siblings: settle is the WIND-DOWN
// path, the tool half of the owner's Stop. Refusing it while the flag is off
// would strand every in-flight run in `running` forever — the same inversion the
// route-level blanket gate had (a kill switch that disables the kill button),
// one level down. The flag gates ACTING (manifest authority, report writes);
// finishing cleanly is never gated.
export const bulkRunSettle = defineTool({
  name: 'inbox:bulk-run-settle',
  description:
    'End your BULK RESOLVE pass. The final phase is DERIVED from the item rows, not from what you claim: `review` when anything is still recommended or was never reached, `complete` only when nothing is left for the owner. Pass `failed:true` with a reason when you are giving up part-way — the partial outcomes are kept and the untouched items stay resolvable by hand, which is strictly better than leaving the run stuck on "running" forever.',
  guidance: {
    when: 'Once every item in the manifest has been reported — the last call of a bulk-resolve pass, before you end your turn.',
    notWhen: 'Mid-pass (keep reporting via inbox:bulk-run-report).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional().describe('the run; omit for the active one'),
    failed: z.boolean().optional().describe('true when abandoning the run part-way'),
    error: softText(LIMITS.ANNOTATION).optional().describe('why you are abandoning it (required with failed:true)'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'no_active_run' }) }],
      };
    }

    const run = args.failed
      ? await failRunIfExecuting({
          runId,
          resolverOwner: identity.ownerId,
          error: clampText(args.error, LIMITS.ANNOTATION)?.trim() || 'resolver abandoned the run',
        })
      : await settleRunPhase({ runId, resolverOwner: identity.ownerId });

    if (!run) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              refused: 'resolver_owner_mismatch_or_not_executing',
              runId,
            }),
          },
        ],
      };
    }

    try {
      await notifyBulkRunChanged();
    } catch {
      /* poll fallback */
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            runId,
            phase: run.phase,
            autoResolved: run.autoResolved,
            recommended: run.recommended,
            skipped: run.skipped,
            failed: run.failed,
          }),
        },
      ],
    };
  },
});

export default bulkRunManifest;
