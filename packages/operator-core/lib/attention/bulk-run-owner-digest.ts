/**
 * Owner digest for unattended Inbox bulk-resolve passes (P-010).
 *
 * The completed-run report is the canonical audit trail; this module is the
 * delivery edge that makes an unattended pass impossible to miss.  It reuses
 * the durable coord inbox plus the replay-safe mobile/desktop attention rail,
 * keyed by run id, so resolver/process retries cannot page the owner twice.
 *
 * Reversal is deliberately a bounded OWNER conversation, not another policy
 * system: the message names the exact item ids, links the immutable run audit,
 * and remains replyable for 24 hours.  A compensating action can therefore be
 * made from the recorded item ref/action/rationale without pretending that all
 * terminal action families share one mechanical inverse.
 */

import { createHash } from 'node:crypto';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { BulkRunItemRow, BulkRunRow } from './bulk-run-store';
import { BULK_INTAKE_DISPOSITIONS, summarizeIntakeDrain } from './bulk-dispositions';

type GetMessageById = (typeof import('../agent-tools/coordination/messages'))['getMessageById'];
type SendMessage = (typeof import('../agent-tools/coordination/messages'))['sendMessage'];
type NotifyAttentionOnce = (typeof import('../attention-notify'))['notifyAttentionOnce'];

export const UNATTENDED_REVERSAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const UNATTENDED_BULK_REQUESTER = 'system:inbox-bulk-resolve';
/** The scheduled intake-triage drain (observation-candidate plan P-008 / D-020). */
export const UNATTENDED_INTAKE_REQUESTER = 'system:intake-triage-drain';
const UNATTENDED_REQUESTERS = new Set([UNATTENDED_BULK_REQUESTER, UNATTENDED_INTAKE_REQUESTER]);
const DIGEST_ITEM_PREVIEW_LIMIT = 25;

type DigestRun = Pick<BulkRunRow, 'runId' | 'phase' | 'finishedAt' | 'updatedAt' | 'createdAt' | 'autoResolved'> & {
  requestedBy?: BulkRunRow['requestedBy'];
};
type DigestItem = Pick<BulkRunItemRow, 'itemId' | 'title' | 'outcome' | 'actionId' | 'rationale'> & {
  intakeDecision?: BulkRunItemRow['intakeDecision'];
};

/**
 * R-27: the intake lines report what was DECIDED apart from what was DELIVERED.
 * Accepted work is never "resolved" here; it is delivered only once its item is
 * done with committed completion authority, which a settling run cannot yet know.
 */
function intakeDigestLines(items: readonly DigestItem[]): string[] {
  const s = summarizeIntakeDrain(
    items.map((item) => ({ outcome: item.outcome, actionId: item.actionId, intakeDecision: item.intakeDecision ?? null })),
  );
  const decided = BULK_INTAKE_DISPOSITIONS.filter((d) => s.intake.byDisposition[d] > 0)
    .map((d) => `${d} ${s.intake.byDisposition[d]}`)
    .join(', ');
  return [
    `Intake decisions (not delivery): ${s.intake.decided} of ${s.intake.total} decided${decided ? ` — ${decided}` : ''}; ` +
      `${s.intake.undecided} undecided, ${s.intake.failed} failed; ${s.intake.applied} applied.`,
    `Accepted-work delivery: ${s.delivery.accepted} accepted, ${s.delivery.delivered} delivered, ` +
      `${s.delivery.notDelivered} not yet delivered. Accepted is not shipped: each item counts as delivered only once it is done with committed completion authority.`,
  ];
}

export interface UnattendedRunOwnerDigest {
  runId: string;
  title: string;
  body: string;
  reportHref: string;
  autoAppliedItemIds: string[];
  reversalWindowUntil: string;
}

export interface UnattendedRunOwnerDigestDeps {
  getMessage: GetMessageById;
  send: SendMessage;
  notify: NotifyAttentionOnce;
}

const defaultDeps: UnattendedRunOwnerDigestDeps = {
  getMessage: async (...args) => (await import('../agent-tools/coordination/messages')).getMessageById(...args),
  send: async (...args) => (await import('../agent-tools/coordination/messages')).sendMessage(...args),
  notify: async (...args) => (await import('../attention-notify')).notifyAttentionOnce(...args),
};

function digestMessageId(workspaceId: string, runId: string): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}\0${runId}\0unattended-owner-digest`)
    .digest('hex')
    .slice(0, 32);
  return `ntfy-0-${digest}`;
}

function settledAtMs(run: Pick<BulkRunRow, 'finishedAt' | 'updatedAt' | 'createdAt'>): number {
  for (const value of [run.finishedAt, run.updatedAt, run.createdAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function oneLine(value: string | null | undefined, fallback: string): string {
  return (value?.replace(/\s+/g, ' ').trim() || fallback).slice(0, 220);
}

/** Pure renderer: every auto-applied id is retained in the structured result;
 * the prose previews a bounded prefix and points at the complete audit report. */
export function buildUnattendedRunOwnerDigest(run: DigestRun, items: readonly DigestItem[]): UnattendedRunOwnerDigest {
  const applied = items.filter((item) => item.outcome === 'auto_resolved');
  const reversalWindowUntil = new Date(settledAtMs(run) + UNATTENDED_REVERSAL_WINDOW_MS).toISOString();
  const reportHref = `/?opcbr=${encodeURIComponent(run.runId)}&oprpt=opcbr`;
  const count = applied.length;
  const intake = run.requestedBy === UNATTENDED_INTAKE_REQUESTER;
  const pass = intake ? 'intake triage' : 'Inbox';
  const title =
    count === 0
      ? `Unattended ${pass} pass finished — no items auto-applied`
      : `Unattended ${pass} pass auto-applied ${count} item${count === 1 ? '' : 's'}`;
  const preview = applied.slice(0, DIGEST_ITEM_PREVIEW_LIMIT).map((item) => {
    const label = oneLine(item.title, item.itemId);
    const action = oneLine(item.actionId, 'terminal action');
    const why = oneLine(item.rationale, 'No rationale recorded');
    return `- ${item.itemId} — ${label} — ${action}: ${why}`;
  });
  if (applied.length > preview.length) {
    preview.push(`- …and ${applied.length - preview.length} more in the complete run audit`);
  }
  const body = [
    `Scheduled ${pass} run ${run.runId} settled as ${run.phase}.`,
    ...(intake ? intakeDigestLines(items) : []),
    count === 0 ? 'It auto-applied nothing.' : `It auto-applied ${count} item${count === 1 ? '' : 's'}:`,
    ...preview,
    `Open the complete evidence trail: ${reportHref}`,
    `Reversal window closes ${reversalWindowUntil}. Open the report and choose Undo on any applied row before then (or reply here with the item id); the recorded action, ref, rationale, and evidence are the compensation authority.`,
  ].join('\n');
  return {
    runId: run.runId,
    title,
    body,
    reportHref,
    autoAppliedItemIds: applied.map((item) => item.itemId),
    reversalWindowUntil,
  };
}

/** Deliver once through BOTH durable owner-inbox and attention channels.
 * Returns null for foreground/owner-triggered runs: they already have a human
 * in the loop and are not P-010's unattended population. */
export async function deliverUnattendedRunOwnerDigest(
  run: Pick<
    BulkRunRow,
    | 'runId'
    | 'workspaceId'
    | 'harnessSlug'
    | 'requestedBy'
    | 'phase'
    | 'finishedAt'
    | 'updatedAt'
    | 'createdAt'
    | 'autoResolved'
  >,
  items: readonly DigestItem[],
  deps: UnattendedRunOwnerDigestDeps = defaultDeps,
): Promise<{
  delivered: boolean;
  inboxDeduped: boolean;
  msgId: string;
  digest: UnattendedRunOwnerDigest;
} | null> {
  if (!run.requestedBy || !UNATTENDED_REQUESTERS.has(run.requestedBy)) return null;
  const digest = buildUnattendedRunOwnerDigest(run, items);
  const deliveryKey = `inbox-bulk-resolve:${run.runId}:owner-digest`;
  const msgId = digestMessageId(run.workspaceId, run.runId);
  const intake = run.requestedBy === UNATTENDED_INTAKE_REQUESTER;
  const identity: AgentIdentity = {
    ownerId: intake ? UNATTENDED_INTAKE_REQUESTER : UNATTENDED_BULK_REQUESTER,
    ownerLabel: intake ? 'system · intake triage drain' : 'system · Inbox bulk resolver',
    source: 'principal',
    workspaceId: run.workspaceId,
    userId: null,
  };
  const existing = await deps.getMessage(msgId);
  if (!existing) {
    await deps.send(identity, {
      to: ['human'],
      msgId,
      summary: digest.title,
      body: digest.body,
      expectsReply: true,
      harnessSlug: run.harnessSlug ?? undefined,
      extra: {
        ownerNotification: true,
        unattendedBulkRun: true,
        runId: run.runId,
        reportHref: digest.reportHref,
        reversalWindowUntil: digest.reversalWindowUntil,
        reversibleItemIds: digest.autoAppliedItemIds,
      },
    });
  }
  await deps.notify({
    workspaceId: run.workspaceId,
    harnessSlug: run.harnessSlug ?? undefined,
    kind: 'intervention',
    importance: digest.autoAppliedItemIds.length > 0 ? 'high' : 'normal',
    title: digest.title,
    body: digest.body,
    dedupeKey: deliveryKey,
    data: {
      unattendedBulkRun: true,
      runId: run.runId,
      reportHref: digest.reportHref,
      reversalWindowUntil: digest.reversalWindowUntil,
      reversibleItemIds: digest.autoAppliedItemIds.join(','),
    },
  });
  return {
    delivered: !existing,
    inboxDeduped: Boolean(existing),
    msgId,
    digest,
  };
}
