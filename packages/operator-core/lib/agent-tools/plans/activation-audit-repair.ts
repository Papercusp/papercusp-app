/**
 * File — and reconcile — the repair lane for an activation audit that cannot
 * yet be recorded.
 *
 * Both the MCP handler and the lower-level activation writer can reject the
 * same open mapping/blocker. They must converge on one claimable item rather
 * than each minting a sibling, so the condition-upsert seam owns the filing
 * and the condition key stays stable for the plan.
 *
 * ⚠ THE FILER OWNS THE CLOSE. `condition-upsert` states plainly that it has
 * "no auto-settle marker: these items close when someone fixes them, not when
 * a condition clears" — so nothing upstream will ever settle one of these rows.
 * Measured 2026-09-02 (EI-22090432802240306): of 13 activation-audit filings
 * ever made in this workspace, ZERO were closed by a machine — all 6 closes
 * carried an `su-*` terminal_owner, i.e. an agent hand-closing a row whose
 * condition had already cleared, while 6 of the 7 still-open filings were
 * provably stale (3 of them on SHIPPED plans). The sibling `system:spec-triad`
 * lane, which DOES own its close, machine-closed 72. The reconcile seam below
 * is that missing half, fired event-driven from the one write path where the
 * condition provably clears — a clean activation audit landing.
 */
import { findConditionKeyHolder } from '../../coord/condition-bridge';
import { upsertConditionWorkItem } from '../../coord/condition-upsert';
import { setWorkItemState } from '../../work-items';
import type { ActivationAuditPayload } from '../../plan-audits';

export interface ActivationAuditRepairFilingInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  activation: ActivationAuditPayload;
}

export interface ActivationAuditRepairFiling {
  conditionKey: string;
  /** The one work-item owning this blocked activation condition, if filed. */
  id: string | null;
  /** True only when this call minted the owning item. */
  created: boolean;
  /** A lost-race duplicate that could not be settled, if condition-upsert reports one. */
  duplicateLeftOpen?: string;
  /** Filing errors are returned with the original activation refusal. */
  error?: string;
}

export function activationAuditRepairConditionKey(input: {
  harnessSlug: string;
  planSlug: string;
}): string {
  return `activation-audit:${input.harnessSlug}/${input.planSlug}`;
}

function boundedDetails(values: string[], limit = 12): string {
  const shown = values.slice(0, limit);
  const suffix = values.length > shown.length ? `; ... and ${values.length - shown.length} more` : '';
  return `${shown.join('; ')}${suffix}`;
}

export function activationAuditRepairSummary(input: ActivationAuditRepairFilingInput): string {
  const openMappings = input.activation.mappings
    .filter((mapping) => mapping.disposition === 'open')
    .map((mapping) => `${mapping.id}: ${mapping.requirement}`);
  const blockers = input.activation.unresolvedBlockers;
  const causes = [
    openMappings.length > 0 ? `Open mappings: ${boundedDetails(openMappings)}` : null,
    blockers.length > 0 ? `Unresolved blockers: ${boundedDetails(blockers)}` : null,
  ].filter((value): value is string => value !== null);

  return [
    `Activation audit for plan '${input.planSlug}' is blocked and needs repair before ready/active.`,
    ...causes,
    "Repair/map the listed gaps, then rerun plans:audit with phase:'activation'.",
  ].join('\n\n');
}

/**
 * File-or-refresh the one activation repair item. This is deliberately
 * fail-soft: the caller must still report the original activation refusal if
 * the repair queue itself is temporarily unavailable.
 */
export async function ensureActivationAuditRepairFiling(
  input: ActivationAuditRepairFilingInput,
): Promise<ActivationAuditRepairFiling> {
  const conditionKey = activationAuditRepairConditionKey(input);
  try {
    const result = await upsertConditionWorkItem(conditionKey, {
      kind: 'task',
      harness: input.harnessSlug,
      workspaceId: input.workspaceId,
      createdBy: 'system:plans-audit',
      title: `Repair activation audit for plan '${input.planSlug}'`,
      summary: activationAuditRepairSummary(input),
      payload: {
        activationAuditRepair: {
          planSlug: input.planSlug,
          openMappingIds: input.activation.mappings
            .filter((mapping) => mapping.disposition === 'open')
            .map((mapping) => mapping.id),
          unresolvedBlockers: input.activation.unresolvedBlockers,
        },
      },
    });
    return {
      conditionKey,
      id: result.id,
      created: result.created,
      ...(result.duplicateLeftOpen ? { duplicateLeftOpen: result.duplicateLeftOpen } : {}),
    };
  } catch (error) {
    return {
      conditionKey,
      id: null,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Lifecycle actor for the reconciliation close.
 *
 * Deliberately the SAME actor the filing is minted under
 * (`createdBy: 'system:plans-audit'`), matching the `system:spec-triad`
 * precedent where one actor both files and closes: `durable-escalation-orphan-scan`
 * derives an open/closed norm PER ACTOR, so splitting a lane across two actor
 * names would make the filer look like it never closes anything.
 */
export const ACTIVATION_AUDIT_REPAIR_ACTOR = 'system:plans-audit' as const;

export interface ActivationAuditRepairReconciliation {
  conditionKey: string;
  /** The filing this call closed, or null when no open filing owned the key. */
  closed: string | null;
  /** A close that failed is REPORTED, never swallowed — the audit still stands. */
  error?: string;
}

/**
 * Close the open activation-repair filing for a plan whose activation audit
 * just recorded CLEAN.
 *
 * Call this only from the post-commit success path of the activation writer:
 * a clean audit is the exact event that clears the condition this filing names
 * (no unresolved blockers, no open mappings), so the close is conditional on
 * observed state rather than on a sweep's guess. `findConditionKeyHolder`
 * returns only NON-TERMINAL rows, which is what keeps this idempotent under
 * re-audit and what leaves a plan with a genuinely un-repaired condition — one
 * whose audits never came back clean — correctly open.
 *
 * The close mirrors spec-triad's reconciliation exactly: `setWorkItemState` to
 * `dropped` WITH `by` + `completionRef` (never `skipCompletionGate`), so it
 * carries real evidence and lands in no completion-audit bucket. `dropped`
 * rather than `done` on purpose — this actor did not perform the repair, it
 * observed that the condition no longer holds.
 *
 * Fail-soft on the same rail as the filing seam: a recorded audit must never be
 * undone by a queue write, so every failure is returned, never thrown.
 */
export async function reconcileActivationAuditRepairFiling(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  auditSeq: number;
}): Promise<ActivationAuditRepairReconciliation> {
  return closeActivationAuditRepairFiling(
    input,
    `activation audit #${input.auditSeq} recorded clean for plan '${input.planSlug}' ` +
      '(no unresolved blockers, no open requirement mappings) — the condition this filing named has cleared',
  );
}

/**
 * Close the open activation-repair filing for a plan that just went TERMINAL
 * (shipped or superseded) — the second event that ends the condition.
 *
 * A clean audit is not the only way out: a plan can reach a terminal status
 * without one ever being recorded, and then nothing reconciled its filing.
 * Measured 2026-10-01 (EI-24746042684666503): WI-2141077 was filed at 06:26Z
 * for papercup-chat-public-release-2026-09-01, the plan shipped at 06:27Z, and
 * the filing was still open and claimable a month later. Once the plan is
 * terminal there is no activation left to repair, so the filing is moot.
 * Called from the plans:set-plan-status terminal tidy-up; same fail-soft rail.
 */
export async function reconcileActivationAuditRepairFilingForTerminalPlan(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  terminalStatus: 'shipped' | 'superseded';
}): Promise<ActivationAuditRepairReconciliation> {
  return closeActivationAuditRepairFiling(
    input,
    `plan '${input.planSlug}' is ${input.terminalStatus} — there is no activation left to repair, ` +
      'so the condition this filing named no longer applies',
  );
}

async function closeActivationAuditRepairFiling(
  input: { workspaceId: string; harnessSlug: string; planSlug: string },
  completionRef: string,
): Promise<ActivationAuditRepairReconciliation> {
  const conditionKey = activationAuditRepairConditionKey(input);
  try {
    // Workspace-scoped, NOT harness-scoped — same reason condition-upsert reads
    // that way: createIssue normalizes a member harness to its Pot home slug, so
    // a harness-scoped read can miss the very row the filer stored.
    const holder = await findConditionKeyHolder(conditionKey, { workspaceId: input.workspaceId });
    if (!holder) return { conditionKey, closed: null };
    await setWorkItemState(holder, 'dropped', {
      harness: input.harnessSlug,
      by: ACTIVATION_AUDIT_REPAIR_ACTOR,
      completionRef,
    });
    return { conditionKey, closed: holder };
  } catch (error) {
    return {
      conditionKey,
      closed: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
