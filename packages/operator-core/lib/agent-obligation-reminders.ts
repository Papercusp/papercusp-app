/**
 * Reconcile the shared obligation agenda onto the existing durable await plane.
 *
 * One obligation episode owns at most one one-shot await. Its material-change
 * event and next due deadline share that row: whichever happens first wakes the
 * responsible agent to re-evaluate fresh state. event_awaits remains the only
 * delivery/cursor ledger, so atomic one-shot registration, timeout recovery,
 * coalescing, cancellation, and cold-session wake handles all stay canonical.
 *
 * Plan: shared-agent-obligations-and-briefs-2026-09-05 P-005 / D-006 / D-010.
 */
import type { AgentObligation, AgentObligationAgenda } from './agent-obligations';
import { captureWakeHandleForOwner } from './events/await/handle';
import { cancelAwait, listLifecycleBoundAwaits, registerAwait } from './events/await/store';
import type { AwaitRow, LifecycleBinding } from './events/await/types';

export const AGENT_OBLIGATION_REMINDER_BINDING_KIND = 'agent-obligation';
export const AGENT_OBLIGATION_REMINDER_MIN_SLEEP_SEC = 60;
const DEADLINE_EVENT_PREFIX = 'agent-obligation:deadline:';
const DEADLINE_MATCH_TOLERANCE_MS = 2_000;

export interface AgentObligationReminderReceipt {
  desired: number;
  registered: number;
  retained: number;
  alreadyDelivered: number;
  cancelled: number;
  invalidDeadlines: string[];
  error?: string;
}

export interface AgentObligationReminderDeps {
  captureHandle: typeof captureWakeHandleForOwner;
  listHistory: typeof listLifecycleBoundAwaits;
  register: typeof registerAwait;
  cancel: typeof cancelAwait;
}

const defaultDeps: AgentObligationReminderDeps = {
  captureHandle: captureWakeHandleForOwner,
  listHistory: listLifecycleBoundAwaits,
  register: registerAwait,
  cancel: cancelAwait,
};

interface DesiredReminder {
  obligation: AgentObligation;
  binding: LifecycleBinding;
  eventKey: string;
  deadlineAt: string | null;
  timeoutSec: number | null;
}

function reminderFor(
  obligation: AgentObligation,
  nowMs: number,
): { desired: DesiredReminder | null; invalidDeadline: boolean } {
  const signal = obligation.changeSignal;
  if (!signal) return { desired: null, invalidDeadline: false };

  const event = signal.event?.trim() || null;
  let deadlineAt: string | null = null;
  let timeoutSec: number | null = null;
  let invalidDeadline = false;
  if (signal.nextDeadlineAt) {
    const deadlineMs = Date.parse(signal.nextDeadlineAt);
    if (!Number.isFinite(deadlineMs)) {
      invalidDeadline = true;
    } else if (deadlineMs > nowMs) {
      deadlineAt = new Date(deadlineMs).toISOString();
      timeoutSec = Math.max(1, Math.ceil((deadlineMs - nowMs) / 1_000));
    }
  }

  // A past deadline is already represented in the current agenda. Do not spend
  // another immediate turn just to rediscover it; retain the event leg, if any,
  // so a later material state change still prompts a fresh evaluation.
  if (!event && timeoutSec == null) return { desired: null, invalidDeadline };

  return {
    desired: {
      obligation,
      binding: { kind: AGENT_OBLIGATION_REMINDER_BINDING_KIND, ref: obligation.id },
      eventKey: event ?? `${DEADLINE_EVENT_PREFIX}${obligation.id}`,
      deadlineAt,
      timeoutSec,
    },
    invalidDeadline,
  };
}

function active(row: AwaitRow): boolean {
  return row.firedAt == null && row.cancelledAt == null && row.supersededAt == null;
}

function sameRoute(row: AwaitRow, desired: DesiredReminder): boolean {
  if (row.eventKey !== desired.eventKey || row.policy !== 'wake' || row.once !== true) return false;
  if (desired.deadlineAt == null) return row.expiresTs == null;
  if (!row.expiresTs) return false;
  return Math.abs(Date.parse(row.expiresTs) - Date.parse(desired.deadlineAt)) <= DEADLINE_MATCH_TOLERANCE_MS;
}

function alreadySettled(row: AwaitRow, desired: DesiredReminder): boolean {
  if (!sameRoute(row, desired)) return false;
  return row.firedAt != null || (row.cancelledAt != null && row.cancelReason === 'operator');
}

/**
 * Reconcile all current episodes for one owner. The function is deliberately
 * fail-soft because turn-start orientation must still render the obligation if
 * its optional reminder could not be armed; the returned receipt keeps that
 * degradation explicit for tests and richer callers.
 */
export async function reconcileAgentObligationReminders(
  input: { ownerId: string; agenda: AgentObligationAgenda; now?: Date },
  deps: AgentObligationReminderDeps = defaultDeps,
): Promise<AgentObligationReminderReceipt> {
  const receipt: AgentObligationReminderReceipt = {
    desired: 0,
    registered: 0,
    retained: 0,
    alreadyDelivered: 0,
    cancelled: 0,
    invalidDeadlines: [],
  };

  try {
    const nowMs = (input.now ?? new Date()).getTime();
    const desiredByRef = new Map<string, DesiredReminder>();
    for (const obligation of input.agenda.evaluations) {
      const projected = reminderFor(obligation, nowMs);
      if (projected.invalidDeadline) receipt.invalidDeadlines.push(obligation.id);
      if (projected.desired) desiredByRef.set(obligation.id, projected.desired);
    }
    receipt.desired = desiredByRef.size;

    const [{ handle }, history] = await Promise.all([
      deps.captureHandle(input.ownerId),
      deps.listHistory(input.ownerId, AGENT_OBLIGATION_REMINDER_BINDING_KIND),
    ]);
    const activeRows = history.filter(active);

    for (const [ref, desired] of desiredByRef) {
      const episodeRows = history.filter((row) => row.boundTo?.ref === ref);
      const activeEpisodeRows = episodeRows.filter(active);
      const settled = episodeRows.some((row) => alreadySettled(row, desired));
      const candidates = activeEpisodeRows.filter((row) => sameRoute(row, desired));
      const keep = candidates.find((row) => handle == null || row.wakeHandle != null);

      if (settled) {
        receipt.alreadyDelivered += 1;
        for (const row of activeEpisodeRows) {
          if (await deps.cancel({ awaitId: row.id, subscriberId: input.ownerId })) receipt.cancelled += 1;
        }
        continue;
      }

      for (const row of activeEpisodeRows) {
        if (row.id !== keep?.id && (await deps.cancel({ awaitId: row.id, subscriberId: input.ownerId }))) {
          receipt.cancelled += 1;
        }
      }
      if (keep) {
        receipt.retained += 1;
        continue;
      }

      await deps.register({
        subscriberId: input.ownerId,
        eventKey: desired.eventKey,
        policy: 'wake',
        note:
          `agent-obligation reminder (${desired.obligation.id}) — ` +
          `${desired.obligation.title}; re-evaluate fresh state before acting`,
        wakeHandle: handle,
        timeoutBehavior: 'wake',
        timeoutSec: desired.timeoutSec,
        once: true,
        minSleepSec: AGENT_OBLIGATION_REMINDER_MIN_SLEEP_SEC,
        boundTo: desired.binding,
      });
      receipt.registered += 1;
    }

    // Anything absent from the newly evaluated agenda is resolved, cancelled,
    // or out of scope. Retire only its still-pending delivery row; fired history
    // remains the existing durable proof that a prior episode was handled.
    for (const row of activeRows) {
      const ref = row.boundTo?.ref;
      if (ref && desiredByRef.has(ref)) continue;
      if (await deps.cancel({ awaitId: row.id, subscriberId: input.ownerId })) receipt.cancelled += 1;
    }
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
  }
  return receipt;
}
