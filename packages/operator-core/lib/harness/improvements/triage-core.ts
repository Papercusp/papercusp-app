/**
 * triage-core.ts — the PERSISTENCE edge of Queen-turn triage
 * (learning-system-audit-improvements-2026-06-09 P-010/P-011; self-learning P-020).
 *
 * Before this existed, `improvements:triage` computed a decision and returned it
 * as JSON — and threw it away (the literal "(In a real implementation, this would
 * write to the DB)" gap). This module is the missing write:
 *
 *   - `applyTriageDecision` — record ONE decision durably on the item:
 *       · writes `payload.ideaLifecycle` → state 'triaged' + decision + reason
 *         (+ ideaType from the classifier), validated against the state machine;
 *       · `reject` ALSO closes the issue with `payload.decidedReason`, so a
 *         rejected idea leaves the open queue AND the "already decided: <reason>"
 *         recall fires on the next same-signature capture (queue-as-memory, D-004).
 *   - `selectUntriaged` — the pure batch picker the scheduled
 *     `system:improvement-triage` routine uses: open items with no lifecycle yet
 *     (or sitting in 'open'/'recurred'), highest digest score first.
 *
 * Deps are injectable so every branch is unit-testable without PG (the
 * resolve-core pattern).
 */

import { getIssue, setIssueState, commentIssue, mergeIssuePayload, type EngineerIssue } from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import type { ScoredItem } from './digest';
import type { TriageDecision } from './triage';
import { classifyIdeaType, extractCitedIds } from './triage';
import { issueToCandidate } from './read-items';
import {
  initializeIdeaLifecycle,
  updateIdeaLifecycle,
  isValidTransition,
  type IdeaLifecyclePayload,
} from './lifecycle';
import { trackDetached } from '../../detached-imports';
import { enterAgentReview } from './agent-review';
import {
  createImplementationReadiness,
  readImplementationReadiness,
  type ImplementationReadinessEvidence,
  type ImplementationReadinessState,
} from './agent-review-policy';
import { ALL_TERMINAL_STATUSES, ISSUE_TERMINAL_STATUSES } from '../../work-item-blocking';
import { getWorkItem } from '../../work-items';
import {
  deploymentStalenessScreen,
  renderDeploymentStalenessDivert,
  LAND_THE_DEPLOY_TARGET,
  type DeploymentStalenessScreen,
} from './deployment-staleness-screen';

export interface ApplyTriageInput {
  id: string;
  decision: TriageDecision;
  reason: string;
  /** Who decided ('Queen', 'improvement-triage' for the scheduled pass, a human id). */
  by?: string;
  /** Write an audit comment on the issue (default true; the scheduled batch
   *  passes false so a 25-item pass doesn't spray 25 thread posts). */
  comment?: boolean;
}

export interface ApplyTriageResult {
  ok: boolean;
  id: string;
  decision?: TriageDecision;
  lifecycle?: IdeaLifecyclePayload;
  /** True when decision='reject' closed the issue (it left the open queue). */
  closed?: boolean;
  /** Present when an evidence guard downgraded an incoming place→gate.
   *  `requestedDecision` is what the caller asked for. Unresolved and same-role
   *  citations are integrity failures; stale citations are the older staleness
   *  guard's contradiction signal. */
  evidenceDowngrade?: {
    requestedDecision: TriageDecision;
    citedIds: string[];
    staleIds: string[];
    unresolvedIds?: string[];
    circularIds?: string[];
  };
  /**
   * The deployment-staleness screen's verdict (P-003), present whenever the screen ran
   * — i.e. on any routing decision for a filing carrying a structured `toolFailure`.
   * `divert:true` means the decision below is "land the deploy", not a code repair.
   * A `state:'unknown'` verdict is reported as such and never as a clean bill.
   */
  deploymentStaleness?: DeploymentStalenessScreen;
  /** Present when the staleness screen diverted the requested decision. */
  deploymentStalenessDivert?: {
    requestedDecision: TriageDecision;
    target: typeof LAND_THE_DEPLOY_TARGET;
  };
  /** Shared normal-build verdict persisted on the work-item payload. */
  implementationReadiness?: ImplementationReadinessState;
  error?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface TriageCoreDeps {
  getIssue: (id: string) => Promise<EngineerIssue | null>;
  /**
   * WI-2147241 — resolve a CITED id through the MIXED-FAMILY door, not the issue-only one.
   *
   * `extractCitedIds` extracts `EI-`/`WI-`/`F-` indiscriminately, but feature-family rows
   * live in the canonical `harness_shared.work_items` base table under `feature_id` and are
   * INVISIBLE to `getIssue` (the issue-family view covers bug/change/task only). Resolving
   * citations through `getIssue` therefore returned `null` for every real feature-family
   * citation, which the integrity guard below reads as "does not exist" — so a REAL,
   * resolvable, on-topic citation was reported fabricated and the decision silently
   * downgraded place→gate. Measured end-to-end 2026-09-06: EI-22432204022928478 citing
   * WI-2145950 (a `done` feature row) was gated as unresolved.
   *
   * This is the exact trap the repo guide's "Verify mixed-family work-item citations
   * against the base table" section warns about; the guard was making the mistake it
   * exists to catch. Kept as a SEPARATE dep from `getIssue` on purpose: the guard needs
   * both families, while every other call here is legitimately issue-family.
   */
  getCitedWorkItem: (id: string, harness?: string) => Promise<CitedWorkItem | null>;
  setIssueState: (
    id: string,
    state: 'open' | 'resolved' | 'closed',
    by?: string,
    completionRef?: string,
    opts?: { skipCompletionGate?: boolean },
  ) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  mergeIssuePayload: (
    id: string,
    patch: Record<string, unknown>,
    opts?: { unset?: readonly string[] },
  ) => Promise<EngineerIssue | null>;
  enterAgentReview: typeof enterAgentReview;
  /**
   * P-003: resolve DEPLOYMENT STATE before the routing decision is recorded. Injected
   * so the divert branch is unit-testable without a repo, a build sha, or git.
   */
  deploymentStalenessScreen: typeof deploymentStalenessScreen;
}

const defaultDeps: TriageCoreDeps = {
  getIssue,
  getCitedWorkItem: getWorkItem,
  setIssueState,
  commentIssue,
  mergeIssuePayload,
  enterAgentReview,
  deploymentStalenessScreen,
};

export type ReopenRejectedTriageResult = 'reopened' | 'already_open' | 'not_found' | 'source_changed';

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Restore the exact open improvement state that preceded a bulk reject. */
export async function reopenRejectedTriageForCompensation(
  input: {
    id: string;
    expectedReason: string;
    priorIdeaLifecycle: unknown | null;
    priorDecidedReason: string | null;
  },
  deps: TriageCoreDeps = defaultDeps,
): Promise<ReopenRejectedTriageResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return 'not_found';
  const payload = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const currentLifecycle = payload.ideaLifecycle ?? null;
  const currentReason = typeof payload.decidedReason === 'string' ? payload.decidedReason : null;
  const priorAlreadyRestored =
    issue.state === 'open' &&
    sameJson(currentLifecycle, input.priorIdeaLifecycle) &&
    currentReason === input.priorDecidedReason;
  if (priorAlreadyRestored) return 'already_open';

  const isBulkReject =
    (issue.state === 'closed' || issue.state === 'open') &&
    currentReason === input.expectedReason &&
    currentLifecycle !== null &&
    typeof currentLifecycle === 'object' &&
    (currentLifecycle as { triageDecision?: unknown }).triageDecision === 'reject';
  if (!isBulkReject) return 'source_changed';

  // State first: if the payload restore fails, a retry sees the still-stamped
  // reject on an open row and finishes it. The opposite order would remove the
  // compare-and-set evidence while leaving the row closed and unretryable.
  if (issue.state !== 'open') {
    const reopened = await deps.setIssueState(input.id, 'open', 'autonomy-revert', undefined, {
      skipCompletionGate: true,
    });
    if (!reopened) return 'source_changed';
  }

  const patch: Record<string, unknown> = {};
  const unset: string[] = [];
  if (input.priorIdeaLifecycle === null) unset.push('ideaLifecycle');
  else patch.ideaLifecycle = input.priorIdeaLifecycle;
  if (input.priorDecidedReason === null) unset.push('decidedReason');
  else patch.decidedReason = input.priorDecidedReason;
  const restored = await deps.mergeIssuePayload(input.id, patch, { unset });
  return restored ? 'reopened' : 'source_changed';
}

/**
 * Evidence-staleness pre-check (EI-18696839552593260): a Scout-idea batch filed
 * 12 near-duplicate ideas, each citing a slightly different subset of the same
 * underlying evidence cluster, and every one of those cited items ALREADY
 * carried a terminal state + completion ref that contradicted the idea's own
 * premise — a single cheap check would have caught every one before it was
 * auto-triaged 'place' and burned a claim+investigate+reject cycle.
 *
 * Best-effort + narrow by design: a lookup failure or an idea citing nothing
 * never blocks anything (returns stale:false); it only ever recommends a
 * place→gate DOWNGRADE (never a reject — mirrors the scheduled triage pass's
 * existing "never reject automatically" conservatism, improvement-actions.ts),
 * and only when EVERY citation resolves to terminal-with-evidence. An
 * unresolved citation keeps the premise unverified rather than being silently
 * ignored; citation integrity is enforced by the companion inspection below.
 */
type EvidenceIssue = Pick<EngineerIssue, 'id' | 'title' | 'body'> & {
  payload?: EngineerIssue['payload'];
  /** `'operator' | 'harness:<slug>'` — the harness the citation lookup is scoped to. */
  scope?: EngineerIssue['scope'];
};

/**
 * The only fields the citation guard reads off a cited row. Deliberately narrow and
 * FAMILY-NEUTRAL: `WorkItem` (mixed-family) and `EngineerIssue` (issue-family) both
 * satisfy it, so the resolver seam can return either without the guard caring which
 * store answered.
 */
type CitedWorkItem = {
  id: string;
  /** Kind-specific lifecycle state — issue: open|resolved|closed; feature: todo|passed|… */
  state: string;
  terminalCompletionRef: string | null;
  payload?: unknown;
};

/**
 * WI-2147241: the harness a citation must be resolved under. Feature-family ids are
 * unique only within a (workspace, harness) — `WI-<n>` comes from a per-database
 * sequence that starts at 1 — so passing the citing item's own harness is what keeps
 * `WI-3` from resolving to a stranger's row. Issue-family rows ignore it (see the
 * `getWorkItem` note on why the issue branch is deliberately unscoped).
 */
function citationHarnessOf(issue: { scope?: string }): string | undefined {
  const scope = issue.scope;
  if (typeof scope !== 'string' || !scope.startsWith('harness:')) return undefined;
  return scope.slice('harness:'.length) || undefined;
}

interface EvidenceCitationInspection {
  citedIds: string[];
  staleIds: string[];
  unresolvedIds: string[];
  circularIds: string[];
  lookupFailedIds: string[];
  stale: boolean;
}

function sourceRoleOf(issue: { payload?: unknown }): string | undefined {
  const payload = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  return typeof payload.sourceRole === 'string' ? payload.sourceRole : undefined;
}

/**
 * Resolve every cited work-item before a place decision can treat the citations
 * as evidence. A missing row is a concrete integrity failure; a resolver error
 * remains fail-open because transient datastore blindness is not proof of a
 * missing incident. Same-role generated ideas are circular evidence rather than
 * incidents, even when they happen to be terminal.
 */
async function inspectEvidenceCitations(
  issue: EvidenceIssue,
  deps: Pick<TriageCoreDeps, 'getCitedWorkItem'>,
): Promise<EvidenceCitationInspection> {
  const citedIds = extractCitedIds(`${issue.title ?? ''} ${issue.body ?? ''}`).filter((id) => id !== issue.id);
  const staleIds: string[] = [];
  const unresolvedIds: string[] = [];
  const circularIds: string[] = [];
  const lookupFailedIds: string[] = [];
  const resolvedIds: string[] = [];
  const sourceRole = sourceRoleOf(issue);
  // WI-2147241: scope the lookup to the CITING item's harness. `WI-<n>` ids are minted from
  // a per-database sequence starting at 1, so they are unique only within (workspace, harness)
  // — an unscoped read can resolve `WI-3` to a stranger's row in another harness.
  const harness = citationHarnessOf(issue);

  for (const id of citedIds) {
    let cited: CitedWorkItem | null = null;
    try {
      // WI-2147241: the MIXED-family door. Feature-family rows (`WI-`/`F-`) live in the
      // canonical `work_items` base table and are invisible to the issue-family view, so
      // resolving here through `getIssue` reported every real feature citation fabricated.
      cited = await deps.getCitedWorkItem(id, harness);
    } catch {
      lookupFailedIds.push(id);
      continue; // best-effort — a lookup failure never blocks the decision
    }
    if (!cited) {
      unresolvedIds.push(id);
      continue;
    }
    resolvedIds.push(id);
    if (sourceRole && sourceRole !== 'human' && sourceRoleOf(cited) === sourceRole) {
      circularIds.push(id);
    }
    // Cross-family terminal set: a feature row is terminal at `passed`/`deprecated`, which
    // ISSUE_TERMINAL_STATUSES cannot see — so the staleness half of the guard went blind on
    // exactly the family the resolver fix just made visible.
    if (ALL_TERMINAL_STATUSES.has(cited.state) && cited.terminalCompletionRef) {
      staleIds.push(id);
    }
  }

  // A stale verdict is meaningful only when the complete citation set was
  // resolved. Otherwise the missing/failed lookup is itself the uncertainty.
  const stale =
    resolvedIds.length > 0 &&
    unresolvedIds.length === 0 &&
    lookupFailedIds.length === 0 &&
    staleIds.length === resolvedIds.length;
  return { citedIds, staleIds, unresolvedIds, circularIds, lookupFailedIds, stale };
}

export async function evidenceStalenessCheck(
  issue: EvidenceIssue,
  deps: Pick<TriageCoreDeps, 'getCitedWorkItem'>,
): Promise<{ stale: boolean; citedIds: string[]; staleIds: string[] }> {
  const check = await inspectEvidenceCitations(issue, deps);
  return { stale: check.stale, citedIds: check.citedIds, staleIds: check.staleIds };
}

function lifecycleOf(issue: EngineerIssue): IdeaLifecyclePayload | null {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const l = p.ideaLifecycle;
  return l && typeof l === 'object' && typeof (l as { state?: unknown }).state === 'string'
    ? (l as IdeaLifecyclePayload)
    : null;
}

function triageImplementationReadiness(input: {
  issue: EngineerIssue;
  decision: TriageDecision;
  citations?: EvidenceCitationInspection;
  deployment?: DeploymentStalenessScreen;
}): ImplementationReadinessState {
  const existing = readImplementationReadiness(input.issue.payload);
  const evidence: ImplementationReadinessEvidence = {};
  if (input.deployment?.screened) {
    evidence.deployment = {
      state: input.deployment.state,
      toolName: input.deployment.toolName,
      ...(input.deployment.state === 'unknown'
        ? { unknownReason: input.deployment.unknownReason }
        : { relPath: input.deployment.relPath }),
    };
  }
  if (input.citations?.citedIds.length) {
    evidence.citations = {
      citedIds: input.citations.citedIds,
      staleIds: input.citations.staleIds,
      unresolvedIds: input.citations.unresolvedIds,
      circularIds: input.citations.circularIds,
      lookupFailedIds: input.citations.lookupFailedIds,
    };
  }
  const withEvidence = Object.keys(evidence).length > 0 ? { evidence } : {};

  if (input.deployment?.screened && input.deployment.state === 'stale') {
    return createImplementationReadiness({
      status: 'not-ready',
      source: 'triage-freshness',
      reason: 'repair-already-present-but-undeployed',
      ...withEvidence,
    });
  }
  if (input.citations?.stale) {
    return createImplementationReadiness({
      status: 'not-ready',
      source: 'triage-freshness',
      reason: 'cited-evidence-already-completed',
      ...withEvidence,
    });
  }
  if (input.decision === 'reject') {
    return createImplementationReadiness({
      status: 'not-ready',
      source: 'triage-freshness',
      reason: 'triage-rejected',
      ...withEvidence,
    });
  }
  if (
    input.citations?.unresolvedIds.length ||
    input.citations?.circularIds.length ||
    input.citations?.lookupFailedIds.length
  ) {
    return createImplementationReadiness({
      status: 'unknown',
      source: 'triage-freshness',
      reason: 'citation-evidence-unresolved',
      ...withEvidence,
    });
  }
  if (
    (input.deployment?.screened && input.deployment.state === 'unknown') ||
    (!input.deployment?.screened && input.deployment?.skipReason === 'screen-unavailable')
  ) {
    return createImplementationReadiness({
      status: 'unknown',
      source: 'triage-freshness',
      reason: 'deployment-freshness-unknown',
      ...withEvidence,
    });
  }
  if (input.decision === 'gate' || input.decision === 'gym') {
    return createImplementationReadiness({
      status: 'unknown',
      source: 'triage-freshness',
      reason: input.decision === 'gate' ? 'awaiting-agent-review' : 'awaiting-validation',
      ...withEvidence,
    });
  }
  // A taxonomy placement is routing, not proof that the reported problem still
  // exists or that an acceptance check is defined. Preserve an existing review
  // approval/policy readiness; otherwise keep the newly-enrolled row unknown.
  return (
    existing ??
    createImplementationReadiness({
      status: 'unknown',
      source: 'triage-freshness',
      reason: 'triage-alone-does-not-establish-readiness',
      ...withEvidence,
    })
  );
}

export async function applyTriageDecision(
  input: ApplyTriageInput,
  deps: TriageCoreDeps = defaultDeps,
): Promise<ApplyTriageResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { ok: false, id: input.id, error: `issue ${input.id} not found` };
  // The improvement lifecycle is independent from work-item completion. A routed
  // idea can remain untriaged after its backing work-item reaches any terminal
  // status, so preserve that work-item status while recording the late triage.
  // Non-terminal, non-open states still indicate an item actively owned by another
  // lifecycle (wip/blocked/needs-human) and remain ineligible here.
  const terminalBacking = ISSUE_TERMINAL_STATUSES.has(issue.state);
  if (issue.state !== 'open' && !terminalBacking) {
    return { ok: false, id: input.id, error: `issue ${input.id} is ${issue.state} — only OPEN items are triaged` };
  }

  // Legacy items (captured before the lifecycle landed) start at 'open' here.
  const current = lifecycleOf(issue) ?? initializeIdeaLifecycle();
  if (!isValidTransition(current.state, 'triaged')) {
    return {
      ok: false,
      id: input.id,
      error: `cannot triage from lifecycle state '${current.state}' (already ${current.state})`,
    };
  }

  let decision: TriageDecision = input.decision;
  let reason = input.reason;
  let evidenceDowngrade: ApplyTriageResult['evidenceDowngrade'];
  let citationInspection: EvidenceCitationInspection | undefined;

  // ── P-003: DEPLOYMENT-STALENESS SCREEN, ahead of every other routing step
  // (EI-22450280531836927).
  //
  // The D-005 taxonomy below cannot see deployment state, so a filing whose subject is
  // already repaired in the tree and merely UNDEPLOYED classifies as an open `code-bug`
  // and routes an agent to fix correct code. Three filers hit one such condition on a
  // single day, each proposing a different code repair; the actual repair was to land
  // the deploy. Screening AFTER the route was considered and rejected in the plan's
  // Design: by then the work-item is filed against the wrong owner with the wrong
  // repair, and the cost this removes has already been paid.
  //
  // It runs on the routing decisions only (place/gate). `reject` is a decided idea that
  // closes the row and dispatches nobody, and `gym` is an A/B, so neither can route an
  // agent at a code fix — paying two git reads for them would be cost without a verdict.
  // Never throws: the screen returns `screened:false` rather than blocking a triage.
  let deploymentStaleness: DeploymentStalenessScreen | undefined;
  let deploymentStalenessDivert: ApplyTriageResult['deploymentStalenessDivert'];
  if (decision === 'place' || decision === 'gate') {
    deploymentStaleness = await deps.deploymentStalenessScreen(issue);
    if (deploymentStaleness.divert) {
      deploymentStalenessDivert = { requestedDecision: decision, target: LAND_THE_DEPLOY_TARGET };
      // A divert is a GATE, never a reject: the reporter's condition is real on the
      // build they hit, so the row must stay open until the deploy lands. It is also
      // never a place — placing it is the dispatch this screen exists to prevent.
      decision = 'gate';
      reason = `${input.reason} — ${renderDeploymentStalenessDivert(deploymentStaleness)} Routed to ${LAND_THE_DEPLOY_TARGET}.`;
    }
  }

  // Evidence-staleness guard (EI-18696839552593260): a 'place' recommendation whose
  // OWN cited evidence is already terminal-with-completion-ref gets downgraded to
  // 'gate' before it ever reaches the auto-implement lane. Best-effort — never
  // throws, never touches a non-'place' decision.
  if (decision === 'place') {
    try {
      const check = await inspectEvidenceCitations(issue, deps);
      citationInspection = check;
      const integrityFailure = check.unresolvedIds.length > 0 || check.circularIds.length > 0;
      if (check.stale || integrityFailure) {
        evidenceDowngrade = {
          requestedDecision: decision,
          citedIds: check.citedIds,
          staleIds: check.staleIds,
          ...(check.unresolvedIds.length ? { unresolvedIds: check.unresolvedIds } : {}),
          ...(check.circularIds.length ? { circularIds: check.circularIds } : {}),
        };
        decision = 'gate';
        const guardReasons: string[] = [];
        if (check.unresolvedIds.length) {
          guardReasons.push(
            `EVIDENCE-INTEGRITY GUARD (EI-19450720466036446): cited item(s) ` +
              `(${check.unresolvedIds.join(', ')}) did not resolve to work items`,
          );
        }
        if (check.circularIds.length) {
          guardReasons.push(
            `EVIDENCE-INTEGRITY GUARD (EI-19450720466036446): same-role generated idea(s) ` +
              `(${check.circularIds.join(', ')}) are circular evidence, not incident records`,
          );
        }
        if (check.stale) {
          guardReasons.push(
            `EVIDENCE-STALENESS GUARD (EI-18696839552593260): every cited item ` +
              `(${check.staleIds.join(', ')}) is already resolved/closed with a completion ref; this idea's ` +
              `premise may already be contradicted by its own cited evidence`,
          );
        }
        reason =
          `${input.reason} — ${guardReasons.join('; ')}. Downgraded place→gate for ` +
          `human/Queen re-verification before auto-implementing.`;
      }
    } catch {
      // best-effort — a guard failure never blocks a normal triage decision
    }
  }

  // Full-fidelity classification (D-005): the candidate view carries paths +
  // watchdogKey + kind, which the taxonomy keys off — never a scope-only call.
  const ideaType = classifyIdeaType(issueToCandidate(issue)).type;
  const lifecycle = updateIdeaLifecycle(current, 'triaged', {
    triageDecision: decision,
    triageReason: reason,
    ideaType,
  });

  const by = input.by ?? 'improvement-triage';
  const implementationReadiness = triageImplementationReadiness({
    issue,
    decision,
    citations: citationInspection,
    deployment: deploymentStaleness,
  });
  const patch: Record<string, unknown> = { ideaLifecycle: lifecycle, implementationReadiness };
  // Durable so the divert is auditable and countable after the fact: "how many filings
  // did the screen keep out of the code-fix lane" must be answerable from the rows
  // themselves, not reconstructed from a tool result nobody kept. Recorded whenever the
  // screen RAN — a 'current' or 'unknown' verdict is evidence about this triage too.
  if (deploymentStaleness?.screened) {
    patch.deploymentStalenessScreen = {
      ...deploymentStaleness,
      at: new Date().toISOString(),
      ...(deploymentStalenessDivert ? { divertedFrom: deploymentStalenessDivert.requestedDecision } : {}),
    };
  }
  // Reject = a DECIDED idea: record the durable reason for the recall matcher
  // ("already decided: <reason>") and close it so it leaves the open queue.
  if (decision === 'reject') patch.decidedReason = reason;
  await deps.mergeIssuePayload(input.id, patch);

  // A triage gate is review work, not an owner-capability escalation. Enrollment is
  // idempotent: an already-pending item stays in the same review round, while strict
  // typed owner actions and remote-owned rows remain on their existing lanes.
  if (decision === 'gate') {
    await deps.enterAgentReview({ id: input.id, submittedBy: by });
  }

  if (input.comment !== false) {
    await deps.commentIssue(input.id, `Triage (${by}): ${decision} — ${reason}`, by);
  }

  let closed = false;
  if (decision === 'reject' && !terminalBacking) {
    // Completion-integrity gate (WI-1403, contract C-1): a triage reject is a genuine,
    // reasoned DECISION by a principal (`by`) — the durable rejection reason IS the
    // completion evidence, so it carries a real completionRef rather than a skip.
    await deps.setIssueState(input.id, 'closed', by, `Triage decision: reject — ${reason}`);
    closed = true;
  }

  // Push the Learning tab's improvements feed (lazy + fire-and-forget — the
  // capture-core pattern; a missing SSE bus is a no-op).
  void trackDetached(import('../../sync-sse'))
    .then((m) =>
      Promise.all([
        m.notifySyncInvalidate('learning.improvements'),
        m.notifySyncInvalidate('learning.improvements.summary'),
      ]),
    )
    .catch(() => {});
  // Push-on-write for the Health tab's improvements panel
  // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007) —
  // same lazy fire-and-forget discipline as the invalidate above.
  void trackDetached(import('../../system-health/compute'))
    .then((m) => m.refreshHealthPanel('improvements'))
    .catch(() => {});

  return {
    ok: true,
    id: input.id,
    decision,
    lifecycle,
    closed,
    ...(evidenceDowngrade ? { evidenceDowngrade } : {}),
    ...(deploymentStaleness ? { deploymentStaleness } : {}),
    ...(deploymentStalenessDivert ? { deploymentStalenessDivert } : {}),
    implementationReadiness,
  };
}

/**
 * Pure batch picker for the scheduled triage pass: OPEN scored items whose
 * lifecycle has not been triaged yet ('open', 'recurred', or no lifecycle at
 * all — legacy captures), highest score first, capped at `max`.
 */
export function selectUntriaged(scored: ScoredItem[], max: number): ScoredItem[] {
  if (max <= 0) return [];
  return scored
    .filter((i) => {
      const s = i.ideaLifecycleState;
      return s === undefined || s === 'open' || s === 'recurred';
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
