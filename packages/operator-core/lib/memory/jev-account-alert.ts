/**
 * Owner alert when Jev refuses a call for an ACCOUNT reason (WI-10005694).
 *
 * Why: on 2026-10-02 at 21:31:17Z the TypeSafe organisation ran out of credits.
 * From then on every Jev call came back 402 `billing_error`, and nothing told
 * the owner. A loop wake found it 9 minutes later by reading
 * decision_model_calls by hand (WI-10005690). Only the owner can fix a refusal
 * like that (add credits, replace a revoked key), so it has to reach the owner
 * directly, not wait for a timeout dashboard.
 *
 * What: the Jev client's `onCall` observer passes every record here. A record
 * whose outcome is a provider REFUSAL that needs the owner (402
 * payment-required, 401/403 unauthorized, each with an HTTP status, so a real
 * response rather than a suspended no-send call) raises ONE attention
 * notification per (workspace, reason, UTC day). The delivery is replay-safe
 * through notifyAttentionOnce's dedupeKey, and an in-process memo skips the
 * database round-trip for keys this process has already sent.
 *
 * Timeouts and network errors are deliberately NOT here: they are our side or
 * the network, not something the owner fixes in an account console, and they
 * have their own measurement (EI-24748208098755918).
 */
import type { DecisionCallRecord } from '@papercusp/decision-model';
import { pinModuleState } from '@papercusp/module-singleton';
import { notifyAttentionOnce, type ReplaySafeAttentionNotifyInput } from '../attention-notify';
import { activeWorkspaceId } from '../workspace-registry';

type OwnerActionReason = 'payment-required' | 'unauthorized';

const OWNER_ACTION: Record<OwnerActionReason, { title: string; action: string }> = {
  'payment-required': {
    title: 'TypeSafe (Jev) refused calls: no API credits left',
    action:
      'Add credits or turn on auto-reload at https://console.typesafe.ai/settings/billing. ' +
      'Until then every Jev call fails, and the client sends at most one probe a minute per process.',
  },
  unauthorized: {
    title: 'TypeSafe (Jev) rejected the stored API key',
    action: 'Replace the TypeSafe API key in Settings. Until then every Jev call fails.',
  },
};

export interface JevAccountAlert {
  readonly dedupeKey: string;
  readonly reason: OwnerActionReason;
  readonly title: string;
  readonly body: string;
}

/**
 * The alert a record calls for, or null. Pure. Exported for tests.
 * Only a real provider response counts (status present): a call the client
 * answered itself while suspended after a 402 carries no status.
 */
export function jevAccountAlertFor(record: DecisionCallRecord, workspaceId: string, nowMs: number): JevAccountAlert | null {
  const outcome = record.outcome;
  if (outcome.kind !== 'inconclusive' || outcome.status === undefined) return null;
  const reason = outcome.reason;
  if (reason !== 'payment-required' && reason !== 'unauthorized') return null;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const spec = OWNER_ACTION[reason];
  return {
    dedupeKey: `jev-account-refusal:${workspaceId}:${reason}:${day}`,
    reason,
    title: spec.title,
    body:
      `Provider ${record.provider} returned HTTP ${outcome.status} (${reason}) at ${new Date(nowMs).toISOString()} ` +
      `for a ${record.consumer ?? 'unlabelled'} call. ${spec.action} ` +
      `Check: decision_model_calls rows with inconclusive_reason IS NULL resume once it is fixed.`,
  };
}

export interface JevAccountAlertDeps {
  readonly notify: (input: ReplaySafeAttentionNotifyInput) => Promise<unknown>;
  readonly workspaceId: () => string;
  readonly now: () => number;
}

const state = pinModuleState('@papercusp/operator-core.jev-account-alert', () => ({ sent: new Set<string>() }));

/**
 * Notify the owner once if `record` is an account refusal. Resolves true when a
 * notification was sent (or attempted) for a key this process had not sent yet.
 * Rejects when delivery fails, and the key is then NOT memoised, so the next
 * refusal retries.
 */
export async function alertOwnerOnJevAccountRefusal(
  record: DecisionCallRecord,
  deps: Partial<JevAccountAlertDeps> = {},
): Promise<boolean> {
  const workspaceId = (deps.workspaceId ?? activeWorkspaceId)();
  const alert = jevAccountAlertFor(record, workspaceId, (deps.now ?? Date.now)());
  if (!alert || state.sent.has(alert.dedupeKey)) return false;
  state.sent.add(alert.dedupeKey);
  try {
    await (deps.notify ?? notifyAttentionOnce)({
      workspaceId,
      kind: 'intervention',
      title: alert.title,
      body: alert.body,
      importance: 'high',
      dedupeKey: alert.dedupeKey,
      data: { ownerNotification: true, sourceRef: 'WI-10005694', jevRefusal: alert.reason },
    });
  } catch (err) {
    state.sent.delete(alert.dedupeKey);
    throw err;
  }
  return true;
}

export function __resetJevAccountAlertForTest(): void {
  state.sent.clear();
}
