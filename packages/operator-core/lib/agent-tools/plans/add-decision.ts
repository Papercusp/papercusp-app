/**
 * plans:add-decision — append one OR many new decisions with allocated D-NNN ids.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2 + §4.4.
 *
 * ID allocation MUST happen inside the lock — two concurrent calls
 * without serialization would both observe the same "max D-NNN" and
 * produce colliding ids. The withPlanLock helper holds the lock across
 * read → allocate → write.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, title, body }, or many decisions (any plan) via
 * items:[{ slug, title, body, refs?, affects? }] → { ok, results:[{ ok, slug,
 * decisionId, propagated_to? | error }], counts }. This is a PLAN-level write, so
 * the self-describing key is { slug } and each result also carries its NEW
 * decisionId. Correlate by id not array position; one failure never fails the rest.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import {
  parsePlan,
  maskFences,
  normalizeDecisionBodyHeadings,
  type LegacyReason,
  type PlanDecision,
} from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { readPlanBySlug, VALID_PLAN_SLUG } from './source';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { emitDecisionAdded } from '../../harness/usage-emitters';
import { runBulk, bulkContent, bulkEnvelopeSchema, type BulkItemResult } from '../_bulk';
import { hardText, LIMITS } from '../limits';
import { recoverHarnessFromSlugs, requireUnambiguousSlugScope } from './slug-scope';
import {
  citedDecisionAuthorities,
  decisionProvenance,
  FALSIFIED_OWNER_ANCHOR_NOTE,
  hasConcreteDecisionMeasurement,
} from './decision-provenance';
import { neutralizeToolCallTags } from '../../text-safety';
import { planDecisionRef } from '../../agent-goal-ref';
import {
  allocateNextDecisionId,
  appendDecisionToBody,
  decisionIdsMissingFromLiveBody,
  normalizeAffects,
} from './decision-body';
import { reevaluateBarReadinessOnScopeWrite, type BarReadinessResult } from './plan-scope-cascade';
import { defaultBarReadinessDeps } from './plan-scope-cascade-deps';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  evaluateFrozenLineageCarryText,
  frozenLineageCarryViolationPayload,
} from '../../release/frozen-lineage-execution-policy';
import { resolveHomeGateVerdictTarget } from '../../release/gate-verdict-target';

const REFS = z
  .array(z.string().regex(/^P-\d{3,}$/))
  .describe('Item IDs this decision relates to. Appear in the body as P-NNN tokens.');

const ITEM_REFS_ALIAS_DESC =
  'Alias for `refs` (EI-18735663944089262) — plans:get returns a decision\'s item refs under this exact name (itemRefs), so accepting it here means a read-then-write roundtrip does not need a field rename. Both fields enforce the same in-plan `P-NNN` reference format; work-item/issue ids are not accepted. Prefer `refs`; if both are given, `refs` wins.';

const AFFECTED_PLAN_SLUG = z
  .string()
  .min(1)
  .regex(VALID_PLAN_SLUG, 'existing plan slug (filename stem)')
  .describe(
    'An existing OTHER plan slug (the plan filename stem). This is not a surface label, work-item/issue id, or P-NNN item reference; use refs/itemRefs for in-plan P-NNN references.',
  );

const AFFECTS = z.array(AFFECTED_PLAN_SLUG).max(20);
const AFFECTS_DESC =
  'Existing plan slugs of OTHER plans this decision bears on. The edge is stored canonically as `Affects:` metadata on the source decision and indexed for affected-plan claimants; each affected plan also gets a cross-reference plan_event + watcher notify. Surface labels and item/work-item ids are not accepted here.';

const DECISION_BODY_DESC =
  'The decision body. HARD CAP 5000 chars — over-length is REJECTED, not truncated, so split a long rationale or trim before calling. ' +
  'Measure before you rule: when the decision asserts a factual claim about the tree, read the tree and add a `Measured:` line naming the file:line or command + result. A decision cited from another decision is authority for design, not evidence about current code.';

const itemSpec = z.object({
  slug: z.string().min(1),
  title: hardText(LIMITS.SHORT_TITLE),
  body: hardText(5000).describe(DECISION_BODY_DESC),
  refs: REFS.optional(),
  itemRefs: REFS.optional().describe(ITEM_REFS_ALIAS_DESC),
  affects: AFFECTS.optional().describe(AFFECTS_DESC),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

const argsSchema = z
  .object({
    slug: z.string().min(1).optional(),
    harness: harnessArg,
    title: hardText(LIMITS.SHORT_TITLE).optional(),
    body: hardText(5000).optional().describe(DECISION_BODY_DESC),
    refs: REFS.optional(),
    itemRefs: REFS.optional().describe(ITEM_REFS_ALIAS_DESC),
    affects: AFFECTS.optional().describe(AFFECTS_DESC),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('add many decisions at once — each { slug, title, body, refs?, affects?, harness? }'),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional — a short why for this revision. A decision body already carries its own reasoning, so this is rarely needed. Stored on the plan revision (D-009).',
      ),
  })
  .refine(
    (a) => (a.items?.length ?? 0) > 0 || (Boolean(a.slug) && Boolean(a.title) && Boolean(a.body)),
    { message: 'pass { slug, title, body } for one, or items:[{ slug, title, body }] for many' },
  );

interface NewDecision {
  slug: string;
  title: string;
  body: string;
  refs?: string[];
  affects?: string[];
  harness?: string;
  rationale?: string;
}

export interface DecisionMeasurementAdvisory {
  code: 'tree_fact_measurement_missing';
  paths: string[];
  message: string;
}

// Advisory-only by design: a path can appear in a design example that makes no
// factual claim, so rejecting every match would create false-positive governance
// failures. The returned warning is nevertheless machine-visible on the exact
// write that needs review, rather than relying on a prompt sentence alone.
const SOURCE_PATH_RE = /\b(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|rs|go|py)(?::\d+)?\b/g;
// Deliberately tolerant of how the label is WRITTEN, strict about whether
// evidence FOLLOWS it. A false alarm here is the expensive failure: this
// advisory's whole job is to catch a decision asserting tree facts it never
// verified, so firing it at an author who DID measure teaches "this warning is
// noise", and then it protects nothing when a genuinely unmeasured decision
// arrives. Measured 2026-08-30 against the anchored `^\s*Measured\b` form it
// replaces: that version demanded a literal `M` immediately after leading
// whitespace, so every markdown-decorated form silently read as absent —
// `**Measured:**`, `- Measured:`, `> Measured:` — and its 80-char qualifier cap
// rejected a 166-char parenthetical heading. TWO reporters filed it
// (EI-21900576470401486 bold, EI-21850043257707007 long qualifier) and BOTH
// diagnoses of the mechanism were wrong — one blamed colon adjacency, the other
// an inner colon in the qualifier; measurement showed neither. A THIRD variant
// (`- Measured:`) nobody had reported fell out of the same root cause. That is
// why the accepted and rejected forms are pinned as tests below rather than
// argued from the pattern.
//
// Accepts: an optional list/quote marker, optional markdown emphasis around the
// label, an optional `(...)`/`[...]` qualifier up to 200 chars (or a short bare
// one, as before), and evidence that may begin on the following line.
// Still rejects: a label with nothing after it — a promise is not a measurement.
export function decisionMeasurementAdvisory(body: string): DecisionMeasurementAdvisory | null {
  const paths = [...new Set(body.match(SOURCE_PATH_RE) ?? [])].slice(0, 12);
  if (paths.length === 0 || hasConcreteDecisionMeasurement(body)) return null;
  return {
    code: 'tree_fact_measurement_missing',
    paths,
    message:
      'This decision names source-like paths but has no `Measured:` line. If it asserts current tree behavior, ' +
      'open the code and amend the decision with `Measured: <file:line or command + result>`. Another decision ' +
      'is design authority, not evidence about the current tree.',
  };
}

export interface DecisionCitedRuleAdvisory {
  code: 'cited_rule_without_measurement';
  citations: string[];
  message: string;
}

// The sibling of the path advisory above, for the case it structurally cannot
// see. `decisionMeasurementAdvisory` keys on SOURCE-LIKE PATHS, so a ruling that
// asserts current behaviour while citing only `<slug>#D-NNN` for it names no
// path and passes in silence — which is precisely the shape the repo's own rule
// warns about: a decision cited from another decision is authority for DESIGN,
// not evidence about current code. Left unchecked it compounds, because the next
// author cites THIS decision in turn and the chain never touches the tree.
//
// Advisory, never a refusal, and for the same reason as its sibling: a citation
// can legitimately carry a design ruling that asserts nothing about the tree.
// The cheap discriminations are made in `citedDecisionAuthorities` (an authority
// word is required; an overruling citation is excluded), and a body that DID
// measure is exempt outright — warning an author who measured teaches "this
// warning is noise", and then it protects nothing when it matters.
export function decisionCitedRuleAdvisory(body: string): DecisionCitedRuleAdvisory | null {
  if (hasConcreteDecisionMeasurement(body)) return null;
  const citations = citedDecisionAuthorities(body);
  if (citations.length === 0) return null;
  return {
    code: 'cited_rule_without_measurement',
    citations,
    message:
      'This decision rests on another decision as authority and carries no `Measured:` line. A cited decision is ' +
      'design authority, not evidence about the current tree — if this ruling asserts how the code behaves now, ' +
      'open the code and amend it with `Measured: <file:line or command + result>`.',
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// The pure id-allocation / body-splice helpers live in `./decision-body` so a
// lib-tier caller (rubrics.ts) can reuse them without importing THIS tool
// module — which reads `VALID_PLAN_SLUG` from `./source` at module scope and
// therefore collapses under every plans test that mocks `./source` with a bare
// factory. Re-exported here so existing importers keep working.
export { allocateNextDecisionId, appendDecisionToBody, normalizeAffects } from './decision-body';

/**
 * Retry-safety for a NON-idempotent append (EI-19383795443003151): an MCP
 * write can time out client-side with no response, leaving the write's
 * server-side outcome genuinely unknown. A blind retry of `plans:add-decision`
 * — which only ever appends, never upserts — then risks minting a SECOND
 * decision with identical title+body, and a duplicated governing decision is
 * exactly the kind of thing other lanes are told to trust over paraphrase.
 *
 * This checks the cheapest safe signal: is the plan's MOST RECENTLY allocated
 * decision (by D-NNN, which is monotonic and only ever grows) already this
 * exact { title, body }? If so, the call is a retry of a write that already
 * landed — return the existing id instead of appending a duplicate.
 *
 * Deliberately narrow so it can never suppress a legitimate decision:
 *   - only ever compares against the LAST decision in the file, never the
 *     whole history, so a genuinely repeated title+body recorded long ago
 *     (a different decision that happens to read the same) is untouched;
 *   - requires an EXACT match on both title and (normalized) body — a
 *     retry always sends byte-identical args, so this never has to guess;
 *   - requires the same normalized `affects` set, because changing cross-plan
 *     execution authority is a semantic change even when prose is identical.
 */
export function findRetryDuplicateOfLastDecision(
  decisions: PlanDecision[],
  title: string,
  body: string,
  affects: string[] = [],
): PlanDecision | null {
  if (decisions.length === 0) return null;
  let last: PlanDecision | null = null;
  let max = -1;
  for (const d of decisions) {
    const m = /^D-(\d+)$/.exec(d.id);
    const n = m ? parseInt(m[1] ?? '0', 10) : -1;
    if (n > max) {
      max = n;
      last = d;
    }
  }
  if (!last) return null;
  if (last.title.trim() !== title.trim()) return null;
  const sorted = (values: readonly string[]) => [...new Set(values)].sort();
  if (JSON.stringify(sorted(last.affects ?? [])) !== JSON.stringify(sorted(affects))) return null;
  const { body: safeBody } = normalizeDecisionBodyHeadings(body.trim());
  // `last.body` (as parsed) also carries the `Date: …` line and any trailing
  // `Related: …` refs line the append wrote alongside it — compare by
  // containment rather than equality so those don't defeat the match.
  return last.body.includes(safeBody.trim()) ? last : null;
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type AddDecisionValue =
  | { ok: true; decisionId: string; slug: string; deduped?: boolean }
  | { ok: false; code: 'not_found' | 'legacy_plan'; reason?: LegacyReason }
  // WI-10004529: the live body is missing decisions its own latest revision recorded.
  | { ok: false; code: 'stale_base_decisions_lost'; reason: string };

type WritableSlugScope = ReturnType<typeof requireUnambiguousSlugScope>;
type WritableSlugScopeFailure = Exclude<WritableSlugScope, { status: 'resolved' }>;

/** Keep exact-slug recovery failures self-describing inside the bulk result. */
function decisionScopeFailure(slug: string, decision: WritableSlugScopeFailure): BulkItemResult {
  if (decision.status === 'missing') {
    return {
      ok: false,
      slug,
      error: 'plan_not_found_in_workspace',
      missing: decision.missing,
      ...(Object.keys(decision.found).length > 0 ? { foundIn: decision.found } : {}),
      workspaceId: decision.workspaceId,
    };
  }
  if (decision.status === 'split') {
    return {
      ok: false,
      slug,
      error: 'harness_split_across_plans',
      mapping: decision.mapping,
    };
  }
  return {
    ok: false,
    slug,
    error: 'plan_slug_ambiguous_across_harnesses',
    candidates: decision.candidates,
  };
}

/** Resolve the concrete harness for one plan decision, recovering it from the
 * exact slug only when the caller has no explicit/session harness scope. */
async function decisionContext(
  it: NewDecision,
  ctx: UnifiedToolContext,
): Promise<{ ok: true; ctx: UnifiedToolContext & { harnessSlug: string } } | { ok: false; result: BulkItemResult }> {
  const scope = resolveHarnessScope(it.harness, ctx);
  if (scope.kind !== 'none') {
    return { ok: true, ctx: harnessScopedCtx(it.harness, ctx) };
  }

  const recovered = await recoverHarnessFromSlugs(ctx, [it.slug]);
  const decision = requireUnambiguousSlugScope(
    recovered,
    ((ctx as { workspaceId?: string }).workspaceId ?? '').trim(),
  );
  if (decision.status !== 'resolved') {
    return { ok: false, result: decisionScopeFailure(it.slug, decision) };
  }

  (ctx as { metadata?: (data: Record<string, unknown>) => void }).metadata?.({
    harnessAutoResolved: decision.bySlug,
  });
  return { ok: true, ctx: { ...ctx, harnessSlug: decision.harnessSlug } };
}

/** Append ONE decision, returning the self-describing bulk result. PRESERVES the
 *  in-lock allocate → append → bump, the revision capture, the P-070 usage ledger,
 *  the plan-event emit, AND the cross-plan `affects` propagation. The new decisionId
 *  rides the result; not_found / legacy_plan / busy map to this item's failure.
 *  Busy results preserve the safe owner/expiry fields plus the optional point-in-time
 *  PostgreSQL holder snapshot. */
async function addDecisionOne(rawIt: NewDecision, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  // EI-21915372335188454: a client-side tool-call serializer that mis-closes a
  // `<parameter name="body">` block (e.g. `</body>` instead of `</parameter>`)
  // has been observed leaking the literal tool-call XML for every argument AFTER
  // the mismatch into this `body` string — silently dropping `refs` and, worse,
  // planting live-looking `<invoke>`/`<parameter>` markup in a durable governance
  // record a later agent could misread as its own tool-call transcript (the exact
  // risk EI-9267 already defends against for work-item text and facts:assert).
  // `plans:add-decision` had no such guard. Neutralize (cosmetic full-width `＜`
  // swap, non-destructive, idempotent) rather than refuse — same choice
  // facts:assert makes: the decision was still substantively authored and must
  // not be lost outright over a malformed closing tag.
  const it: NewDecision = {
    ...rawIt,
    title: neutralizeToolCallTags(rawIt.title),
    body: neutralizeToolCallTags(rawIt.body),
  };
  // frozen-candidate-carry-and-launch-fail-closed P-002: plan decisions are
  // durable execution authority. Do not let a positive moving-tip candidate
  // instruction reach the plan lock, revision, event, or propagation paths
  // while the live queue remains frozen.
  const frozenCarryVerdict = evaluateFrozenLineageCarryText({
    surface: 'plan-decision',
    text: `${it.title}\n${it.body}`,
    target: resolveHomeGateVerdictTarget(),
  });
  if (!frozenCarryVerdict.allowed) {
    const refusal = frozenLineageCarryViolationPayload(frozenCarryVerdict);
    if (!refusal) throw new Error('frozen lineage refusal payload missing for a refused plan decision');
    return {
      ...refusal,
      slug: it.slug,
    };
  }
  // WI-42142 — decision provenance, resolved BEFORE the plan lock (the helper's
  // header carries the full rationale and the measurement behind enforced-vs-advisory).
  const { fields: provenance, anchors } = await decisionProvenance(`${it.title}\n${it.body}`, ctx);
  const measurementAdvisory = decisionMeasurementAdvisory(it.body);
  const citedRuleAdvisory = decisionCitedRuleAdvisory(it.body);
  if (anchors.length > 0) {
    return {
      ok: false,
      slug: it.slug,
      error: 'falsified_owner_anchor',
      message: FALSIFIED_OWNER_ANCHOR_NOTE,
      anchors,
    };
  }

  const resolved = await decisionContext(it, ctx);
  if (!resolved.ok) return resolved.result;
  const sctx = resolved.ctx;
  const harnessSlug = resolveCtxHarnessSlug(sctx);
  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    it.rationale,
    harnessSlug ? { harnessSlug } : {},
  );
  const affects = normalizeAffects(it.affects, it.slug);
  const result = await withPlanLock<AddDecisionValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:add-decision: ${it.title.slice(0, 60)}`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
      // WI-10004529: read the revision-spine head under the lock so a stale base is refused.
      loadLatestRevision: true,
    },
    async (current, meta): Promise<{ newBody: string | null; value: AddDecisionValue }> => {
      if (current === null) {
        return { newBody: null, value: { ok: false, code: 'not_found' } };
      }
      const parsed = parsePlan(current, { filePath: it.slug + '.md' });
      if (parsed.isLegacy) {
        return {
          newBody: null,
          value: { ok: false, code: 'legacy_plan', reason: parsed.legacyReason ?? undefined },
        };
      }
      // WI-10004529: an append-only write must not build on a base missing governing decisions.
      // A live row that silently reverted below its own revision head (stale replay, EI-117/
      // EI-207 — records no revision) would otherwise get a DUPLICATE id and overwrite the real
      // decisions with ok:true. Refuse loudly, naming what was lost and where to restore it from.
      if (meta?.latestRevision) {
        const missing = decisionIdsMissingFromLiveBody(meta.latestRevision.body, current);
        if (missing.length > 0) {
          return {
            newBody: null,
            value: {
              ok: false,
              code: 'stale_base_decisions_lost',
              reason:
                `the live plan body is missing decision(s) ${missing.join(', ')} that its latest ` +
                `revision (seq ${meta.latestRevision.seq}) recorded — the row diverged below its own ` +
                `revision head (stale-replay class, EI-117/EI-207). Refusing to append on a stale base: ` +
                `it would reuse an id and overwrite them. Restore the body from revision seq ` +
                `${meta.latestRevision.seq} (plans:revision-diff shows the loss), then retry.`,
            },
          };
        }
      }
      // EI-19383795443003151: a blind retry of a timed-out-but-actually-landed
      // write must not duplicate. No-op (no write, no revision, no plan-event)
      // and hand back the id that already carries this exact decision.
      const retryDup = findRetryDuplicateOfLastDecision(parsed.decisions, it.title, it.body, affects);
      if (retryDup) {
        return { newBody: null, value: { ok: true, decisionId: retryDup.id, slug: it.slug, deduped: true } };
      }
      const decisionId = allocateNextDecisionId(current);
      const appended = appendDecisionToBody(
        current,
        decisionId,
        it.title,
        it.body,
        todayISO(),
        it.refs ?? [],
        affects,
      );
      const final = bumpUpdatedDate(appended);
      return {
        newBody: final,
        value: { ok: true, decisionId, slug: it.slug },
      };
    },
  );

  if (result.kind === 'busy') {
    return {
      ok: false,
      slug: it.slug,
      error: 'busy',
      busy: result.busy.map((b) => ({
        path: b.path,
        owner: b.owner,
        owner_label: b.owner_label,
        intent: b.intent,
        expires_ts: b.expires_ts,
        holder_snapshot: b.holder_snapshot,
      })),
    };
  }

  if (!result.value.ok) {
    return {
      ok: false,
      slug: it.slug,
      error: result.value.code,
      ...(result.value.reason ? { reason: result.value.reason } : {}),
    };
  }

  // `result.value` is narrowed to the ok-variant by the guard above.
  const decisionId = result.value.decisionId;

  // A retry-duplicate no-op: nothing was written, so nothing to ledger, event,
  // or propagate — just hand back the id the earlier (already-landed) call
  // allocated.
  if (result.value.deduped) {
    return {
      ok: true,
      decisionId,
      ref: planDecisionRef(it.slug, decisionId),
      slug: it.slug,
      deduped: true,
      filePath: result.filePath,
      ...(measurementAdvisory ? { measurementAdvisory } : {}),
      ...(citedRuleAdvisory ? { citedRuleAdvisory } : {}),
      ...provenance,
    };
  }

  // P-070 usage ledger (best-effort): a decision is contributor activity on a
  // managed harness. Operator-level plans (harness:'all') have no harness slug
  // and the ledger is per-harness, so skip those.
  if (harnessSlug) void emitDecisionAdded(harnessSlug, decisionId);
  await emitPlanEventForCaller(ctx, {
    planSlug: it.slug,
    event: 'decision_added',
    detail: decisionId,
    after: it.title,
  });

  // Cross-plan propagation (agent-coordination-architecture-v2 §6.4 #7).
  // For each OTHER plan this decision affects: emit a cross-reference
  // plan_event scoped to the affected plan (so its history/sidebar
  // surfaces the incoming decision) and fire a notify to that plan's
  // watchers. The decision itself is NOT duplicated — it lives only in
  // `it.slug`; affected plans merely reference it. Unknown slugs are
  // reported back rather than silently skipped.
  const propagatedTo: string[] = [];
  const unknownAffects: string[] = [];
  for (const affectedSlug of affects) {
    // Reuse the exact (workspace, Hive-home) scope that withPlanLock resolved
    // for the source write. Calling readPlanBySlug without opts silently falls
    // back to the operator-home plan partition, so a valid cross-plan slug in
    // another harness is misreported as unknown_affects.
    const exists = await readPlanBySlug(affectedSlug, result.scope);
    if (!exists) {
      unknownAffects.push(affectedSlug);
      continue;
    }
    await emitPlanEventForCaller(ctx, {
      planSlug: affectedSlug,
      event: 'decision_added',
      detail: `${decisionId} (cross-ref from ${it.slug})`,
      after: it.title,
    });
    propagatedTo.push(affectedSlug);
  }

  // P-031 (merged into P-030 by D-005): a Decision is a SCOPE write — it can re-scope the
  // plan so a complete BAR no longer holds. Re-read the live BAR readiness in this same call
  // and restamp the plan's Now (which orient folds). A deduped retry returned above, so this
  // runs once per real decision. Never throws into the decision write: building the input
  // is guarded too (a lock result without a resolved scope skips the re-evaluation).
  let barReadiness: BarReadinessResult | undefined;
  const lockScope = result.scope as typeof result.scope | undefined;
  if (lockScope) {
    let actor = 'system:scope-write-cascade';
    try {
      actor = resolveAgentIdentity(ctx).ownerId;
    } catch {
      /* unattributable caller: the Now stamp falls back to the system actor */
    }
    barReadiness = await reevaluateBarReadinessOnScopeWrite(
      {
        workspaceId: lockScope.workspaceId,
        harnessSlug: lockScope.harnessSlug,
        planSlug: it.slug,
        cause: 'decision-added',
      },
      defaultBarReadinessDeps(ctx, actor),
    );
  }

  return {
    ...result.value,
    // The citable form. `decisionId` alone is allocated per-plan and so is not a
    // reference — cite `ref`. See planDecisionRef for the measured ambiguity.
    ref: planDecisionRef(it.slug, decisionId),
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    ...(propagatedTo.length > 0 ? { propagated_to: propagatedTo } : {}),
    ...(unknownAffects.length > 0 ? { unknown_affects: unknownAffects } : {}),
    // Only the blocked / cleared / unmeasured cases: a plan with no BAR contract keeps the
    // exact prior result shape.
    ...(barReadiness && (barReadiness.state === 'blocked' || barReadiness.nowStamped || barReadiness.error)
      ? { barReadiness }
      : {}),
    ...(measurementAdvisory ? { measurementAdvisory } : {}),
    ...(citedRuleAdvisory ? { citedRuleAdvisory } : {}),
    // WI-42142: advisory provenance fields — absent on the clean common case, so a
    // decision with no directive shape and no turn ref keeps its exact prior shape.
    ...provenance,
  };
}

export default defineTool({
  name: 'plans:add-decision',
  description:
    "Append one or many decisions to a plan. Allocates the next D-NNN inside a lock and bumps frontmatter `updated:`; concurrent calls stay collision-free. Single: `{ slug, title, body }`; bulk: `items:[{ slug, title, body, refs?, affects? }]`. `itemRefs` aliases `refs` (refs wins). Tree-fact decisions require `Measured: <file:line or command + result>`; without it, source-like paths return `measurementAdvisory` and a ruling resting on another decision as authority returns `citedRuleAdvisory`. CITE `ref` (`<slug>#D-NNN`) anywhere the decision is quoted onward — a bare `D-NNN` is allocated per-plan, so it is not a reference: `D-001` names 904 different rulings in this harness. Exact `{ title, body }` retries dedupe against the plan's most recent decision instead of appending.",
  guidance: {
    returns:
      '`{ ok, results:[{ ok, slug, decisionId, ref, deduped?, propagated_to?, measurementAdvisory?, citedRuleAdvisory?, absenceLint? | error }], counts }`. Correlate each result by `decisionId`; one failure never fails the rest. Three advisories, all non-blocking: `measurementAdvisory` (names source-like paths with no `Measured:` line), `citedRuleAdvisory` (the body leans on a cited decision as authority with no `Measured:` line — a cited decision is design authority, not tree evidence; an overruling citation such as "supersedes D-003" is exempt), and `absenceLint` (an uncovered absence premise).',
    when: "A decision-shaped output: trade-off resolved, scope ratified, or a choice made. Record it so fresh agents do not relitigate. For current-tree claims, open the tree and add `Measured: <file:line or command + result>`. Design authority is not tree evidence. Use items:[…] for bulk.",
    notWhen:
      'Adding work units — use plans:add-item. Flipping status — plans:set-status. Updating overall state — plans:set-now.',
    chaining:
      'plans:add-decision → optionally plans:set-now referencing the new D-NNN in **State:**.',
    seeAlso: [
      'plans:set-decision-body (edit an existing decision\'s body)',
      'plans:set-now (reference the new D-NNN in the Now)',
    ],
  },
  // Envelope described by `_bulk`; per-item stays OPEN (`decisionId`/`ref` plus the
  // three conditional advisories on success, `error` on failure). Required because
  // `guidance.returns` above is authored prose: a tool that promises a shape must
  // register it, so the response comes from a schema instead of prose becoming a
  // second, unverifiable type system (guidance-output-schema-live-guard.test.ts).
  result: bulkEnvelopeSchema(),
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    // `itemRefs` is a declared alias of `refs` (EI-18735663944089262):
    // plans:get echoes a decision's refs back under that exact name, so
    // accept it here too instead of rejecting the read-shape field name.
    // `refs` wins when both are given on the same object.
    const batchRefs = args.refs ?? args.itemRefs;
    const list: NewDecision[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          title: it.title,
          body: it.body,
          refs: it.refs ?? it.itemRefs ?? batchRefs,
          affects: it.affects ?? args.affects,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : [
          {
            slug: args.slug as string,
            title: args.title as string,
            body: args.body as string,
            refs: batchRefs,
            affects: args.affects,
            harness: args.harness,
            rationale: args.rationale,
          },
        ];
    const env = await runBulk(list, (it) => addDecisionOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug }),
    });
    return bulkContent(env);
  },
});
