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

type GetMessageById = (typeof import('../agent-tools/coordination/messages'))['getMessageById'];
type SendMessage = (typeof import('../agent-tools/coordination/messages'))['sendMessage'];
type NotifyAttentionOnce = (typeof import('../attention-notify'))['notifyAttentionOnce'];

export const UNATTENDED_REVERSAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const UNATTENDED_BULK_REQUESTER = 'system:inbox-bulk-resolve';
const DIGEST_ITEM_PREVIEW_LIMIT = 25;

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
export function buildUnattendedRunOwnerDigest(
  run: Pick<BulkRunRow, 'runId' | 'phase' | 'finishedAt' | 'updatedAt' | 'createdAt' | 'autoResolved'>,
  items: readonly Pick<BulkRunItemRow, 'itemId' | 'title' | 'outcome' | 'actionId' | 'rationale'>[],
): UnattendedRunOwnerDigest {
  const applied = items.filter((item) => item.outcome === 'auto_resolved');
  const reversalWindowUntil = new Date(settledAtMs(run) + UNATTENDED_REVERSAL_WINDOW_MS).toISOString();
  const reportHref = `/?opcbr=${encodeURIComponent(run.runId)}&oprpt=opcbr`;
  const count = applied.length;
  const title =
    count === 0
      ? `Unattended Inbox pass finished — no items auto-applied`
      : `Unattended Inbox pass auto-applied ${count} item${count === 1 ? '' : 's'}`;
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
    `Scheduled Inbox run ${run.runId} settled as ${run.phase}.`,
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
  items: readonly Pick<BulkRunItemRow, 'itemId' | 'title' | 'outcome' | 'actionId' | 'rationale'>[],
  deps: UnattendedRunOwnerDigestDeps = defaultDeps,
): Promise<{
  delivered: boolean;
  inboxDeduped: boolean;
  msgId: string;
  digest: UnattendedRunOwnerDigest;
} | null> {
  if (run.requestedBy !== UNATTENDED_BULK_REQUESTER) return null;
  const digest = buildUnattendedRunOwnerDigest(run, items);
  const deliveryKey = `inbox-bulk-resolve:${run.runId}:owner-digest`;
  const msgId = digestMessageId(run.workspaceId, run.runId);
  const identity: AgentIdentity = {
    ownerId: UNATTENDED_BULK_REQUESTER,
    ownerLabel: 'system · Inbox bulk resolver',
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
