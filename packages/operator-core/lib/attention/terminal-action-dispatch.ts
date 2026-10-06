/**
 * Shared terminal-action dispatcher for one AttentionItem.
 *
 * The desktop Inbox and the owner-authorised bulk resolver must not maintain
 * separate `(ref.kind, actionId) -> backend effect` switches.  This module owns
 * that switch and accepts injected effects so the browser can use its HTTP
 * helpers while the server-side resolver uses in-process tool dispatch.
 *
 * Navigation actions are deliberately rejected as non-terminal.  Callers must
 * also validate that `actionId` is currently offered by the item before entering
 * this function; the bulk resolver does that while holding its run authority.
 */

import { isNavigateAction } from './types';
import { ACKNOWLEDGEMENT_ACTION_IDS, isAcknowledgementKind } from './terminal-coverage';
import { INTAKE_APPLY_ACTION_ID, type BulkIntakeDecision } from './bulk-dispositions';

export interface TerminalAttentionItem {
  id: string;
  kind: string;
  title: string;
  harnessSlug?: string | null;
  planSlug?: string | null;
  ownerAgentId?: string | null;
  ref: { kind: string; [key: string]: unknown };
}

export interface TerminalActionResult {
  resolved: boolean;
  live?: boolean;
  woken?: number;
}

export interface TerminalActionDependencies {
  resolveEscalation(input: { msgId: string; choice: string }): Promise<void>;
  acknowledgeMessage(input: { msgId: string }): Promise<void>;
  setPlanItemStatus(input: {
    slug: string;
    itemId: string;
    status: 'done' | 'dropped';
    /** Audit rationale — plans:set-status REQUIRES a nonblank reason for `dropped`. */
    rationale?: string;
  }): Promise<void>;
  /** Best-effort brain nudge after `done`; Drop intentionally never calls it. */
  wakePlanLoop(input: { harnessSlug: string | null; reason: string }): Promise<void> | void;
  dismissImprovement(input: { issueId: string; rationale: string }): Promise<void>;
  decideStandingApproval(input: {
    capability: string;
    targetHarness: string;
    decision: 'approve' | 'dismiss';
  }): Promise<void>;
  triageAttentionItem(input: { itemId: string; action: 'resolve'; note: string }): Promise<void>;
  /**
   * P-003 — clear the OWNER-ACTION gate on a work-item so it returns to the
   * agents. `statusGated` means the row's own `status` is `needs-human` (the
   * feature-family leg of the source query) and must be moved off it as well;
   * the `payload.needsOwnerAction`/`needsHuman` keys are cleared either way,
   * because a row can carry both and clearing one leaves the card standing
   * (EI-21675115869134466 — the sticky-payload leak).
   */
  clearWorkItemOwnerGate(input: {
    workItemId: string;
    harnessSlug?: string | null;
    statusGated: boolean;
  }): Promise<void>;
  /** Clear a wall whose SOURCE is the standing-facts ledger. Exact scope/key
   *  coordinates come from the attention ref; callers must not infer them. */
  retractStandingFact(input: {
    scope: 'workspace' | 'role' | 'owner' | 'harness' | 'work_item';
    scopeRef?: string | null;
    key: string;
    reason: string;
  }): Promise<void>;
  /** P-003 — close a work-item as won't-do, carrying the caller's audit rationale
   *  as the completion evidence a terminal state requires. */
  closeWorkItem(input: { workItemId: string; harnessSlug?: string | null; rationale: string }): Promise<void>;
  /** P-003 — resolve an open question conversation. `acceptedAnswer` carries the
   *  owner's (or resolver's drafted) text when there is one; a bare close still
   *  records why it was closed. `capture` is `'none'` for a bare close: a close
   *  note is NOT an answer, and writing it to the knowledge layer would hand the
   *  next `coord:ask` a synthesized non-answer as if it were one. */
  resolveConversation(input: {
    conversationId: string;
    acceptedAnswer: string;
    capture: 'mem0' | 'none';
  }): Promise<void>;
  /** P-003 — close an open client-session gate (`session_pending_gates`), the
   *  same transition the watcher/hook performs when the ask clears. */
  closeSessionGate(input: { sessionId: string; client: string; refId: string }): Promise<void>;
  /**
   * P-006 (observation-candidate-acceptance-promotion D-013) — execute a recorded
   * intake decision against its source item. Server-only (the bulk resolver injects
   * it); a caller without it cannot apply intake decisions. Resolves `terminal:true`
   * when the decision took effect; refusals THROW with the actionable reason, so a
   * refused promotion is recorded as a failure, never as a resolved item.
   */
  executeIntakeDecision?(input: {
    sourceId: string;
    harnessSlug: string | null;
    decision: BulkIntakeDecision;
    runId: string;
    itemId: string;
  }): Promise<{ terminal: boolean }>;
  /**
   * P-009 (R-31, D-019) — the application-time recheck for an intake decision.
   * The bulk tool checks the kill switch once at entry, BEFORE it takes the run
   * row lock, so an owner flipping the switch (or stopping the run) between that
   * read and the write would otherwise not stop the effect. This runs inside the
   * run-row authority window, immediately before the executor. Required for
   * intake: a caller that supplies an executor without it cannot apply intake
   * (fail closed), and `allowed:false` throws so the item is recorded as failed.
   */
  recheckIntakeApply?(input: { runId: string; itemId: string }): Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Best-effort owner-authoritative reply delivery for named escalation picks.
   * The browser injects its admin-only route.  The bulk resolver injects the
   * same underlying server helper, but only from its run-authority-guarded tool.
   */
  deliverOwnerReply?(input: {
    askerId: string;
    text: string;
    summary: string;
    planSlug?: string;
  }): Promise<{ live: boolean; woken: number }>;
}

function refString(item: TerminalAttentionItem, key: string): string {
  return String(item.ref[key] ?? '');
}

function escalationOptions(item: TerminalAttentionItem): Array<{ id: string; label: string }> {
  if (item.ref.kind !== 'coord-escalation' || !Array.isArray(item.ref.options)) return [];
  return (item.ref.options as unknown[]).filter((value): value is { id: string; label: string } =>
    Boolean(
      value &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { label?: unknown }).label === 'string',
    ),
  );
}

export async function dispatchAttentionTerminalAction(input: {
  item: TerminalAttentionItem;
  actionId: string;
  deps: TerminalActionDependencies;
  /** Caller's audit rationale, threaded into effects that require a reason (plan-item drops). */
  rationale?: string;
  /** P-003 — the owner's (or resolver's drafted) free text, when the terminal
   *  effect can carry one. Today: the accepted answer on a conversation close. */
  answerText?: string;
  /** P-006 — the recorded intake decision being applied (with `apply-intake`). */
  intake?: { decision: BulkIntakeDecision; runId: string };
}): Promise<TerminalActionResult> {
  const { item, actionId, deps, rationale, answerText } = input;
  if (isNavigateAction(actionId)) return { resolved: false };

  if (item.ref.kind === 'improvement' && actionId === INTAKE_APPLY_ACTION_ID) {
    if (!input.intake || !deps.executeIntakeDecision || !deps.recheckIntakeApply) return { resolved: false };
    const recheck = await deps.recheckIntakeApply({ runId: input.intake.runId, itemId: item.id });
    if (!recheck.allowed) {
      throw new Error(`intake apply refused at application time: ${recheck.reason ?? 'recheck refused'}`);
    }
    const executed = await deps.executeIntakeDecision({
      sourceId: refString(item, 'issueId'),
      harnessSlug: item.harnessSlug ?? null,
      decision: input.intake.decision,
      runId: input.intake.runId,
      itemId: item.id,
    });
    return { resolved: executed.terminal };
  }

  if (item.ref.kind === 'coord-escalation') {
    const named = escalationOptions(item).find((option) => option.id === actionId);
    if (!named && actionId !== 'resolve' && actionId !== 'mark-done') return { resolved: false };

    await deps.resolveEscalation({
      msgId: refString(item, 'msgId'),
      choice: named?.id ?? 'resolved',
    });

    // Resolution is already durable. Reply delivery is intentionally
    // best-effort, matching the owner-click path: a transient wake fault must
    // not make the caller repeat a terminal resolve.
    if (item.ownerAgentId && deps.deliverOwnerReply) {
      try {
        const reply = await deps.deliverOwnerReply({
          askerId: item.ownerAgentId,
          text: named?.label ?? 'Resolved',
          summary: `Owner answered your ${item.kind} (${item.id})`,
          ...(item.planSlug ? { planSlug: item.planSlug } : {}),
        });
        return { resolved: true, live: reply.live, woken: reply.woken };
      } catch {
        // Best-effort after a successful resolve; never invite a duplicate.
      }
    }
    return { resolved: true };
  }

  if (item.ref.kind === 'coord-message' && actionId === 'ack') {
    await deps.acknowledgeMessage({ msgId: refString(item, 'msgId') });
    return { resolved: true };
  }

  if (item.ref.kind === 'plan-item') {
    const status = actionId === 'mark-done' || actionId === 'resolve' ? 'done' : actionId === 'drop' ? 'dropped' : null;
    if (status) {
      await deps.setPlanItemStatus({
        slug: refString(item, 'slug'),
        itemId: refString(item, 'itemId'),
        status,
        ...(rationale ? { rationale } : {}),
      });
      if (status === 'done') {
        try {
          await deps.wakePlanLoop({
            harnessSlug: item.harnessSlug ?? null,
            reason: 'Attention item resolved — pick up the unblocked work',
          });
        } catch {
          // The persisted status is authoritative; the armed loop is fallback.
        }
      }
      return { resolved: true };
    }
  }

  if (item.ref.kind === 'improvement' && actionId === 'dismiss') {
    await deps.dismissImprovement({
      issueId: refString(item, 'issueId'),
      rationale: rationale?.trim() || 'Dismissed from the Queue by the owner',
    });
    return { resolved: true };
  }

  if (item.ref.kind === 'standing-approval' && (actionId === 'grant' || actionId === 'dismiss')) {
    await deps.decideStandingApproval({
      capability: refString(item, 'capability'),
      targetHarness: refString(item, 'targetHarness'),
      decision: actionId === 'grant' ? 'approve' : 'dismiss',
    });
    return { resolved: true };
  }

  if (isStandingFactWall(item) && (actionId === 'resolve' || actionId === 'dismiss' || actionId === 'mark-done')) {
    const scope = refString(item, 'factScope') as 'workspace' | 'role' | 'owner' | 'harness' | 'work_item';
    const key = refString(item, 'factKey');
    if (!scope || !key) return { resolved: false };
    await deps.retractStandingFact({
      scope,
      scopeRef: item.ref.factScopeRef == null ? null : refString(item, 'factScopeRef'),
      key,
      reason: rationale?.trim() || 'Owner cleared this wall from the inbox',
    });
    return { resolved: true };
  }

  // ── P-003: the owner-gate kinds ────────────────────────────────────────────
  // `work-item-needs-human` is 46% of the bulk-run ledger and had no terminal
  // action at all: the owner could open it, chat about it, or answer it in the
  // browser, but nothing — not the click path, not the resolver — could clear
  // the gate that put it in the inbox. Resolve does exactly that; Drop closes
  // the item. Both write the SOURCE row, so the card cannot re-derive.
  if (item.ref.kind === 'work-item-needs-human' || isWorkItemBackedWall(item)) {
    const workItemId = workItemIdFor(item);
    if (workItemId && (actionId === 'resolve' || actionId === 'mark-done')) {
      await deps.clearWorkItemOwnerGate({
        workItemId,
        harnessSlug: item.harnessSlug ?? null,
        statusGated: refString(item, 'ownerGate') === 'status',
      });
      return { resolved: true };
    }
    if (workItemId && actionId === 'drop') {
      await deps.closeWorkItem({
        workItemId,
        harnessSlug: item.harnessSlug ?? null,
        rationale: dropRationale(rationale),
      });
      return { resolved: true };
    }
  }

  if (item.ref.kind === 'work-item-blocked' && actionId === 'drop') {
    await deps.closeWorkItem({
      workItemId: refString(item, 'workItemId'),
      harnessSlug: item.harnessSlug ?? null,
      rationale: dropRationale(rationale),
    });
    return { resolved: true };
  }

  if (
    item.ref.kind === 'conversation' &&
    (actionId === 'dismiss' || actionId === 'resolve' || actionId === 'mark-done')
  ) {
    const answered = Boolean(answerText?.trim());
    await deps.resolveConversation({
      conversationId: refString(item, 'conversationId'),
      acceptedAnswer: answered ? answerText!.trim() : closeNote(rationale),
      capture: answered ? 'mem0' : 'none',
    });
    return { resolved: true };
  }

  if (
    item.ref.kind === 'blocked-session' &&
    (actionId === 'resolve' || actionId === 'dismiss' || actionId === 'mark-done')
  ) {
    await deps.closeSessionGate({
      sessionId: refString(item, 'sessionId'),
      client: refString(item, 'client'),
      refId: refString(item, 'refId'),
    });
    return { resolved: true };
  }

  // ── The acknowledgement class ──────────────────────────────────────────────
  // A card DERIVED from something no operator write can change (a compiled-in
  // DARK_FLAGS entry, a past smoke result, a heuristic over closed gates, a
  // rollup nudge, an operator status report). Its honest terminal is the durable
  // triage record the readers already honour — `applyTriage` tiers it Handled and
  // `readTriagedHandledItemIds` suppresses it downstream. Deliberately LAST, so a
  // kind that grows a real source mutation is caught by the branch above rather
  // than silently degrading to an acknowledgement.
  //
  // `operator-report` reached this by its own branch until P-003; the effect is
  // byte-identical, so its behaviour is unchanged — it is simply no longer the
  // only kind allowed to end this way.
  if (
    (isAcknowledgementKind(item.ref.kind) ||
      // A wall that names no work-item (a loop-carry-note wall) has no
      // operator-writable row — the acknowledgement record IS its terminal.
      (item.ref.kind === 'owner-wall' && !isWorkItemBackedWall(item))) &&
    ACKNOWLEDGEMENT_ACTION_IDS.has(actionId as never)
  ) {
    await deps.triageAttentionItem({
      itemId: item.id,
      action: 'resolve',
      note: rationale?.trim() || 'Resolved from the inbox detail pane',
    });
    return { resolved: true };
  }

  return { resolved: false };
}

/** An owner wall is work-item-backed when it names a real work-item id; those
 *  clear through the same owner gate as a `work-item-needs-human` card. A
 *  loop-carry-note wall has no operator-writable row and is left to the
 *  acknowledgement branch. */
function isWorkItemBackedWall(item: TerminalAttentionItem): boolean {
  if (item.ref.kind !== 'owner-wall') return false;
  return item.ref.wallSource === 'work-item' && /^(?:WI|EI|F)-\d+$/i.test(refString(item, 'wallRef'));
}

function isStandingFactWall(item: TerminalAttentionItem): boolean {
  return item.ref.kind === 'owner-wall' && item.ref.wallSource === 'standing-fact';
}

function workItemIdFor(item: TerminalAttentionItem): string {
  return item.ref.kind === 'owner-wall' ? refString(item, 'wallRef') : refString(item, 'workItemId');
}

/** A terminal work-item close REQUIRES completion evidence, so a blank caller
 *  rationale must still produce a truthful, attributable one. */
function dropRationale(rationale?: string): string {
  return rationale?.trim() || 'Closed from the owner inbox as no longer needed';
}

function closeNote(rationale?: string): string {
  return rationale?.trim() || 'Closed from the owner inbox without a recorded answer';
}
