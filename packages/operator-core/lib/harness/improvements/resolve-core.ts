/**
 * resolve-core.ts — the verify-and-mark-done BACK-EDGE of the self-improvement
 * loop (close-the-self-improvement-loop-2026-06-05 D-001).
 *
 * Before this existed the loop never closed: the implement routine dispatched a
 * bug to the runner, the runner fixed it, and **nothing marked it resolved** — so
 * the next cadence tick re-dispatched the same already-fixed bug, forever. This
 * module is the missing edge. The implement worker calls it (via the
 * `improvements:resolve` tool) when it finishes a dispatched item:
 *
 *   - `fixed`         — the fix is implemented AND VERIFIED (tests run + green).
 *                       Records the verification evidence as a comment and marks
 *                       the issue `resolved` → it leaves the open queue for good.
 *   - `could-not-fix` — the worker tried and failed. Releases the claim so a
 *                       later run can retry; exhausted attempts move to leader
 *                       triage instead of masquerading as owner work.
 *   - `needs-human`   — a typed route: remote rows stay on peer reconciliation,
 *                       product decisions enter peer agent review, strict
 *                       credential/device/external-service capabilities set
 *                       `payload.needsOwnerAction`, and untyped operational
 *                       failures move to leader triage.
 *
 * Deps are injectable so every branch is unit-testable without PG.
 */

import {
  getIssue,
  setIssueState,
  commentIssue,
  releaseIssue,
  mergeIssuePayload,
  type EngineerIssue,
  type IssueState,
} from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import { initializeIdeaLifecycle, updateIdeaLifecycle, type IdeaLifecyclePayload } from './lifecycle';
import { closeDispatchesForItem } from './dispatch-ledger';
import { ISSUE_TERMINAL_STATUSES } from '../../work-item-blocking';
import {
  externalBlockerCapabilityPolicy,
  updateExternalBlockerHistory,
  type ExternalBlockerCapability,
} from '../../external-blockers';
import { enterAgentReview } from './agent-review';

export type ResolveOutcome = 'fixed' | 'could-not-fix' | 'needs-human';

/** Default cap on auto-implement dispatch attempts before an item routes to leader triage. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface ResolveImprovementInput {
  id: string;
  outcome: ResolveOutcome;
  /** What happened — for `fixed`, the verification evidence (what changed + how it was verified). */
  summary: string;
  /** The test command(s) run + their result — REQUIRED for `fixed` (the "verified" in verify-and-mark-done). */
  testsRun?: string;
  /** Commit / branch the fix landed on (it still rides the release gate). */
  commit?: string;
  /** Who is resolving (the worker's identity). */
  by?: string;
  /** Attempt cap for the could-not-fix → needs-human graduation (default 3). */
  maxAttempts?: number;
  /**
   * P-004 (WI-5679): for outcome='needs-human', the TYPED human-capability blocker that makes
   * this genuinely need the OWNER (mirrors work_items:set_blocker's ExternalBlockerCapability).
   * A strict capability whose policy `requiresOwnerCapability` (credential / physical-device /
   * external-service-action) routes to payload.needsOwnerAction. Product decisions enter peer
   * agent review. An auto-clearable / live-dependency capability, or NO capability at all, is
   * treated as an OPERATIONAL block and routed to the LEADER-TRIAGE lane (status='blocked').
   * Ignored for outcomes other than 'needs-human'.
   */
  blockerCapability?: ExternalBlockerCapability;
}

export interface ResolveImprovementResult {
  ok: boolean;
  id: string;
  outcome?: ResolveOutcome;
  /** The issue's lifecycle state after the resolve. */
  state?: IssueState;
  /** Strict credential/device/external-service capability routed to the owner. */
  routedToOwnerAction?: boolean;
  /** Product-decision routed through the existing peer agent-review lifecycle. */
  routedToAgentReview?: boolean;
  /** Remote-owned row left for reconciliation on its authoring peer. */
  routedToPeerReconciliation?: boolean;
  /** P-004 (WI-5679): true when this resolve routed the item to the LEADER-TRIAGE lane
   *  (status='blocked') for an OPERATIONAL failure — out of the auto loop, NOT the owner's inbox. */
  routedToLeaderTriage?: boolean;
  error?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface ResolveDeps {
  getIssue: (id: string) => Promise<EngineerIssue | null>;
  setIssueState: (
    id: string,
    state: IssueState,
    by?: string,
    completionRef?: string,
    opts?: { skipCompletionGate?: boolean },
  ) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  releaseIssue: (id: string) => Promise<EngineerIssue | null>;
  mergeIssuePayload: (
    id: string,
    patch: Record<string, unknown>,
    opts?: { unset?: string[] },
  ) => Promise<EngineerIssue | null>;
  enterAgentReview: typeof enterAgentReview;
  /** Dispatch-ledger back-edge (consume-edges P-010 / B-04): drive the item's
   *  open improvement_dispatches rows terminal. REQUIRED (not defaulted per-call)
   *  so a unit test can never silently fall through to the PG-backed default —
   *  defaultDeps wires the real closeDispatchesForItem. */
  closeDispatches: (itemId: string, opts: { outcome: ResolveOutcome; by?: string }) => Promise<number>;
}

const defaultDeps: ResolveDeps = {
  getIssue,
  setIssueState,
  commentIssue,
  releaseIssue,
  mergeIssuePayload,
  enterAgentReview,
  closeDispatches: closeDispatchesForItem,
};

function attemptsOf(issue: EngineerIssue): number {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  return typeof p.implementAttempts === 'number' ? p.implementAttempts : 0;
}

function lifecycleOf(issue: EngineerIssue): IdeaLifecyclePayload | null {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const l = p.ideaLifecycle;
  return l && typeof l === 'object' && typeof (l as { state?: unknown }).state === 'string'
    ? (l as IdeaLifecyclePayload)
    : null;
}

/**
 * P-004 (WI-5679): is a TYPED needs-human blocker genuinely OWNER-gated (→ human queue), vs an
 * operational block a leader can clear (→ leader-triage)? Reuses the set_blocker capability policy
 * as the single source of truth: `requiresOwnerCapability` = credential / physical-device /
 * external-service-action / product-decision. An ABSENT capability is NOT genuine (the default
 * operational read); approval-auto-clearable / live-dependency are leader-clearable, not owner work.
 */
function isStrictOwnerActionCapability(cap: ExternalBlockerCapability | undefined): boolean {
  return cap !== 'product-decision' && Boolean(cap && externalBlockerCapabilityPolicy(cap).requiresOwnerCapability);
}

/**
 * P-004 (WI-5679): route an OPERATIONAL failure to the leader-triage lane through the deps seam —
 * status='blocked' + payload.blockedReason + release the (stale) claim. Mirrors issues-engineer's
 * {@link markLeaderTriage} but via ResolveDeps so every branch stays unit-testable without PG.
 * Returns true when the block actually stuck (setIssueState returned a row); a remote-owned/missing
 * row no-ops to false and is left as-is (a true-remote row is already excluded from the local claim
 * path). ALWAYS releases the claim regardless.
 */
async function routeToLeaderTriage(
  deps: ResolveDeps,
  id: string,
  blockedReason: string,
  by: string,
): Promise<boolean> {
  const updated = await deps.setIssueState(id, 'blocked', by);
  if (updated) {
    await deps.mergeIssuePayload(id, { blockedReason, blockedAt: new Date().toISOString() });
  }
  await deps.releaseIssue(id);
  return updated != null;
}

export async function resolveImprovement(
  input: ResolveImprovementInput,
  deps: ResolveDeps = defaultDeps,
): Promise<ResolveImprovementResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { ok: false, id: input.id, error: `issue ${input.id} not found` };

  const by = input.by ?? 'improvement-runner';

  // Drive the item's open dispatch-ledger rows terminal (P-010 / B-04) — called
  // on every SUCCESSFUL resolve path below. Best-effort: a ledger failure must
  // never fail the resolve itself (the orphan collector sweeps stragglers).
  // `outcomeOverride` lets the 'fixed' path re-close as 'needs-human' when the
  // underlying setIssueState write didn't actually happen (see below).
  const closeLedger = async (outcomeOverride?: ResolveOutcome) => {
    try {
      await deps.closeDispatches(input.id, { outcome: outcomeOverride ?? input.outcome, by });
    } catch (e) {
      console.warn(`[improvements:resolve] dispatch-ledger close failed for ${input.id}:`, e instanceof Error ? e.message : e);
    }
  };

  if (ISSUE_TERMINAL_STATUSES.has(issue.state) && input.outcome === 'fixed') {
    // Idempotent: resolving an already-TERMINAL item (resolved|closed) is a no-op
    // success (a re-fired runner must not error out on the second resolve). Still
    // close any open ledger rows — a manually-resolved item must not strand one for
    // the orphan collector to false-positive on.
    //
    // EI-6953/6954/6938: this guard MUST test terminal membership, NOT `!== 'open'`.
    // engineer_issues is a view over work_items (status AS state), and issue-family
    // items are minted with the work-item state `todo` (a NON-terminal, active state
    // outside the canonical open|resolved|closed vocab that other readers normalize
    // to `open`). The old `!== 'open'` guard treated `todo` (and wip/in_progress/…)
    // as already-terminal → returned ok:true WITHOUT ever calling setIssueState, so
    // ~450–650 todo-state items silently never resolved and re-dispatched forever.
    await closeLedger();
    return { ok: true, id: input.id, outcome: 'fixed', state: issue.state };
  }

  if (input.outcome === 'fixed') {
    if (!input.testsRun?.trim()) {
      return {
        ok: false,
        id: input.id,
        error: 'outcome "fixed" requires testsRun — a fix is only resolved when VERIFIED (run the tests, then resolve with the evidence)',
      };
    }
    const evidence =
      `✅ Auto-implement resolved (verified):\n${input.summary}\n\n` +
      `Tests: ${input.testsRun}` +
      (input.commit ? `\nLanded: ${input.commit} (rides the release gate)` : '');
    await deps.commentIssue(input.id, evidence, by);
    // Completion-integrity gate (WI-1403, contract C-1): a genuine, VERIFIED completion
    // (tests ran, evidence recorded above) — reuse that same evidence string as the
    // gate's completionRef so a real fix is never indistinguishable from a dedup flip.
    const updated = await deps.setIssueState(input.id, 'resolved', by, evidence);
    if (!updated) {
      // Root cause of the auto-implement dispatch storm (found while investigating
      // EI-18117747280304049 / filed as the federated-hive-sync-overwrite bug):
      // setIssueState returns null when the underlying harness_shared.work_items
      // row could not actually be written — the most common cause is a FEDERATED
      // issue (origin='remote'): the engineer_issues view's INSTEAD OF trigger
      // (EI-7833, mig 521/641) deliberately no-ops a local mutation of a
      // remote-owned row rather than clobbering it. Before this check, that honest
      // null was silently swallowed (`state: updated?.state ?? 'resolved'`) and the
      // caller reported ok:true/'fixed' anyway: the dispatch ledger closed as
      // genuinely fixed, but harness_shared.work_items never changed — the issue
      // stayed open with its stale remote snapshot and re-dispatched on every
      // subsequent cadence tick FOREVER (each retry hitting this exact same
      // no-op). This is peer reconciliation, neither review nor owner action: no
      // local agent or owner decision can mutate the authoring peer's row.
      await deps.commentIssue(
        input.id,
        `⤴ Verified above, but could NOT mark this issue resolved locally: it is federated ` +
          `(origin='remote', owned by its authoring peer's core) and the local engineer_issues ` +
          `view refuses to mutate a remote-owned row. Leaving it for PEER RECONCILIATION — ` +
          `retrying locally will never succeed; the owning peer must publish the terminal state.`,
        by,
      );
      await deps.releaseIssue(input.id);
      await closeLedger('could-not-fix');
      return {
        ok: true,
        id: input.id,
        outcome: 'could-not-fix',
        state: issue.state,
        routedToPeerReconciliation: true,
      };
    }
    // Advance the idea lifecycle to 'applied' (self-learning P-031) — the decay
    // sweep then grades it verified/recurred from signature recurrence (P-013).
    // Permissive on the prior state: a legacy item without a lifecycle gets one
    // here so it still enters the decay pipeline.
    await deps.mergeIssuePayload(input.id, {
      ideaLifecycle: updateIdeaLifecycle(lifecycleOf(issue) ?? initializeIdeaLifecycle(), 'applied'),
    });
    await closeLedger();
    return { ok: true, id: input.id, outcome: 'fixed', state: updated.state };
  }

  if (input.outcome === 'needs-human') {
    if (issue.origin === 'remote') {
      await deps.commentIssue(
        input.id,
        `⤴ Local routing cannot mutate this remote-owned row. Leaving it for PEER RECONCILIATION ` +
          `on the authoring node; it is neither agent review nor owner action.\n${input.summary}`,
        by,
      );
      await deps.releaseIssue(input.id);
      await closeLedger('could-not-fix');
      return {
        ok: true,
        id: input.id,
        outcome: 'could-not-fix',
        state: issue.state,
        routedToPeerReconciliation: true,
      };
    }

    if (input.blockerCapability === 'product-decision') {
      await deps.commentIssue(
        input.id,
        `⇄ Routed to peer AGENT REVIEW (product-decision) by the implement worker:\n${input.summary}`,
        by,
      );
      const review = await deps.enterAgentReview({ id: input.id, submittedBy: by });
      if (!review.entered && !review.state) {
        return {
          ok: false,
          id: input.id,
          error: `product-decision could not enter agent review: ${review.reason ?? 'unknown reason'}`,
        };
      }
      await closeLedger();
      return {
        ok: true,
        id: input.id,
        outcome: 'needs-human',
        state: issue.state,
        routedToAgentReview: true,
      };
    }

    // Only a strict typed capability reaches the owner-action path. An untyped
    // "needs-human" from a worker was
    // the DOMINANT (209×) over-application — usually an operational give-up, not a real human need
    // — so it now routes to the LEADER-TRIAGE lane (status='blocked') instead: out of the
    // auto-dispatch loop, but a leader (not the owner) triages + re-opens/escalates it.
    if (isStrictOwnerActionCapability(input.blockerCapability)) {
      await deps.commentIssue(
        input.id,
        `⤴ Routed to OWNER ACTION (${input.blockerCapability}) by the implement worker:\n${input.summary}`,
        by,
      );
      // EI-18210987268765837: this branch used to ONLY merge payload.needsHuman and never
      // transitioned `state` — so the item stayed 'open', and every claim path (scheduler:
      // get_next, claim_next) gates on state='open' (P-004/WI-5679's "claim floor" — the
      // needsHuman payload flag alone is NOT durably-excluding, it's the belt-and-suspenders
      // surface for OLDER consumers, not the actual gate). The comment-only handoff was
      // indistinguishable from a state mutation that never happened: root-caused live on
      // EI-12198, which resurfaced via scheduler:get_next 5 days after being "routed to a
      // human" because payload.needsHuman was the only thing set. Mirror the OTHER resolve
      // branches (fixed → 'resolved', leader-triage → 'blocked') by ALSO moving state here —
      // 'needs-human' is a first-class, non-terminal IssueState that the claim floor excludes.
      const askRef = `owner-capability:${input.id}:${input.blockerCapability}`;
      const { blockers } = updateExternalBlockerHistory(
        issue.payload,
        {
          kind: 'human',
          capability: input.blockerCapability,
          ref: askRef,
          summary: input.summary,
          nextVerb: `Provide ${input.blockerCapability} for ${input.id}, then clear blocker ${askRef}.`,
        },
        by,
      );
      await deps.mergeIssuePayload(
        input.id,
        { needsOwnerAction: true, humanCapability: input.blockerCapability, externalBlockers: blockers },
        { unset: ['needsHuman'] },
      );
      // Persist the ask before the lifecycle park. A needs-human state without its
      // question/unblock contract is the write-only queue EI-13766 closes.
      const updated = await deps.setIssueState(input.id, 'needs-human', by);
      await deps.releaseIssue(input.id);
      await closeLedger();
      // A null `updated` (e.g. a federated/remote-owned issue whose view UPDATE no-ops, same
      // class as the 'fixed' path above) still leaves payload.needsOwnerAction as a fallback —
      // report the state we could actually confirm rather than claiming a state that may not
      // have persisted.
      return {
        ok: true,
        id: input.id,
        outcome: 'needs-human',
        state: updated?.state ?? 'open',
        routedToOwnerAction: true,
      };
    }
    await deps.commentIssue(
      input.id,
      `⤷ Routed to LEADER TRIAGE (status=blocked) by the implement worker — no typed human-capability ` +
        `blocker was given, so this is treated as an operational block, not an owner-inbox item:\n${input.summary}\n\n` +
        `(If this genuinely needs the owner, resolve again with a typed blockerCapability: ` +
        `credential | physical-device | external-service-action; product-decision uses agent review.)`,
      by,
    );
    const blocked = await routeToLeaderTriage(deps, input.id, 'implement-worker:needs-human-untyped', by);
    await closeLedger();
    return {
      ok: true,
      id: input.id,
      outcome: 'needs-human',
      state: blocked ? 'blocked' : 'open',
      routedToLeaderTriage: blocked,
    };
  }

  // could-not-fix: release for a later retry; exhausted attempts → LEADER TRIAGE (P-004/WI-5679:
  // a bug that resists the auto-implement retry cap is an operational block a leader triages, not
  // an owner-inbox item — routing it to payload.needsHuman was over-application).
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts = attemptsOf(issue);
  const exhausted = attempts >= maxAttempts;
  await deps.commentIssue(
    input.id,
    `✗ Auto-implement attempt ${attempts || '?'} failed:\n${input.summary}` +
      (exhausted
        ? `\n\nRetries exhausted (${attempts}/${maxAttempts}) — routing to leader triage (status=blocked).`
        : ''),
    by,
  );
  if (exhausted) {
    const blocked = await routeToLeaderTriage(
      deps,
      input.id,
      `auto-implement:retries-exhausted:${attempts}/${maxAttempts}`,
      by,
    );
    await closeLedger();
    return {
      ok: true,
      id: input.id,
      outcome: 'could-not-fix',
      state: blocked ? 'blocked' : 'open',
      routedToLeaderTriage: blocked,
    };
  }
  await deps.releaseIssue(input.id);
  await closeLedger();
  return { ok: true, id: input.id, outcome: 'could-not-fix', state: 'open' };
}

// ── Exhausted-without-resolve ⇒ needs-human (consume-edges P-012) ─────────────
//
// The paths above only run when a worker CALLS improvements:resolve. A worker
// that dies silently (SIGTERM, crash, never spawned) calls nothing — so an item
// whose dispatch attempts exhaust through the stale-claim cycle stays stranded
// in the auto lane forever: never dispatchable again (the attempts cap), never
// routed to a human (only an explicit could-not-fix/needs-human resolve did
// that). This is the flip that catches the silent-death case: the implement
// routine calls it for every attempts-exhausted item still missing `needsHuman`.

export interface ExhaustedFlipInput {
  id: string;
  /** Dispatch attempts recorded so far (for the explanatory comment). */
  attempts?: number;
  /** The cap the attempts exhausted against (default DEFAULT_MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** Who is flipping (default 'improvement-implement' — the routine). */
  by?: string;
}

export interface ExhaustedFlipResult {
  ok: boolean;
  id: string;
  /** True when this call routed the item to the human tier. */
  flipped: boolean;
  /** Why nothing was flipped (already-human / not-open / not-found). */
  reason?: string;
}

/**
 * Route an attempts-exhausted item with NO resolve ever recorded to the LEADER-TRIAGE lane
 * (P-004/WI-5679): explanatory comment + status='blocked' (payload.blockedReason) + release the
 * (stale) claim. A silent worker death is an OPERATIONAL failure, not a genuine human need, so it
 * belongs in leader triage, not the owner's inbox — routing it to payload.needsHuman was the
 * over-application this fixes. Idempotent — an item already blocked (state !== 'open'),
 * already owner-routed, resolved, or missing is a no-op, so the routine can call it every tick for
 * whatever planImplementRun reports exhausted.
 */
export async function routeExhaustedImprovementToLeaderTriage(
  input: ExhaustedFlipInput,
  deps: ResolveDeps = defaultDeps,
): Promise<ExhaustedFlipResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { ok: false, id: input.id, flipped: false, reason: `issue ${input.id} not found` };
  if (issue.state !== 'open') return { ok: true, id: input.id, flipped: false, reason: 'not open' };
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  if (p.needsHuman === true || p.needsOwnerAction === true) {
    return { ok: true, id: input.id, flipped: false, reason: 'already routed to owner action' };
  }

  const by = input.by ?? 'improvement-implement';
  const attempts = input.attempts ?? attemptsOf(issue);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  await deps.commentIssue(
    input.id,
    `⤷ Auto-implement attempts exhausted with NO resolve ever recorded (${attempts}/${maxAttempts} dispatches) — ` +
      `the worker(s) died without calling improvements:resolve (silent worker death). ` +
      `Routing to leader triage (status=blocked); this item will not auto-dispatch again.`,
    by,
  );
  const blocked = await routeToLeaderTriage(
    deps,
    input.id,
    `silent-worker-death:attempts-exhausted:${attempts}/${maxAttempts}`,
    by,
  );
  return { ok: true, id: input.id, flipped: blocked };
}
