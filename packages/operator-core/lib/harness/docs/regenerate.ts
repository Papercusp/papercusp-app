/**
 * regenerate — request a documenter regeneration of a stale generated doc (D-004).
 *
 * Scope note: regeneration is ENQUEUED (marked + surfaced), not auto-executed. The
 * documenter is an LLM pipeline role; spending fleet budget to regenerate is an
 * operator-gated action, so the merged tab's "Regenerate" button + the sweep both
 * enqueue, and the request is broadcast on coord for the harness pipeline / operator
 * to pick up. The enqueue (regen_enqueued_at + status) is the observable contract.
 */

import { getDocRecord, markRegenEnqueued, setDocStatus } from './doc-record';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-id-constant';

const DOCS_IDENTITY: AgentIdentity = {
  ownerId: 'system:doc-freshness',
  ownerLabel: 'doc-freshness',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export type RegenResult =
  | { ok: true; enqueued: true; docId: string }
  | { ok: false; error: string };

/** Enqueue a regeneration for one generated/augmented doc. */
export async function requestRegeneration(
  harnessSlug: string,
  docId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<RegenResult> {
  const id = docId.trim().replace(/^\.?\//, '');
  const rec = await getDocRecord(harnessSlug, id, workspaceId);
  if (!rec) return { ok: false, error: 'unknown_doc' };
  if (rec.source === 'manual') {
    return { ok: false, error: 'manual docs are re-verified, not regenerated — use harness_docs:verify' };
  }
  await markRegenEnqueued(harnessSlug, id, workspaceId);
  // Keep the badge honest: it stays stale until a regeneration actually lands
  // (the documenter re-records it via harness_docs:record).
  if (rec.status === 'fresh') await setDocStatus(harnessSlug, id, 'stale', 'regeneration requested', workspaceId);
  await sendMessage(DOCS_IDENTITY, {
    to: ['*'],
    summary: `📄 ${harnessSlug}: regeneration requested for generated doc ${id} — documenter should refresh it`,
    category: 'doc-drift',
  }).catch(() => {});
  return { ok: true, enqueued: true, docId: id };
}
