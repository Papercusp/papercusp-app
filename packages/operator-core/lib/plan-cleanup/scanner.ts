/**
 * plan-cleanup/scanner — the DETERMINISTIC half of plan clean-up runs
 * (cleanup-report-flows-2026-08-24 P-003).
 *
 * A pure pass over already-gathered rows (harness_plans items × linked
 * work_items × coverage edges × plan_item_claims) emitting TYPED candidate
 * findings with evidence refs. No I/O in this module — `gather.ts` performs the
 * SQL reads and hands plain rows in, which is what makes every finding kind
 * fixture-testable without Postgres.
 *
 * The scanner is a CANDIDATE emitter, not an actor: the resolver re-verifies
 * each candidate at current state before acting (Design §resolver), and only
 * the provable class ever auto-applies. Determinism contract: same inputs +
 * same `nowMs` ⇒ byte-identical findings in a stable order.
 *
 * Relationship to the event-driven reflection path (plan-items/reflect-rules.ts):
 * that path mirrors work-item lifecycle onto plan items AS EVENTS FIRE; this
 * scanner is the periodic sweep that catches everything the event path missed —
 * a flip that raced a crash, a blocker cleared while nothing fired, a claim
 * whose holder died silently. The finding semantics deliberately mirror the
 * reflection guards (open-coverage / finished-coverage, EI-19972048649686949 /
 * EI-20129670928216719) so the two paths can never disagree about what "done"
 * coverage means.
 *
 * Finding kinds (Requirements: the first four are mechanically PROVABLE and may
 * auto-apply; the last two are judgment calls, recommend-only forever):
 *   flip-to-done      open item whose linked work-item is terminal-done WITH a
 *                     completion record, and no other open coverage
 *   cleared-blocker   blocked item whose every blockedBy ref is verifiably
 *                     terminal
 *   finish-plan       op_status='started' plan whose items are ALL terminal
 *   orphaned-claim    plan-item claim lease lapsed past grace with a dead
 *                     holder (read-only mirror of stale-claims.ts's reaper
 *                     predicate — same alias-aware liveness, computed in gather)
 *   stale-now         ## Now that references ONLY terminal items while open
 *                     work exists (recommend a rewrite)
 *   archive-candidate all-terminal, not-started, long-untouched, claim-free
 *                     plan (recommend archiving)
 *
 * Plans with LIVE agents (a claim whose holder is alive) receive NO auto-apply:
 * provable findings on such plans are emitted with autoApply:false /
 * autoApplyBlockedBy:'live-agents' (Requirements).
 */

/** Work-item states that mean "successfully finished" (reflect-rules maps these
 *  to plan-item `done`). Subset of TERMINAL_WORK_ITEM_STATES (convert.ts). */
export const DONE_WORK_ITEM_STATES: ReadonlySet<string> = new Set(['passed', 'resolved', 'done']);

/** Every terminal work-item state, finished or discarded — must stay identical
 *  to plan-items/convert.ts TERMINAL_WORK_ITEM_STATES (imported there from the
 *  conversion plane; duplicated here as a const so this module stays pure and
 *  dependency-free — scanner.test.ts pins the two sets equal). */
export const TERMINAL_WORK_ITEM_STATES_SCAN: ReadonlySet<string> = new Set([
  'passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped',
]);

/** Plan-item stored statuses that count as terminal. */
export const TERMINAL_PLAN_ITEM_STATUSES: ReadonlySet<string> = new Set(['done', 'dropped']);

/** Plan-item stored statuses the scanner may propose flips FOR. `needs-human`
 *  is deliberately absent: an owner-gated item is never auto-anything. */
const FLIPPABLE_PLAN_ITEM_STATUSES: ReadonlySet<string> = new Set(['todo', 'wip', 'blocked']);

export type CleanupFindingKind =
  | 'enlist-plan'
  | 'flip-to-done'
  | 'cleared-blocker'
  | 'finish-plan'
  | 'orphaned-claim'
  | 'stale-now'
  | 'archive-candidate';

/** Stable ordering for deterministic output (and for grouped report rendering). */
export const CLEANUP_FINDING_KINDS: readonly CleanupFindingKind[] = [
  'enlist-plan',
  'flip-to-done',
  'cleared-blocker',
  'finish-plan',
  'orphaned-claim',
  'stale-now',
  'archive-candidate',
];

export type CleanupConfidence = 'provable' | 'recommended';

export interface CleanupEvidenceRef {
  kind: 'work-item' | 'plan-item' | 'claim' | 'plan';
  /** The id the note is about (WI-NNN / P-NNN / claim owner / plan slug). */
  ref: string;
  note: string;
}

export interface CleanupFinding {
  /** Deterministic identity — stable across runs over the same state, so the
   *  run store can dedupe / target apply calls: `<kind>:<harness>/<plan>[#item]`. */
  findingId: string;
  kind: CleanupFindingKind;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** P-NNN for item-scoped findings; null for plan-scoped ones. */
  itemId: string | null;
  /** What would change, human-readable. */
  target: string;
  from: string;
  to: string;
  confidence: CleanupConfidence;
  /** True only for provable findings on plans with no live agents. The
   *  resolver re-verifies at current state before acting either way. */
  autoApply: boolean;
  autoApplyBlockedBy: 'live-agents' | 'judgment-call' | null;
  evidence: CleanupEvidenceRef[];
  /** Canonical write payload for findings whose action needs state outside the
   *  plan row. It is deliberately scan-time data: the dispatcher only receives
   *  a freshly re-verified finding, so the worklist value and CAS version are
   *  current at the instant the action starts. */
  action?: {
    kind: 'enlist-plan';
    goalId: string;
    planRef: string;
    worklist: string[];
    expectedVersion: number;
  };
}

// ── inputs (plain rows — populated by gather.ts, or by test fixtures) ────────

export interface CleanupPlanItemInput {
  /** P-NNN */
  id: string;
  text: string;
  /** stored status: todo | wip | blocked | needs-human | done | dropped */
  status: string;
  /** refs this item is blocked by (P-NNN of the same plan; occasionally WI/EI ids). */
  blockedBy: string[];
}

export interface CleanupPlanInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  title: string | null;
  /** Authored lifecycle status. Only ready/active plans may be enlisted; a
   *  draft must pass plans:audit before activation and is never inferred here. */
  status?: string | null;
  /** harness_plans.op_status: 'started' | 'paused' | 'done' | null */
  opStatus: string | null;
  /** Owner-authored dispatch priority (lower = sooner, null = last). */
  opPriority?: number | null;
  createdAtMs?: number | null;
  archived: boolean;
  updatedAtMs: number | null;
  nowState: string | null;
  nowNext: string | null;
  items: CleanupPlanItemInput[];
}

export interface LinkedWorkItemInput {
  planSlug: string;
  /** P-NNN the work-item covers. */
  itemId: string;
  workItemId: string;
  /** Resolved work-item state (passed/resolved/done/deprecated/closed/dropped/
   *  open/wip/…), or null when the base-table row could not be resolved (a
   *  cross-workspace feature ref) — an unresolved row can never be provable
   *  done-evidence, but its `terminal` flag still counts for coverage. */
  state: string | null;
  /** Family-aware terminal flag from the coverage plane (plan-item-coverage.ts
   *  classify truth) — authoritative even when `state` is unresolved. */
  terminal: boolean;
  /** A completion record exists (work_items.completion_ref) — the "with
   *  evidence" half of the provable flip-to-done rule. */
  hasCompletion: boolean;
  /** Which link plane produced the row: a coord_links rel ('fixes' | 'relates'
   *  | 'duplicates' | 'implements') or 'plan_item_stamp' (STAMP_ONLY_REL). */
  link: string;
}

export interface PlanItemClaimInput {
  planSlug: string;
  itemId: string;
  owner: string;
  expiresAtMs: number;
  /** Alias-aware holder liveness, computed in gather with the SAME rule as
   *  stale-claims.ts (coord_presence heartbeat ∪ running spawned_agents
   *  aliases) so scanner and reaper can never disagree about who is alive. */
  holderAlive: boolean;
}

export interface CleanupScanInputs {
  plans: CleanupPlanInput[];
  linkedWorkItems: LinkedWorkItemInput[];
  claims: PlanItemClaimInput[];
  /** The active bundled Work-on-everything instance selected by gather. Null
   *  means this workspace has no eligible standing goal, so enlistment is a
   *  no-op while the other cleanup rules still run. */
  goalWorklist?: {
    goalId: string;
    refs: string[];
    version: number;
  } | null;
}

export interface CleanupScanOptions {
  /** The scan instant — passed in (never Date.now() inside) for determinism. */
  nowMs: number;
  /** How long a claim lease must be lapsed (holder dead) before an
   *  orphaned-claim finding fires. Default mirrors STALE_PLAN_CLAIM_GRACE_MS. */
  claimGraceMs?: number;
  /** How long an all-terminal plan must sit untouched before an
   *  archive-candidate finding fires. */
  archiveStaleMs?: number;
  /** Maximum new worklist refs emitted by this scan. The deterministic runner
   *  passes its remaining RUN budget here so rescans/retries cannot exceed it. */
  enlistPlanLimit?: number;
}

export const DEFAULT_CLAIM_GRACE_MS = 10 * 60 * 1000;
export const DEFAULT_ARCHIVE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ENLIST_PLAN_LIMIT = 20;

const PLAN_ITEM_REF = /\bP-\d{3,}\b/g;

interface PlanIndex {
  itemById: Map<string, CleanupPlanItemInput>;
  linksByItem: Map<string, LinkedWorkItemInput[]>;
  claims: PlanItemClaimInput[];
  /** Any claim on the plan whose holder is alive ⇒ agents are live on it. */
  liveAgentOwners: string[];
}

function indexPlan(plan: CleanupPlanInput, inputs: CleanupScanInputs): PlanIndex {
  const itemById = new Map(plan.items.map((i) => [i.id, i]));
  const linksByItem = new Map<string, LinkedWorkItemInput[]>();
  for (const l of inputs.linkedWorkItems) {
    if (l.planSlug !== plan.planSlug) continue;
    const arr = linksByItem.get(l.itemId) ?? [];
    arr.push(l);
    linksByItem.set(l.itemId, arr);
  }
  const claims = inputs.claims.filter((c) => c.planSlug === plan.planSlug);
  const liveAgentOwners = [...new Set(claims.filter((c) => c.holderAlive).map((c) => c.owner))].sort();
  return { itemById, linksByItem, claims, liveAgentOwners };
}

function mkFinding(
  plan: CleanupPlanInput,
  kind: CleanupFindingKind,
  itemId: string | null,
  fields: Pick<CleanupFinding, 'target' | 'from' | 'to' | 'confidence' | 'evidence'>,
  liveAgentOwners: string[],
): CleanupFinding {
  const provable = fields.confidence === 'provable';
  const liveBlocked = provable && liveAgentOwners.length > 0;
  const evidence = [...fields.evidence];
  if (liveBlocked) {
    evidence.push({
      kind: 'plan',
      ref: plan.planSlug,
      note: `live agent(s) on plan (${liveAgentOwners.join(', ')}) — auto-apply withheld, recommend-only`,
    });
  }
  return {
    findingId: `${kind}:${plan.harnessSlug}/${plan.planSlug}${itemId ? `#${itemId}` : ''}`,
    kind,
    workspaceId: plan.workspaceId,
    harnessSlug: plan.harnessSlug,
    planSlug: plan.planSlug,
    itemId,
    target: fields.target,
    from: fields.from,
    to: fields.to,
    confidence: fields.confidence,
    autoApply: provable && !liveBlocked,
    autoApplyBlockedBy: !provable ? 'judgment-call' : liveBlocked ? 'live-agents' : null,
    evidence: fields.evidence.length === evidence.length ? fields.evidence : evidence,
  };
}

/**
 * The pure deterministic pass. Same inputs + same options ⇒ identical output,
 * sorted (planSlug, kind order, itemId) for stable rendering and diffing.
 */
export function scanForCleanupFindings(
  inputs: CleanupScanInputs,
  opts: CleanupScanOptions,
): CleanupFinding[] {
  const claimGraceMs = opts.claimGraceMs ?? DEFAULT_CLAIM_GRACE_MS;
  const archiveStaleMs = opts.archiveStaleMs ?? DEFAULT_ARCHIVE_STALE_MS;
  const findings: CleanupFinding[] = [];
  const enlistRankByFindingId = new Map<string, number>();

  // ── enlist-plan ────────────────────────────────────────────────────────
  // Rank globally before applying the bound. This is the queue order the
  // deterministic runner consumes, so a low-priority plan can never displace
  // a higher-priority candidate merely because its slug sorts first.
  const goalWorklist = inputs.goalWorklist;
  if (goalWorklist) {
    const existing = new Set(goalWorklist.refs);
    const eligible = inputs.plans
      .filter((plan) => {
        if (plan.archived || (plan.status !== 'ready' && plan.status !== 'active')) return false;
        const qualified = `plan:${plan.harnessSlug}/${plan.planSlug}`;
        const unqualified = `plan:${plan.planSlug}`;
        return !existing.has(qualified) && !existing.has(unqualified);
      })
      .sort((a, b) => {
        const ap = a.opPriority ?? Number.POSITIVE_INFINITY;
        const bp = b.opPriority ?? Number.POSITIVE_INFINITY;
        return ap - bp ||
          (a.createdAtMs ?? Number.POSITIVE_INFINITY) - (b.createdAtMs ?? Number.POSITIVE_INFINITY) ||
          a.planSlug.localeCompare(b.planSlug) ||
          a.harnessSlug.localeCompare(b.harnessSlug);
      })
      .slice(0, Math.max(0, opts.enlistPlanLimit ?? DEFAULT_ENLIST_PLAN_LIMIT));

    for (const [rank, plan] of eligible.entries()) {
      const idx = indexPlan(plan, inputs);
      const planRef = `plan:${plan.harnessSlug}/${plan.planSlug}`;
      const finding: CleanupFinding = {
        ...mkFinding(plan, 'enlist-plan', null, {
          target: `${goalWorklist.goalId}.worklist`,
          from: `${goalWorklist.refs.length} plan ref(s)`,
          to: `append ${planRef}`,
          confidence: 'provable',
          evidence: [{
            kind: 'plan',
            ref: plan.planSlug,
            note: `status=${plan.status}; op_priority=${plan.opPriority ?? 'unset'}; absent from goal worklist v${goalWorklist.version}`,
          }],
        }, idx.liveAgentOwners),
        action: {
          kind: 'enlist-plan',
          goalId: goalWorklist.goalId,
          planRef,
          worklist: goalWorklist.refs,
          expectedVersion: goalWorklist.version,
        },
      };
      enlistRankByFindingId.set(finding.findingId, rank);
      findings.push(finding);
    }
  }

  for (const plan of [...inputs.plans].sort((a, b) => a.planSlug.localeCompare(b.planSlug))) {
    if (plan.archived) continue;
    const idx = indexPlan(plan, inputs);
    const flippedToDone = new Set<string>();

    // ── flip-to-done ──────────────────────────────────────────────────────
    for (const item of plan.items) {
      if (!FLIPPABLE_PLAN_ITEM_STATUSES.has(item.status)) continue;
      const links = idx.linksByItem.get(item.id) ?? [];
      const doneLinks = links.filter((l) => l.state !== null && DONE_WORK_ITEM_STATES.has(l.state));
      // Open-coverage uses the family-aware `terminal` flag so an UNRESOLVED
      // non-terminal link still blocks the flip (the conservative direction).
      const openLinks = links.filter((l) => !l.terminal);
      if (doneLinks.length === 0) continue;
      // Open-coverage guard (EI-19972048649686949): another non-terminal
      // work-item still covering the item means the lane is NOT finished.
      if (openLinks.length > 0) continue;
      const withEvidence = doneLinks.filter((l) => l.hasCompletion);
      // "Terminal WITH evidence" is what makes the flip provable (Requirements).
      // A done-state record with no completion is a judgment call.
      const provable = withEvidence.length > 0;
      const cited = provable ? withEvidence : doneLinks;
      findings.push(
        mkFinding(plan, 'flip-to-done', item.id, {
          target: `${plan.planSlug}#${item.id}`,
          from: item.status,
          to: 'done',
          confidence: provable ? 'provable' : 'recommended',
          evidence: [
            ...cited.map((l): CleanupEvidenceRef => ({
              kind: 'work-item',
              ref: l.workItemId,
              note: `linked via ${l.link}; state=${l.state}${l.hasCompletion ? '; completion recorded' : '; NO completion record'}`,
            })),
            { kind: 'plan-item', ref: item.id, note: `stored status=${item.status}; no other open coverage` },
          ],
        }, idx.liveAgentOwners),
      );
      flippedToDone.add(item.id);
    }

    // ── cleared-blocker ───────────────────────────────────────────────────
    for (const item of plan.items) {
      if (item.status !== 'blocked' || item.blockedBy.length === 0) continue;
      if (flippedToDone.has(item.id)) continue; // flip-to-done supersedes
      const evidence: CleanupEvidenceRef[] = [];
      let allCleared = true;
      for (const ref of item.blockedBy) {
        const blocker = idx.itemById.get(ref);
        if (!blocker) {
          // Unresolvable ref (cross-plan / work-item id / prose) — the
          // deterministic pass cannot prove it cleared; leave for the resolver.
          allCleared = false;
          break;
        }
        if (!TERMINAL_PLAN_ITEM_STATUSES.has(blocker.status)) {
          allCleared = false;
          break;
        }
        evidence.push({ kind: 'plan-item', ref, note: `blocker status=${blocker.status}` });
      }
      if (!allCleared) continue;
      findings.push(
        mkFinding(plan, 'cleared-blocker', item.id, {
          target: `${plan.planSlug}#${item.id}`,
          from: 'blocked',
          to: 'todo',
          confidence: 'provable',
          evidence,
        }, idx.liveAgentOwners),
      );
    }

    // ── finish-plan ───────────────────────────────────────────────────────
    const terminalItems = plan.items.filter((i) => TERMINAL_PLAN_ITEM_STATUSES.has(i.status));
    const allTerminal = plan.items.length > 0 && terminalItems.length === plan.items.length;
    if (plan.opStatus === 'started' && allTerminal) {
      findings.push(
        mkFinding(plan, 'finish-plan', null, {
          target: plan.planSlug,
          from: "op_status='started'",
          to: "op_status='done'",
          confidence: 'provable',
          evidence: [{
            kind: 'plan',
            ref: plan.planSlug,
            note: `all ${plan.items.length} item(s) terminal (${plan.items.filter((i) => i.status === 'done').length} done, ${plan.items.filter((i) => i.status === 'dropped').length} dropped)`,
          }],
        }, idx.liveAgentOwners),
      );
    }

    // ── orphaned-claim ────────────────────────────────────────────────────
    for (const claim of idx.claims) {
      if (claim.holderAlive) continue;
      const lapsedMs = opts.nowMs - claim.expiresAtMs;
      if (lapsedMs <= claimGraceMs) continue;
      findings.push(
        mkFinding(plan, 'orphaned-claim', claim.itemId, {
          target: `${plan.planSlug}#${claim.itemId}`,
          from: `claimed by ${claim.owner}`,
          to: 'claim released',
          confidence: 'provable',
          evidence: [{
            kind: 'claim',
            ref: claim.owner,
            note: `lease lapsed ${Math.round(lapsedMs / 60_000)}min ago; holder dead per alias-aware liveness`,
          }],
        }, idx.liveAgentOwners),
      );
    }

    // ── stale-now (recommend-only) ────────────────────────────────────────
    const hasOpenItems = plan.items.some((i) => !TERMINAL_PLAN_ITEM_STATUSES.has(i.status));
    if (hasOpenItems) {
      const nowText = `${plan.nowState ?? ''}\n${plan.nowNext ?? ''}`;
      const refs = [...new Set(nowText.match(PLAN_ITEM_REF) ?? [])];
      const resolved = refs
        .map((r) => idx.itemById.get(r))
        .filter((i): i is CleanupPlanItemInput => i !== undefined);
      if (
        refs.length > 0 &&
        resolved.length === refs.length &&
        resolved.every((i) => TERMINAL_PLAN_ITEM_STATUSES.has(i.status))
      ) {
        findings.push(
          mkFinding(plan, 'stale-now', null, {
            target: `${plan.planSlug} ## Now`,
            from: 'references only terminal items',
            to: 'rewrite to reflect open work',
            confidence: 'recommended',
            evidence: resolved.map((i): CleanupEvidenceRef => ({
              kind: 'plan-item',
              ref: i.id,
              note: `referenced by ## Now; status=${i.status}`,
            })),
          }, idx.liveAgentOwners),
        );
      }
    }

    // ── archive-candidate (recommend-only) ────────────────────────────────
    if (
      allTerminal &&
      plan.opStatus !== 'started' &&
      idx.claims.length === 0 &&
      plan.updatedAtMs !== null &&
      opts.nowMs - plan.updatedAtMs > archiveStaleMs
    ) {
      const staleDays = Math.floor((opts.nowMs - plan.updatedAtMs) / 86_400_000);
      findings.push(
        mkFinding(plan, 'archive-candidate', null, {
          target: plan.planSlug,
          from: 'active (archived=false)',
          to: 'archived',
          confidence: 'recommended',
          evidence: [{
            kind: 'plan',
            ref: plan.planSlug,
            note: `all ${plan.items.length} item(s) terminal; untouched ${staleDays}d; no claims`,
          }],
        }, idx.liveAgentOwners),
      );
    }
  }

  const kindOrder = new Map(CLEANUP_FINDING_KINDS.map((k, i) => [k, i]));
  return findings.sort(
    (a, b) => {
      const aEnlistRank = enlistRankByFindingId.get(a.findingId);
      const bEnlistRank = enlistRankByFindingId.get(b.findingId);
      if (aEnlistRank !== undefined || bEnlistRank !== undefined) {
        if (aEnlistRank !== undefined && bEnlistRank !== undefined) {
          return aEnlistRank - bEnlistRank;
        }
        return aEnlistRank !== undefined ? -1 : 1;
      }
      return a.planSlug.localeCompare(b.planSlug) ||
        (kindOrder.get(a.kind)! - kindOrder.get(b.kind)!) ||
        (a.itemId ?? '').localeCompare(b.itemId ?? '');
    },
  );
}
