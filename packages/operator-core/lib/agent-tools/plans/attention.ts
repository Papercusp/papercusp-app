/**
 * plans:attention — the unified attention reader for the Planning tab
 * (planning-attention-importance-2026-05-31, P-011 / D-004, D-008).
 *
 * Fetches every "needs the human / pick this up" surface, maps each
 * through its AttentionItem adapter, and returns them grouped by plan
 * (+ a synthetic per-harness "Alerts" bucket for unattached items),
 * importance-sorted. Sources:
 *   - plan items (non-terminal)            → planItemToAttention
 *   - open coord escalations               → coordEscalationToAttention
 *   - coord messages addressed to 'human'  → coordMessageToAttention
 *   - failing smoke tests (harness_smoke_test)  → smokeFailToAttention
 *   - operator `<report>` turns (operator_turns.report) → reportTurnsToAttention
 *   - B-14/P-100 folded disposition channels (D-011), each filtered to the
 *     awaiting-human slice (never the execution backlog):
 *       · human-routed improvements (engineer_issues needsHuman) → improvementToAttention
 *       · standing-approval candidates                          → standingApprovalToAttention
 *       · open coord:ask questions                              → conversationToAttention
 *       · ungraded routed Scout ideas (one rollup)              → scoutGradeToAttention
 *     (report-cards-inbox-reconciliation-2026-06-05 — the operator's
 *     structured output routes to the Inbox, not the chat stream)
 *
 * Each source is best-effort: one source erroring (PG offline, no coord
 * log) degrades to fewer items, never a failed read. The orchestrator's
 * needs-human DONE-gate keeps using GET /api/admin/plans/items?needsHuman
 * (unchanged) — this is a separate, additive read (P-012).
 *
 * v1 takes a single optional `harnessSlug` filter (applied to the
 * harness-scoped sources); cross-harness fan-out via the UI selector is
 * wired in Phase 4 (P-016). coord escalations/messages are workspace-
 * level and always included.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readAllPlans } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import {
  coordEscalationToAttention,
  coordMessageToAttention,
  smokeFailToAttention,
  improvementToAttention,
  standingApprovalToAttention,
  conversationToAttention,
  scoutGradeToAttention,
  workItemNeedsHumanToAttention,
  ownerWallToAttention,
  darkFlagRatificationToAttention,
  blockedSessionToAttention,
  blockedWorkItemToAttention,
  decisionOwedToAttention,
  unhandledDirectiveToAttention,
} from '../../attention/adapters';
import {
  planItemsToAttention,
  reportTurnsToAttention,
  toIsoOrNull,
  dropConvertedPlanItems,
  dropDuplicateNeedsHumanWorkItems,
  dropDuplicateBlockedWorkItems,
  dropDuplicateQuestionConversations,
} from '../../attention/sources';
import { buildAttentionGroups, scopeGroupsToOwner } from '../../attention/group';
import { MAX_ATTENTION_OFFSET, MAX_ATTENTION_PAGE_SIZE, paginateAttentionGroups } from '../../attention/window';
import { applyTriage, deriveAuthorization, groupByTier, type AttentionItem } from '../../attention/types';
import { readTriageByWorkspace } from '../../attention/triage-store';
import { shapePlansAttention } from './attention-shape';
import { cachedRead, type CachedReadCtx } from '../../cache';
import { conversationsScopeWorkspace } from '../coordination/conversations';
import {
  classifyReadActionability,
  resolveSessionStates,
  type LivenessSubject,
  type LivenessVerdict,
} from '../coordination/liveness-oracle';
import { runWithWorkspace } from '../../workspace-als';
import { activeWorkspaceId } from '../../workspace-registry';
import { ownerAttentionSourcesFor, type OwnerAttentionSource } from '../../interest-profiles';
import { ownerAskDefaultDisclosure } from '../../external-blockers';
import { attachListMeta } from '../../sync-resolver/list-meta';
import { deriveAttentionCounts, deriveAttentionRefs } from '../../sync-resolver/attention-counts';

function attentionProjections(groups: ReturnType<typeof buildAttentionGroups>) {
  // The full feed chooses duplicate winners by global priority before grouping.
  // Preserve that exact presentation semantics once per build, including ref
  // order; deriving straight from source groups could choose a different copy.
  const presented = paginateAttentionGroups(groups, { limit: null }).groups;
  return { counts: deriveAttentionCounts(presented), refs: deriveAttentionRefs(presented) };
}

/**
 * SWR backstop for plans:attention (cache-expensive-tool-reads-2026-06-22 P-003 / D-001).
 * Shorter than plans:list's: the feed folds ~10 sources beyond the plan tables — several
 * append-heavy (coord_event_log: escalations + messages-to-human) — which are deliberately
 * NOT tagged (tagging an append-heavy source = ~0 hit-rate, the coord:inbox problem D-006).
 * The plan tables ARE tagged, so a plan-item change (the dominant attention change) busts
 * immediately; this short soft TTL bounds staleness for the un-tagged sources (a new
 * escalation/message/smoke-fail surfaces within the window).
 */
const PLANS_ATTENTION_SOFT_TTL_MS = 20_000;

/**
 * EI-184: cap the caller's wait on a genuinely-blocking build (a cold L1 — e.g. right
 * after an operator restart, since this process's cache is L1-only/in-memory — or a
 * forced rebuild past the hard TTL/an invalidation). Live telemetry showed p50 ~225ms
 * but a p99 of ~55s and a max of ~85s — comfortably past the 60s tool-call ceiling on
 * the rare slow build, which is exactly what generated this watchdog signal (15/48436
 * calls timed out). 45s leaves a safety margin under 60s while still giving a genuinely
 * slow build most of its time; the build keeps running in the background regardless
 * (getOrSetBounded/single-flight) and lands in cache for the next caller.
 */
const PLANS_ATTENTION_DEADLINE_MS = 45_000;

/** The degrade-on-timeout value (EI-184) — an empty feed, consistent with every
 *  individual source already being best-effort ("degrades to fewer items, never a
 *  failed read"): a deadline is just the whole-aggregate version of that same policy. */
function emptyAttentionResult(): {
  groups: ReturnType<typeof buildAttentionGroups>;
  tierCounts: ReturnType<typeof groupByTier>['counts'];
  itemCount: number;
  projections: ReturnType<typeof attentionProjections>;
  degraded: boolean;
} {
  const groups = buildAttentionGroups([]);
  return { groups, tierCounts: groupByTier([]).counts, itemCount: 0, projections: attentionProjections(groups), degraded: true };
}

const argsSchema = z.object({
  output: z.enum(['feed', 'counts', 'refs']).optional()
    .describe('Return the feed (default), badge counts, or drill-in refs. Counts/refs cover the complete scoped feed and ignore limit/offset.'),
  harnessSlug: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict the harness-scoped sources (smoke-fails) to one harness. Omit for workspace-wide.'),
  includeArchived: z.boolean().optional().describe('Include items from archived plans. Default false.'),
  /** Presentation-only page over the complete cached attention aggregation.
   * Omitted preserves the historical unbounded agent read; null is an explicit
   * unbounded escape hatch for aggregate/detail consumers. */
  limit: z
    .union([z.number().int().positive().max(MAX_ATTENTION_PAGE_SIZE), z.null()])
    .optional()
    .describe(`Maximum distinct attention items to return (1..${MAX_ATTENTION_PAGE_SIZE}); null is unbounded.`),
  /** Zero-based offset into the deterministic attention ordering. */
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_ATTENTION_OFFSET)
    .optional()
    .describe(`Zero-based item offset (maximum ${MAX_ATTENTION_OFFSET}).`),
  /**
   * WI-2144754: restrict the feed to items OWED BY one agent — `ownerAgentId`
   * on the item, i.e. the agent that filed the ask.
   *
   * This exists because a client-side filter over a bounded page is not a
   * filter, it is a coincidence. The session popup's Decisions shelf wants
   * "what does THIS session's agent need the human for", and used to get it by
   * filtering page one (100 items) of the fleet-wide feed in the browser. At
   * the time of writing there were 145 open agent decision-escalations against
   * that 100-item page from a SINGLE source, so at least 45 owner-owed asks
   * could not render in their own popup — and an empty shelf is
   * indistinguishable from "nothing needs you here".
   *
   * Applied in the SAME presentation layer as `limit`/`offset` (after the
   * cached ~10-source aggregation, before the window), so the expensive build
   * and its cache key are untouched and one cached entry still serves every
   * caller. `tierCounts` is recomputed over the filtered set — a scoped read
   * that reported fleet-wide counts would be the bounded-measurement-as-total
   * error this argument exists to fix.
   */
  ownerAgentId: z
    .string()
    .min(1)
    .optional()
    .describe('Only items owed by this agent (AttentionItem.ownerAgentId). Omit for the whole feed.'),
  harness: harnessArg,
});

export default defineTool({
  name: 'plans:attention',
  description:
    "The Planning tab's unified attention feed: plan items + coord escalations + coord messages-to-human + smoke-fails + operator <report> turns, mapped to a single AttentionItem shape, grouped by plan (+ per-harness Alerts bucket), importance-sorted. Each source best-effort.",
  guidance: {
    when: 'You want everything awaiting the human / pickable, in one importance-sorted feed — the Planning tab inbox, or to find the single most-urgent open thing.',
    notWhen:
      'You only need plan items (use plans:items), or the full structure of one plan (plans:get). For the orchestrator DONE-gate use plans:items { needsHuman: true }.',
    chaining:
      'plans:attention → act on an item via its kind (plans:set-status for plan items, coord:resolve for escalations).',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // Sentinel-as-Herald: the Herald reads "what needs the user's eye on the plans"
  // to suggest what to work on next (paired with its plans:read cap). It only
  // READS here — acting on an item is still file-a-work_item + nudge-the-Queen.
  agentRoles: [...SU_ROLES, 'papercup'],
  modality: ['text'],
  args: argsSchema,
  // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-013 — the first
  // exemplar). plans:attention is the strongest ROI target: ~9.6k tokens, ~19k
  // calls/6h, no `compact` escape. The diffable unit is the FLAT AttentionItem set,
  // extracted from the grouped response via `rows` (the response shape is untouched,
  // so the UI's `plans.attention` sync read is unaffected). No explicit `revision`
  // → the framework derives it from the item-set checksum (changed iff any item's
  // content changes / an item is added or removed); no `rowRevision` → per-item
  // content hash. An unchanged feed returns `not_modified` (no replay); a changed
  // feed returns added/updated/removed items, checksum-verified by the harness with
  // force-full-on-mismatch; first/stale/scope-change/over-age → a full snapshot.
  delta: {
    rows: (data) => {
      const groups = (data as { groups?: Array<{ items?: unknown[] }> } | null | undefined)?.groups;
      return Array.isArray(groups) ? groups.flatMap((g) => (Array.isArray(g.items) ? g.items : [])) : null;
    },
    itemKey: (row) => (row as AttentionItem).id,
    itemKeyField: 'id',
    rowType: (row) => (row as AttentionItem).kind,
    orderKey: 'importance',
    scope: (args, ctx) => {
      const c = ctx as {
        workspaceId?: string;
        harnessSlug?: string | null;
        role?: string | null;
      };
      // WI-2144754: `ownerAgentId` narrows WHICH rows this subscription can
      // ever legitimately see, so it is a cursor dimension, not a rendering
      // preference. Without it a scoped subscriber shares a cursor namespace
      // with the unfiltered feed and an incremental merge can hand it rows its
      // own filter excluded. Absent for every existing caller, which keeps the
      // shape they had plus one empty segment (a one-time cursor reset,
      // already routine at the 5-minute maxDeltaAge below).
      const owner = (args as { ownerAgentId?: unknown } | null | undefined)?.ownerAgentId;
      const ownerKey = typeof owner === 'string' && owner.length > 0 ? owner : '';
      const output = args.output ?? 'feed';
      return `${c.workspaceId ?? ''}:${c.harnessSlug ?? '*'}:${c.role ?? ''}:${ownerKey}:${output}`;
    },
    schemaVersion: 'attn-v1',
    // Periodic forced-full reconciliation: a cursor older than 5 min reconciles to a
    // full snapshot, bounding any drift the harness's incremental merge accumulates.
    maxDeltaAge: 5 * 60_000,
  },
  // context-trimming-tiers P-021: the fattest measured payload (avg 1.09MB).
  // Trimmed/standard sessions get group summaries + top-N items (see
  // attention-shape.ts); the UI (HTTP/sync path, no ctx_tier) reads full, and
  // the cache stores the UNSHAPED groups so one read serves every tier.
  shape: {
    standard: (data) => shapePlansAttention(data, 'standard'),
    trimmed: (data) => shapePlansAttention(data, 'trimmed'),
    // WI-2145871: retires this tool's `unclassified-baseline` debt entry. The
    // shaper returns a fully hand-written envelope, so every key survives only
    // by being named. All four pinned keys are emitted unconditionally, and
    // three of them QUALIFY the rows rather than carry them: `itemsTotal` and
    // `tierCounts` are what say the `groups` rows are a bounded view, and
    // `hint` carries the recovery path. Losing one leaves the rows looking
    // complete — the confident-wrong reading this axis exists to catch.
    contract: { rows: 'groups', preserve: ['tierCounts', 'itemsTotal', 'top', 'hint'] },
  },
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const harnessFilter = args.harnessSlug ?? null;
    const includeArchived = args.includeArchived === true;
    // P-025 / D-019: invoking plans:attention is the owner-presence signal. The
    // owner-present profile selects which EXISTING source legs participate; it
    // does not arm a watch, wake the owner, poll, or create a second queue.
    const ownerAttentionSources = new Set(ownerAttentionSourcesFor('owner-present'));
    const ownerSourceEnabled = (source: OwnerAttentionSource): boolean => ownerAttentionSources.has(source);

    // WI-3348: which workspace partition the open-questions source (#9) reads.
    // coord:ask/ask-owner rows land under the ASKER's identity.workspaceId
    // (WI-1571), so an identity-less read here resolved 'default' and the feed
    // missed every current ask. Resolve the viewed workspace ONCE, up front:
    // the request's workspace (ctx.workspaceId — set for both UI and agent MCP
    // calls; same field the delta-read `scope` above keys on), else the ambient
    // request-ALS/env chain. Captured pre-cachedRead and closure-passed so an
    // SWR background refresh (which runs OUTSIDE the request ALS) still reads
    // the SAME partition the key names.
    const ctxWs = (ctx as { workspaceId?: string | null }).workspaceId?.trim();
    const conversationsWorkspace = ctxWs && ctxWs !== '*' ? ctxWs : conversationsScopeWorkspace();
    // EI-1541: the general workspace-registry partition (harness_smoke_test's
    // own `workspace_id` scheme) resolved the SAME way — the request's
    // ctx.workspaceId when present, else the ambient activeWorkspaceId()
    // fallback. Captured HERE (a plain value, not a re-derived ambient lookup)
    // so the smoke-fail source below reads the right partition even if its
    // async IIFE ends up running detached from the request ALS (an SWR
    // background refresh inside cachedRead — see WI-3348 above). Without this,
    // the source called activeWorkspaceId() again from inside the closure and
    // fell through to the process-global registry workspace whenever the
    // request's workspace wasn't ambiently threaded, leaking every OTHER
    // workspace's failing smoke tests into an isolated workspace's feed.
    const smokeWorkspaceId = ctxWs && ctxWs !== '*' ? ctxWs : activeWorkspaceId();

    // Cache the expensive ~10-source attention aggregation (cache-expensive-tool-reads
    // P-003). The feed is NON-principal-scoped: it always builds the HUMAN's attention
    // view (readInbox('human'), workspace/harness-level escalations/smoke/reports/etc.),
    // never anything keyed to ctx.role/ctx.principal — so the key omits the caller
    // (D-001: no per-caller dimension exists to leak). The output-determining dims are
    // the resolved harness SCOPE (which harness's plans are read), the harnessFilter,
    // includeArchived, and the conversations workspace partition (WI-3348 — a
    // WORKSPACE dimension, not a caller one: two callers viewing the same workspace
    // share the entry; without it in the key one workspace's feed would be served to
    // another from cache). Tags are ONLY the trigger-covered plan tables; the other
    // sources (coord_event_log escalations/messages — append-heavy, the coord:inbox
    // D-006 problem) are deliberately un-tagged and bounded by the short SWR softTtl.
    const aggregation = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: 'plans:attention',
        key: {
          harnessScope: (opts as { harnessSlug?: string }).harnessSlug ?? null,
          harnessFilter,
          includeArchived,
          conversationsWorkspace,
        },
        tags: ['harness_plans', 'plan_revisions', 'plan_runs'],
        softTtlMs: PLANS_ATTENTION_SOFT_TTL_MS,
        // P-007/D-082: the read D-078 measured. :3070 runs 16 workers against
        // per-process L1s, so each paid its OWN cold build of this ~10-source
        // aggregate — the 10s deadline hits below clustered on cold workers right
        // after a deploy. L2 makes one worker's build serve the other fifteen.
        // The value is plain JSON (groups/tierCounts/itemCount), so the jsonb
        // round-trip is shape-preserving; L2 rows expire at the 20s softTtl above,
        // so this can never serve anything staler than L1 would have.
        l2: true,
        // EI-184: bound a genuinely-blocking build (cold L1 / forced rebuild) so this
        // tool call can't exceed its 60s ceiling; degrade to an empty feed on deadline
        // (the build keeps running in the background and lands in cache regardless).
        deadlineMs: PLANS_ATTENTION_DEADLINE_MS,
        onDeadline: emptyAttentionResult,
      },
      async () => {
        const items: AttentionItem[] = [];
        // Narrow an unknown source-row timestamp to what toIsoOrNull accepts, so
        // each pushed item can carry `occurredAt` for the Inbox card date
        // (inbox-pane-active-scope-dates-filters-2026-07-19).
        const tsOf = (v: unknown): string | number | null =>
          typeof v === 'string' || typeof v === 'number' ? v : null;
        // plan-slug → harness, so coord escalations/messages that carry a plan_slug
        // but no recorded harness can still be scoped (backfills items raised before
        // coord:escalate/coord:send began recording the originating harness).
        const planHarness = new Map<string, string>();

        // 1. Plan items — non-terminal (todo/wip/blocked/needs-human).
        try {
          const plans = await readAllPlans({ includeArchived, ...opts });
          const planItems = planItemsToAttention(plans, harnessFilter);
          for (const it of planItems) {
            if (it.planSlug && it.harnessSlug) planHarness.set(it.planSlug, it.harnessSlug);
          }
          items.push(...planItems);
        } catch {
          /* best-effort */
        }

        // Resolve an attention item's harness: its own recorded harnessSlug (now
        // stamped by coord:escalate / coord:send for harness-scoped agents), else
        // derived from its plan_slug, else null — a genuinely workspace-level item
        // (operator/SU/oracle broadcast) where a per-harness chat doesn't apply.
        const resolveHarness = (recHarness: unknown, planSlug: string | null): string | null => {
          if (typeof recHarness === 'string' && recHarness && recHarness !== '*') return recHarness;
          return planSlug ? (planHarness.get(planSlug) ?? null) : null;
        };

        // 2–10 (infra-perf-robustness-audit-2026-06-18 P-005): these source reads are
        // mutually independent — each reads the already-populated `planHarness` +
        // `harnessFilter` (both finalized above) and appends to `items`. They ran
        // SEQUENTIALLY (plans:attention p50 ~2s, ~19k calls/6h — the audit's P2). Run them
        // CONCURRENTLY: output order is irrelevant — buildAttentionGroups re-groups and
        // deterministically re-sorts by importance (ties broken by key), so interleaved
        // pushes (safe in single-threaded JS) change nothing observable. Each stays
        // best-effort in its own try/catch, so one slow/failing source can neither block
        // nor fail the others.
        //
        // The smoke-fail read below needs `@papercusp/db-org`'s `getOrgPg`. Keep
        // this a SINGLE hoisted dynamic import: two concurrent first-time dynamic
        // imports of the SAME specifier inside this Promise.all fan-out race
        // Vitest's mock interception (attention-parallel-db-org-mock-race-2026-07-17)
        // — only the import that wins the race gets the vi.mock'd module, the other
        // silently falls through to the real implementation. If you add a source
        // that needs PG, prefer a dedicated helper module the test can mock by
        // path (see needs-human-work-items-source.ts) over another getOrgPg call.
        const dbOrgImportP = import('@papercusp/db-org');
        await Promise.all([
          // 2. Open coord escalations (workspace-level).
          (async () => {
            if (!ownerSourceEnabled('open-owner-escalations')) return;
            try {
              const { listEscalations } = await import('../coordination/escalations');
              // EI-1541: listEscalations has no workspace param of its own — it
              // reads through coordLog, whose PG backend resolves its partition
              // from coordScopeWorkspace() -> activeWorkspaceId(), an AMBIENT
              // (request-ALS) lookup. Pin that ALS to the workspace resolved up
              // front (ctx.workspaceId, else the coord-plane fallback) for the
              // duration of this call, mirroring source #9's WI-3348 fix below —
              // otherwise a detached SWR background refresh (or any call that
              // loses the request ALS) falls through to the global registry
              // workspace and every isolated workspace's Overview/Working "NEEDS
              // YOU" panel shows every OTHER workspace's open escalations.
              const escs = await runWithWorkspace(conversationsWorkspace, () => listEscalations({ status: 'open' }));
              for (const e of escs) {
                items.push({
                  ...coordEscalationToAttention({
                    msgId: e.msg_id,
                    severity: e.severity,
                    summary: typeof e.summary === 'string' ? e.summary : '',
                    body: typeof e.body === 'string' ? e.body : undefined,
                    planSlug: typeof e.plan_slug === 'string' ? e.plan_slug : null,
                    harnessSlug: resolveHarness(e.harnessSlug, typeof e.plan_slug === 'string' ? e.plan_slug : null),
                    options: Array.isArray(e.options) ? e.options : [],
                    // The escalating agent — drives the "Message owner" action (D-005).
                    from: typeof e.from === 'string' ? e.from : null,
                    goalRef:
                      typeof (e as { goalRef?: unknown }).goalRef === 'string'
                        ? ((e as { goalRef?: unknown }).goalRef as string)
                        : null,
                    // EI-19401034233741994: `openEscalation` spreads its `meta`
                    // bag FLAT onto the envelope, so an ask-owner escalation
                    // carries its conversation twin's id right here (the same
                    // seam `selectEscalationsForConversation` reads). Carrying
                    // it onto the item lets step 9a drop the Alert-tier
                    // conversation card rendering the SAME question.
                    conversationId:
                      typeof (e as { conversationId?: unknown }).conversationId === 'string'
                        ? ((e as { conversationId?: unknown }).conversationId as string)
                        : null,
                  }),
                  occurredAt: toIsoOrNull(tsOf((e as { ts?: unknown }).ts)),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 3. Coord messages addressed to the human (most recent, capped).
          //    Drop messages acked from the human's admin coord UI so "Acknowledge"
          //    dismisses. Scoped to ADMIN_COORD_UI_OWNER (the id those acks are
          //    authored as) — NOT a global ack-set, so an agent acking a broadcast
          //    can't suppress it from the human's inbox (security review).
          (async () => {
            try {
              const { readInbox, readAckedMsgIds } = await import('../coordination/messages');
              const { ADMIN_COORD_UI_OWNER } = await import('../coordination/identity');
              // EI-1541: same coordLog ambient-workspace pitfall as source #2 —
              // pin the ALS so a detached SWR refresh can't fall through to the
              // global registry workspace and leak another workspace's
              // messages-to-human into this one's feed.
              // Bounded read (EI-19323045109346905) — replaces an unbounded
              // ~20k-row scan when only the newest `WINDOW` rows are ever used.
              //
              // The stopping rule here is the RAW entry count, NOT the post-filter
              // count its sibling call sites use, and the discriminator is the ORDER
              // of slice vs filter: this caller slices the newest WINDOW FIRST and
              // only then drops acked ones. So acked messages legitimately consume
              // window slots and the output may be fewer than WINDOW. Counting only
              // UNACKED entries would page further back and change behaviour — it
              // would surface older messages this view has deliberately never shown.
              // (`kinds` is applied inside readInbox, so `enough` already sees it.)
              const WINDOW = 50;
              const [msgs, acked] = await runWithWorkspace(conversationsWorkspace, () =>
                Promise.all([
                  readInbox('human', { kinds: ['message'] }, { enough: (entries) => entries.length >= WINDOW }),
                  readAckedMsgIds(ADMIN_COORD_UI_OWNER),
                ]),
              );
              const page = msgs.slice(-WINDOW).filter((m) => !acked.has(m.msg_id));
              // personal-data-reader-set-labels P-006 / D-006: a restricted sender's
              // message is persisted as a sealed stub. The owner is always a
              // permitted reader, so the Inbox shows what was written; if the
              // sealed store cannot be read, the stub is shown instead.
              const { COORD_SEAL_STORE, mergeUnsealed, sealMarkerOf } = await import('../../personal-vault/coord-seal');
              const sealedRefs = page.filter((m) => sealMarkerOf(m)).map((m) => m.msg_id);
              const opened = sealedRefs.length
                ? await import('../../personal-vault/sealed-contents')
                    .then(async ({ openSealedForOwner }) =>
                      (await import('@papercusp/db-org')).withWorkspace(conversationsWorkspace, (tx) =>
                        openSealedForOwner(tx, { workspaceId: conversationsWorkspace, store: COORD_SEAL_STORE, refs: sealedRefs }),
                      ),
                    )
                    .catch(() => new Map<string, Record<string, unknown>>())
                : new Map<string, Record<string, unknown>>();
              for (const raw of page) {
                const content = opened.get(raw.msg_id);
                const m = content ? mergeUnsealed(raw, content) : raw;
                const mm = m as typeof m & {
                  auto?: unknown;
                  lifecycle?: unknown;
                  report?: unknown;
                };
                items.push({
                  ...coordMessageToAttention({
                    msgId: m.msg_id,
                    summary: typeof m.summary === 'string' ? m.summary : undefined,
                    body: typeof m.body === 'string' ? m.body : undefined,
                    from: m.from,
                    planSlug: typeof m.plan_slug === 'string' ? m.plan_slug : null,
                    harnessSlug: resolveHarness(m.harness_slug, typeof m.plan_slug === 'string' ? m.plan_slug : null),
                    // Structured lifecycle markers coord:emit stamps (D-003) — classify
                    // an auto lifecycle broadcast as Activity, not a Decision.
                    auto: mm.auto === true,
                    lifecycle: typeof mm.lifecycle === 'string' ? mm.lifecycle : null,
                    // A message addressed DIRECTLY to the human (not solely a `*`
                    // broadcast) is a genuine ping → Decision.
                    directToOwner: Array.isArray(m.to) && m.to.includes('human'),
                    // agent-report-cards-2026-07-17 P-002: a structured report card
                    // (coord:send `report`, stamped on the envelope) — passed RAW;
                    // the adapter re-validates it through parseReportBlock and
                    // renders it as a 📋 card in the Inbox detail pane.
                    report: mm.report,
                  }),
                  occurredAt: toIsoOrNull(tsOf((m as { ts?: unknown }).ts)),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 4. Failing smoke tests (PG, workspace-scoped). (The plan-review source
          //    was retired by B-14/P-101 — needs-human plan items, a plan-governance
          //    Decision, are the review gate now; harness_plan_review had no live
          //    writer after the bash orchestrator was archived.)
          (async () => {
            try {
              const { getOrgPg } = await dbOrgImportP;
              const { sql } = getOrgPg();
              // EI-1541: use the workspace resolved up front (ctx.workspaceId,
              // else activeWorkspaceId()'s own fallback) rather than
              // re-deriving it here — a re-derived ambient lookup falls
              // through to the global registry workspace whenever this IIFE
              // runs detached from the request ALS (an SWR background
              // refresh), leaking every OTHER workspace's failing smoke tests
              // into an isolated workspace's Overview/Working "NEEDS YOU"
              // panel (confirmed root cause).
              const wid = smokeWorkspaceId;
              const hf = harnessFilter;

              const smoke = await sql<{ harness_slug: string; failure_content: string | null }[]>`
            SELECT harness_slug, failure_content
              FROM harness_shared.harness_smoke_test
             WHERE workspace_id = ${wid}
               AND status = 'fail'
               AND (${hf}::text IS NULL OR harness_slug = ${hf})
          `;
              for (const r of smoke) {
                items.push(
                  smokeFailToAttention({
                    harnessSlug: r.harness_slug,
                    failureContent: r.failure_content,
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 6. Operator `<report>` turns — the operator's structured output is an
          //    inbox surface, not chat content (report-cards-inbox-reconciliation
          //    D-002). One item per report turn at the worst-of tier (D-003); the
          //    recent window + triage (resolve → handled) keep the feed clean (D-004).
          (async () => {
            try {
              const { readRecentOperatorReports } = await import('../../attention/operator-report-source');
              const reportTurns = await readRecentOperatorReports();
              items.push(...reportTurnsToAttention(reportTurns));
            } catch {
              /* best-effort */
            }
          })(),

          // ── B-14 / P-100 (D-011): the folded disposition channels. Each surfaces
          //    ONLY the genuinely-awaiting-human slice (never the execution backlog —
          //    work_items stay separate); the Queen auto-handles the rest once armed.

          // 7. Human-routed improvements — engineer_issues the auto-implement loop
          //    flagged `needsHuman` (NOT the whole open backlog; that stays pull on the
          //    Learning tab, operator-learning-tab D-001).
          (async () => {
            try {
              const { readImprovementItems } = await import('../../harness/improvements/read-items');
              const improvements = await readImprovementItems({
                state: 'open',
                ...(harnessFilter ? { harnessSlug: harnessFilter } : {}),
              });
              for (const c of improvements) {
                if (c.needsHuman !== true) continue;
                const slug = c.scope?.startsWith('harness:') ? c.scope.slice('harness:'.length) : null;
                items.push({
                  ...improvementToAttention({
                    issueId: c.id,
                    title: c.title,
                    body: c.body,
                    severity: c.severity,
                    harnessSlug: slug,
                    ideaLifecycle: c.ideaLifecycle,
                    decidedReason: c.decidedReason ?? null,
                  }),
                  occurredAt: toIsoOrNull(
                    tsOf(
                      (c as { updatedAt?: unknown; createdAt?: unknown }).updatedAt ??
                        (c as { createdAt?: unknown }).createdAt,
                    ),
                  ),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 8. Standing-approval candidates awaiting the owner (≥3 silent dispatches
          //    in 24h). Cheap cached read — never re-queries audit_log here.
          (async () => {
            try {
              const { readCandidates } = await import('../../operator-standing-candidates');
              const cands = await readCandidates();
              for (const s of cands) {
                if (harnessFilter && s.targetHarness !== harnessFilter) continue;
                items.push({
                  ...standingApprovalToAttention({
                    capability: s.capability,
                    targetHarness: s.targetHarness,
                    count: s.count,
                    lastSeenAt: s.lastSeenAt,
                  }),
                  occurredAt: toIsoOrNull(tsOf(s.lastSeenAt)),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 9. Open agent questions / coord:ask conversations awaiting an answer.
          (async () => {
            if (!ownerSourceEnabled('open-owner-questions')) return;
            try {
              const { listConversationsWithTopics } = await import('../coordination/conversations');
              // Pinned to the workspace resolved up front (and named in the cache
              // key) — NOT the ambient ALS, which is absent on agent MCP calls and
              // on SWR background refreshes and would fall to 'default' (WI-3348).
              const convs = await runWithWorkspace(conversationsWorkspace, () =>
                listConversationsWithTopics({
                  kind: 'question',
                  state: 'open',
                  ...(harnessFilter ? { harness_slug: harnessFilter } : {}),
                }),
              );
              for (const c of convs as unknown as Array<Record<string, unknown>>) {
                // Already-answered (accepted) questions are not awaiting the human.
                const answered = typeof c.accepted_answer === 'string' && c.accepted_answer.trim().length > 0;
                if (answered) continue;
                const id = typeof c.id === 'string' ? c.id : null;
                if (!id) continue;
                items.push({
                  ...conversationToAttention({
                    conversationId: id,
                    title: typeof c.title === 'string' ? c.title : 'Open question',
                    body: typeof c.body === 'string' ? c.body : null,
                    askerId: typeof c.asker_id === 'string' ? c.asker_id : null,
                    harnessSlug: resolveHarness(c.harness_slug, null),
                  }),
                  // The conversation store maps its rows to updated_ts/created_ts
                  // (conversations-store.ts) — NOT updated_at/created_at.
                  occurredAt: toIsoOrNull(tsOf(c.updated_ts ?? c.created_ts)),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 10. Scout grading — ONE rollup nudge if any routed idea is ungraded
          //     (optional feedback, never one item per idea — there can be thousands).
          (async () => {
            try {
              const { readRoutedIdeas } = await import('../../scout/routed-ledger');
              const routed = await readRoutedIdeas(harnessFilter ? { harnessSlug: harnessFilter } : {});
              const ungraded = routed.filter((r) => r.humanGrade === undefined).length;
              if (ungraded > 0) items.push(scoutGradeToAttention({ count: ungraded }));
            } catch {
              /* best-effort */
            }
          })(),

          // ── owner-inbox-single-pane-2026-07-17 P-005: the folded owner-gate
          //    channels — each a DISTINCT wall a working agent explicitly
          //    raised (D-001: never a bare turn-ending prose question).

          // 11. Needs-human work-items of EVERY kind (P-005a) — feature/chunk
          //     (`needs_human_review`) and bug/change/task
          //     (`payload.needsHuman`), read off the single cross-kind
          //     `harness_shared.work_items` VIEW (unify-work-items D-010(b))
          //     rather than either per-kind reader, so neither family's
          //     dialect is missed. Overlaps sources 7/12 by construction;
          //     resolved post-fan-out by `dropDuplicateNeedsHumanWorkItems` (D-008).
          //     The read lives in its own module (needs-human-work-items-source)
          //     so tests mock it by path like every other source.
          (async () => {
            if (!ownerSourceEnabled('needs-human-work-items')) return;
            try {
              const { readNeedsHumanWorkItems } = await import('../../attention/needs-human-work-items-source');
              const rows = await readNeedsHumanWorkItems({
                harness: harnessFilter,
              });
              for (const r of rows) {
                const payload =
                  r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {};
                const ownerGateKeys = (['needsHuman', 'needsOwnerAction'] as const).filter(
                  (key) => payload[key] === true,
                );
                items.push({
                  ...workItemNeedsHumanToAttention({
                    workItemId: r.feature_id,
                    itemKind: r.item_kind ?? 'unknown',
                    title: r.title ?? r.feature_id,
                    harnessSlug: resolveHarness(r.harness_slug, null),
                    ownerAgentId: r.taken_by,
                    // Owner-attention ledger (EI-23783029010995961): say what the system
                    // will do if the owner never answers, in the card the owner reads.
                    body: [
                      (r.summary ?? '').trim() || r.title || r.feature_id,
                      ownerAskDefaultDisclosure(r.payload),
                    ]
                      .filter(Boolean)
                      .join('\n\n'),
                    // P-003: WHICH leg of the source query admitted this row —
                    // the terminal action clears a different gate for each.
                    status: r.status,
                    ownerGateKeys,
                  }),
                  // Migration 896: lifecycle age, not metadata churn. Legacy
                  // NULL remains unknown rather than pretending a recent
                  // summary/edit is when the item entered needs-human.
                  occurredAt: toIsoOrNull(r.state_changed_at),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 12. Registered owner-walls (P-005b) — the `coord:walls` union
          //     (loop:checkpoint carry-note walls + needs-human work-items),
          //     reused verbatim (reuse-first) so the SAME rows an owner would
          //     see via `coord:walls` also surface in the unified inbox.
          (async () => {
            if (!ownerSourceEnabled('owner-walls')) return;
            try {
              const { listOwnerWalls } = await import('../coordination/tools/walls');
              const { activeWorkspaceId } = await import('../../workspace-registry');
              const { walls } = await listOwnerWalls({
                workspaceId: activeWorkspaceId(),
                harness: harnessFilter ?? undefined,
              });
              for (const w of walls) {
                items.push({
                  ...ownerWallToAttention({
                    source: w.source,
                    ownerId: w.ownerId,
                    harnessSlug: resolveHarness(w.harness, null),
                    claim: w.claim,
                    recheck: w.recheck ?? null,
                    ref: w.ref ?? null,
                    factScope: w.factScope,
                    factScopeRef: w.factScopeRef,
                    factKey: w.factKey,
                    waitingHours: w.waitingHours,
                    status: w.status,
                    actionability: w.actionability,
                    livenessState: w.livenessState,
                  }),
                  // A wall has no stored timestamp, but waitingHours is how long
                  // it has been open — derive when it was raised.
                  occurredAt:
                    typeof w.waitingHours === 'number' && Number.isFinite(w.waitingHours)
                      ? new Date(Date.now() - w.waitingHours * 3_600_000).toISOString()
                      : null,
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 13. Pending dark-flag ratifications (P-005c) — the KNOWN_DARK_FLAGS
          //     allowlist entries whose case genuinely awaits an owner action
          //     ('owner-authority' / 'cutover' — NOT 'parked'/'incomplete',
          //     which are deliberately-not-ready regardless of owner input).
          //     A pure in-process read of the static map — no I/O, no per-key
          //     PostHog round-trip (bounding this leg's cost).
          (async () => {
            try {
              const { DARK_FLAGS, DARK_FLAGS_OWNER_REVIEW_BY } = await import('@papercusp/flags');
              for (const [key, entry] of DARK_FLAGS) {
                if (entry.case !== 'owner-authority' && entry.case !== 'cutover') continue;
                items.push(
                  darkFlagRatificationToAttention({
                    flagKey: key,
                    justification: entry.reason,
                    reviewBy: DARK_FLAGS_OWNER_REVIEW_BY,
                  }),
                );
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 14. Watcher blocked-session + mirrored-ask (P-005d) — open
          //     `session_pending_gates` rows (owner-inbox-single-pane P-002):
          //     the client-agnostic backstop for a client whose hook can't
          //     mirror an unstructured ask as a structured envelope (D-002 —
          //     Codex has no turn-end hook at all; this is its only path in).
          (async () => {
            if (!ownerSourceEnabled('pending-owner-gates')) return;
            try {
              const { listPendingGates } = await import('../../attention/gate-store');
              const { activeWorkspaceId } = await import('../../workspace-registry');
              const gates = await listPendingGates({
                workspaceId: activeWorkspaceId(),
                order: 'oldest',
                limit: 100,
              });
              const gateOwners = [
                ...new Set(gates.map((g) => g.owner_id).filter((ownerId): ownerId is string => Boolean(ownerId))),
              ];
              let gateVerdicts = new Map<string, LivenessVerdict>();
              if (gateOwners.length > 0) {
                try {
                  const subjects: LivenessSubject[] = gateOwners.map((ownerId) => ({ ownerId }));
                  gateVerdicts = await resolveSessionStates(subjects, { hydratePerId: true });
                } catch {
                  // Preserve pending rows as unknown rather than turning a
                  // liveness read failure into a false owner decision.
                }
              }
              const now = Date.now();
              for (const g of gates) {
                if (harnessFilter && g.harness_slug && g.harness_slug !== harnessFilter) continue;
                const verdict = g.owner_id ? gateVerdicts.get(g.owner_id) : undefined;
                const openedMs = g.opened_at ? new Date(g.opened_at).getTime() : null;
                const waitingHours = openedMs != null ? (now - openedMs) / 3_600_000 : null;
                items.push({
                  ...blockedSessionToAttention({
                    sessionId: g.session_id,
                    client: g.client,
                    refId: g.ref_id,
                    gateKind: g.kind,
                    question: g.question,
                    decideBy: g.decide_by,
                    defaultIfUnanswered: g.default_if_unanswered,
                    ownerAgentId: g.owner_id,
                    harnessSlug: resolveHarness(g.harness_slug, null),
                    waitingHours,
                    actionability: classifyReadActionability(verdict?.sessionState),
                    livenessState: verdict?.sessionState ?? null,
                  }),
                  occurredAt: toIsoOrNull(g.opened_at ?? null),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 15. Blocked work-items of EVERY kind (curated-signal-cards P-001) —
          //     `status='blocked'` rows off the same cross-kind
          //     `harness_shared.work_items` VIEW source #11 reads. Source #1
          //     already surfaces a blocked PLAN item as an Alert, but it reads
          //     plan DOCUMENTS only, so a blocked work-item row (often with no
          //     plan attached) had no card — even though the curated digest's
          //     `🚧 Blocked` chat line scans exactly this table. Alert tier,
          //     never a Decision: stuck work is worth surfacing, but unblocking
          //     is work, not a triage verdict.
          (async () => {
            try {
              const { readBlockedWorkItems } = await import('../../attention/blocked-work-items-source');
              const rows = await readBlockedWorkItems({
                harness: harnessFilter,
              });
              for (const r of rows) {
                items.push({
                  ...blockedWorkItemToAttention({
                    workItemId: r.feature_id,
                    itemKind: r.item_kind ?? 'unknown',
                    title: r.title ?? r.feature_id,
                    reason: r.reason,
                    harnessSlug: resolveHarness(r.harness_slug, null),
                    ownerAgentId: r.taken_by,
                    // The curator emits this row's drill-in as
                    // `wi:<harness>#<featureId>`; carrying the same ref lets the
                    // shipped resolveInboxDrillIn select THIS card.
                    curatorRef: r.harness_slug ? `${r.harness_slug}#${r.feature_id}` : null,
                  }),
                  occurredAt: toIsoOrNull(r.updated_ts),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 16. Possibly-unrecorded owner decisions (EI-147) — a closed
          //     session_pending_gates 'ask' row with no plans:add-decision /
          //     ratify-decision call by the same owner afterward. A
          //     mechanical, no-LLM-judgment heuristic (decision-owed-source.ts);
          //     Alert tier — a nudge to review, never a governed decision.
          (async () => {
            try {
              const { readDecisionsOwed } = await import('../../attention/decision-owed-source');
              const { activeWorkspaceId } = await import('../../workspace-registry');
              const owed = await readDecisionsOwed({ workspaceId: activeWorkspaceId() });
              for (const d of owed) {
                if (harnessFilter && d.harnessSlug && d.harnessSlug !== harnessFilter) continue;
                items.push({
                  ...decisionOwedToAttention({
                    sessionId: d.sessionId,
                    refId: d.refId,
                    client: d.client,
                    question: d.question,
                    ownerAgentId: d.ownerId,
                    harnessSlug: resolveHarness(d.harnessSlug, null),
                    closedAt: d.closedAt,
                  }),
                  occurredAt: toIsoOrNull(tsOf(d.closedAt)),
                });
              }
            } catch {
              /* best-effort */
            }
          })(),

          // 17. Owner directives nobody is handling (owner-directive-delivery-redesign
          //     P-008 / R-7) — open, their session ENDED, and no live fleet leader or
          //     work-item holder to take them. Workspace-level: no harness scope.
          (async () => {
            try {
              const { readUnhandledDirectives } = await import('../../attention/unhandled-directives-source');
              const { activeWorkspaceId } = await import('../../workspace-registry');
              for (const d of await readUnhandledDirectives({ workspaceId: activeWorkspaceId() })) {
                items.push({ ...unhandledDirectiveToAttention(d), occurredAt: toIsoOrNull(tsOf(d.createdAt)) });
              }
            } catch {
              /* best-effort */
            }
          })(),
        ]);

        // 11a. D-008 dedupe: a `work-item-needs-human` (P-005a) row that a more
        //      specific source (improvement / owner-wall) already surfaces for
        //      the SAME underlying id is dropped — one card per real ask.
        {
          const kept = dropDuplicateNeedsHumanWorkItems(items);
          items.length = 0;
          items.push(...kept);
        }

        // 15a. curated-signal-cards P-002: the same canonicalization for source
        //      #15 — an issue-family row can be `status='blocked'` AND carry
        //      `payload.needsHuman`, so drop the Alert-tier blocked card when a
        //      Decision-tier needs-human card already covers that id. Runs AFTER
        //      11a so it sees the post-dedupe needs-human set.
        {
          const kept = dropDuplicateBlockedWorkItems(items);
          items.length = 0;
          items.push(...kept);
        }

        // 9a. EI-19401034233741994: one coord:ask-owner question renders as BOTH
        //     a Decision-tier escalation (source #2) and an Alert-tier
        //     conversation (source #9). Same canonicalization as 11a/15a — the
        //     Decision framing wins, its Alert twin is dropped, so the owner
        //     sees ONE card per real question.
        {
          const kept = dropDuplicateQuestionConversations(items);
          items.length = 0;
          items.push(...kept);
        }

        // 11. Decision↔execution dedup guard (B-14 / P-104 · D-013): drop any
        //     plan-item that has been CONVERTED to a work_item (an `implements`
        //     edge) — it executes in the Working tab now, so it must not ALSO show
        //     as a Queue decision/row. A needs-human DECISION always stays.
        //     Best-effort: a failed lookup leaves every item (no silent hiding).
        try {
          const { listConvertedPlanItemRefs } = await import('../../plan-items/convert');
          // Deliberately UNSCOPED: the implements plane is split by family across two
          // workspaces (see listConvertedPlanItemRefs), so pinning this to one tenant —
          // including this request's own — makes the dedupe blind to a whole family and lets
          // converted items render in BOTH the Queue and Working, the exact double-render
          // D-013 exists to prevent. The union is the only complete answer.
          const convertedRefs = await listConvertedPlanItemRefs();
          if (convertedRefs.size > 0) {
            const kept = dropConvertedPlanItems(items, convertedRefs);
            items.length = 0;
            items.push(...kept);
          }
        } catch {
          /* best-effort */
        }

        // 12. Operator triage overlay (D-006): a downgrade/resolve moves the item to
        //    the auditable "Handled by operator" tier, an escalate/confirm keeps it
        //    a Decision — never a silent vanish. Best-effort: no triage table / PG
        //    offline degrades to "untriaged", never a failed feed.
        let triaged = items;
        try {
          const triage = await readTriageByWorkspace();
          if (triage.size > 0) {
            triaged = items.map((it) => {
              const rec = triage.get(it.id);
              return rec ? applyTriage(it, rec) : it;
            });
          }
        } catch {
          /* best-effort */
        }

        // 13. Authorizer split (queue-authorization-redesign P-002 / D-001): stamp WHO
        //     must sign off + WHY each Decision is gated, for the Queue's A1 grouping.
        //     One flag read; pure per-item derivation. Best-effort — on failure items
        //     keep undefined authorizer/whyGated and the UI falls back to the tier list.
        try {
          let armed = false;
          try {
            const { FLAGS } = await import('@papercusp/flags');
            const { getFlag } = await import('@papercusp/flags/server');
            const { activeWorkspaceId } = await import('../../workspace-registry');
            armed = await getFlag(FLAGS.MUG_AUTONOMY_ARMED, `autonomy:${activeWorkspaceId()}`);
          } catch {
            /* fail-safe: treat as unarmed */
          }
          triaged = triaged.map((it) => ({
            ...it,
            ...deriveAuthorization(it, armed),
          }));
        } catch {
          /* best-effort */
        }

        const groups = buildAttentionGroups(triaged);
        const tierCounts = groupByTier(triaged).counts;
        // Derive once per cache build, before transport serialization. The badge
        // and ref lookup must not copy/sort/serialize full item bodies on every hit.
        return { groups, tierCounts, itemCount: triaged.length, projections: attentionProjections(groups), degraded: false };
      },
    );
    const { groups, tierCounts } = aggregation;

    // WI-2144754: the owner filter runs in the presentation layer too, BEFORE
    // the window — that ordering is the whole point. Filtering after the page
    // would just re-create the bug in a different file: page one of the
    // fleet-wide feed, then thinned to whatever of this owner's items happened
    // to survive it. Regroup rather than splice, so `maxImportance` and the
    // dropped-empty-group set stay derived rather than patched.
    const ownerFilter = args.ownerAgentId ?? null;
    const scopedGroups = ownerFilter ? scopeGroupsToOwner(groups, ownerFilter) : groups;
    if (args.output === 'counts' || args.output === 'refs') {
      // Older L2 entries may predate projections. Reuse their canonical groups;
      // neither the presentation mode nor owner filter forks the source cache.
      const projections = ownerFilter
        ? attentionProjections(scopedGroups)
        : aggregation.projections ?? attentionProjections(groups);
      const degraded = aggregation.degraded === true;
      ctxAny.metadata?.({ itemCount: projections.counts.total, output: args.output, degraded });
      return { data: args.output === 'counts'
        ? { counts: projections.counts, degraded }
        : { refs: projections.refs, degraded } };
    }
    // Counts must describe the set they were computed over. `tierCounts` is
    // documented below as "the complete-feed count, not the page count" — with
    // a scope argument in play, the complete feed IS the scoped one, and
    // handing back fleet-wide numbers would make a scoped read's badge lie.
    const scopedTierCounts = ownerFilter ? groupByTier(scopedGroups.flatMap((g) => g.items)).counts : tierCounts;

    // Apply the presentation window only after the complete source aggregation
    // has been built and cached. Counts/detail consumers can therefore request
    // `limit:null` (or call the cached read directly) without losing rows, while
    // the normal UI path sends a small deterministic page.
    const windowed = paginateAttentionGroups(scopedGroups, {
      limit: args.limit,
      offset: args.offset,
    });
    // Sync reads are flat arrays. Carry the window metadata on the first group
    // using the shared list-meta convention; delta merges may move that group,
    // so clients search all rows for `_meta` rather than assuming row zero.
    const groupsWithMeta = attachListMeta(windowed.groups, {
      ...windowed.meta,
      // This is the complete-feed count, not the page count. It keeps badges
      // honest when a bounded page is being rendered. Under `ownerAgentId` the
      // complete feed IS the scoped one (WI-2144754).
      tierCounts: scopedTierCounts,
    });

    ctxAny.metadata?.({
      itemCount: windowed.meta.returned,
      totalItemCount: windowed.meta.total,
      groupCount: groupsWithMeta.length,
      decisions: scopedTierCounts.decision,
      scope: harnessFilter ?? 'all',
      ...(ownerFilter ? { ownerAgentId: ownerFilter } : {}),
      ...(windowed.meta.hasMore ? { hasMore: true, nextOffset: windowed.meta.nextOffset } : {}),
    });

    // {data} envelope so the payload-tier shapers apply; HTTP/sync consumers
    // still read identical `{"groups":[...],"tierCounts":{...}}` JSON text.
    return { data: { groups: groupsWithMeta, tierCounts: scopedTierCounts } };
  },
});
