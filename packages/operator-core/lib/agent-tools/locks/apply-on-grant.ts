/**
 * apply-on-grant — mechanically apply a blocked agent's QUEUED edit at lock
 * grant time instead of waking it to retry (EI-9033).
 *
 * When an agent is lock-blocked on a small, provably-non-conflicting edit to a
 * high-contention shared file (boot.ts, index registries, flags/types.ts), the
 * cost today is queue → sleep → WAKE → a whole agent turn (context reload,
 * re-orientation) just to apply a patch that was already fully specified at
 * block time. `locks:acquire { wake_on_grant, pending_edit }` attaches the
 * concrete edit to the waiter ticket; on grant, the lock-grant bridge calls
 * this to apply it:
 *
 *   - Exact single-match by construction (the Edit-tool contract): if the
 *     holder changed the region, `old_string` no longer matches uniquely, the
 *     patch is NOT applied, and the agent degrades to exactly today's
 *     wake-on-grant (redo it yourself). Safe by construction.
 *   - On a clean apply: write the file, attribute the edit to the queuing
 *     agent (edit_attribution_ledger — git-sync reads it back), RELEASE the
 *     just-granted lock (the edit is done; holding it would block the next
 *     waiter), suppress the wake, and drop a PASSIVE inbox notification. No
 *     turn is spent.
 *
 * EXACTLY-ONCE across the two reconcile paths (NOTIFY fast-path + sweep
 * backstop) is enforced in the store by an atomic claim latch
 * (`claimGrantedPendingEdit`); only the winner applies, everyone else reads the
 * disposition. All post-apply side effects are best-effort — the edit has
 * already landed on disk, which is the load-bearing outcome.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  getTxPool,
  claimGrantedPendingEdit,
  setPendingEditOutcome,
  readPendingEditDisposition,
  tryRelease,
  type GrantedPendingEdit,
  type PendingEdit,
} from './su-lock-store';
import { inWorkspaceTxn } from './in-workspace-txn';
import { lockGrantKey } from './lock-grant-key';
import { recordEditAttribution } from '../../edit-attribution';
import { listActiveAwaitsByKeyPrefix, cancelAwait } from '../../events/await/store';
import { sendMessage } from '../coordination/messages';
import type { AgentIdentity } from '../coordination/identity';

/** 'applied' = landed, agent notified (no wake); 'in-flight' = a peer reconcile
 *  is applying it (no-op); 'fallback' = guardrail/mismatch, fire the normal
 *  grant wake; 'none' = no pending edit, normal grant wake. */
export type ApplyOnGrantResult = 'applied' | 'in-flight' | 'fallback' | 'none';

export interface ApplyEditResult {
  applied: boolean;
  reason?: 'no-match' | 'non-unique' | 'path-escape' | 'read-error' | 'write-error';
}

export interface FileIo {
  read(absPath: string): string;
  write(absPath: string, content: string): void;
}

const nodeFileIo: FileIo = {
  read: (p) => fs.readFileSync(p, 'utf8'),
  write: (p, c) => fs.writeFileSync(p, c, 'utf8'),
};

/**
 * Apply an edit to a file under `repoRoot` following the Edit-tool contract:
 * `old_string` must occur EXACTLY ONCE. Pure but for the injected file IO —
 * unit-testable with an in-memory `FileIo`. Never throws; failures are
 * reported as `{ applied: false, reason }`.
 */
export function applyExactEdit(
  repoRoot: string,
  edit: PendingEdit,
  io: FileIo = nodeFileIo,
): ApplyEditResult {
  if (!edit.old_string) return { applied: false, reason: 'no-match' };

  // Containment guard: the resolved target MUST stay within the repo root
  // (defence-in-depth behind the waiter-path trigger, which already rejects
  // absolute/traversal paths at insert time).
  let abs: string;
  const root = path.resolve(repoRoot);
  try {
    abs = path.resolve(root, edit.file);
  } catch {
    return { applied: false, reason: 'path-escape' };
  }
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { applied: false, reason: 'path-escape' };
  }

  let content: string;
  try {
    content = io.read(abs);
  } catch {
    return { applied: false, reason: 'read-error' };
  }

  const occurrences = content.split(edit.old_string).length - 1;
  if (occurrences === 0) return { applied: false, reason: 'no-match' };
  if (occurrences > 1) return { applied: false, reason: 'non-unique' };

  const idx = content.indexOf(edit.old_string);
  const next =
    content.slice(0, idx) + edit.new_string + content.slice(idx + edit.old_string.length);
  try {
    io.write(abs, next);
  } catch {
    return { applied: false, reason: 'write-error' };
  }
  return { applied: true };
}

/** Injectable seams — defaults hit the real store / fs / coord rails. */
export interface ApplyOnGrantDeps {
  claim?: (ticketId: string) => Promise<GrantedPendingEdit | null>;
  readDisposition?: (ticketId: string) => ReturnType<typeof readPendingEditDisposition>;
  setOutcome?: (ticketId: string, outcome: 'applied' | 'fallback') => Promise<void>;
  applyEdit?: (repoRoot: string, edit: PendingEdit) => ApplyEditResult;
  recordAttribution?: (input: {
    repoRoot: string;
    file: string;
    owner: string;
    workspaceId?: string;
    intent?: string;
    goalRef?: string;
  }) => Promise<void>;
  releaseLock?: (g: GrantedPendingEdit) => Promise<void>;
  cancelWakeAwaits?: (ticketId: string, owner: string) => Promise<void>;
  notify?: (n: {
    owner: string;
    workspaceId?: string;
    file: string;
    lockId: string;
  }) => Promise<void>;
}

async function defaultRecordAttribution(input: {
  repoRoot: string;
  file: string;
  owner: string;
  workspaceId?: string;
  intent?: string;
  goalRef?: string;
}): Promise<void> {
  await recordEditAttribution({
    repoRoot: input.repoRoot,
    files: [input.file],
    agentId: input.owner,
    intent: input.intent,
    workspaceId: input.workspaceId,
    goalRef: input.goalRef,
  });
}

async function defaultReleaseLock(g: GrantedPendingEdit): Promise<void> {
  await inWorkspaceTxn(g.coordination_domain, g.owner, (tx) =>
    tryRelease(tx, {
      coordinationDomain: g.coordination_domain,
      owner: g.owner,
      lockId: g.granted_lock_id,
      paths: g.paths,
    }),
    { paths: g.paths },
  );
}

async function defaultCancelWakeAwaits(ticketId: string, owner: string): Promise<void> {
  const awaits = await listActiveAwaitsByKeyPrefix(lockGrantKey(ticketId));
  for (const a of awaits) {
    if (a.subscriberId === owner) {
      await cancelAwait({ awaitId: a.id, subscriberId: owner });
    }
  }
}

async function defaultNotify(n: {
  owner: string;
  workspaceId?: string;
  file: string;
  lockId: string;
}): Promise<void> {
  const identity: AgentIdentity = {
    ownerId: 'system:lock-apply',
    ownerLabel: 'system:lock-apply',
    source: 'static-client',
    workspaceId: n.workspaceId ?? null,
    userId: null,
  };
  await sendMessage(identity, {
    to: [n.owner],
    summary: `Your queued edit to ${n.file} landed on lock grant — applied for you and the lock released. Nothing to do (no wake was needed).`,
    category: 'lock-edit-applied',
    extra: { auto: true, lifecycle: 'lock-edit-applied', file: n.file, lock_id: n.lockId },
  });
}

/**
 * Attempt apply-on-grant for a just-granted ticket. Returns what the caller
 * (the lock-grant bridge) should do next:
 *   'applied'    — landed; agent notified passively; do NOT fire the grant wake.
 *   'in-flight'  — a peer reconcile is applying it; do NOT fire the grant wake.
 *   'fallback'   — guardrail/mismatch; FIRE the normal grant wake.
 *   'none'       — no pending edit attached; FIRE the normal grant wake.
 */
export async function applyPendingEditOnGrant(
  ticketId: string,
  workspaceId: string | undefined,
  deps: ApplyOnGrantDeps = {},
): Promise<ApplyOnGrantResult> {
  const claim = deps.claim ?? ((t) => claimGrantedPendingEdit(getTxPool(), t));
  const readDisposition =
    deps.readDisposition ?? ((t) => readPendingEditDisposition(getTxPool(), t));
  const setOutcome = deps.setOutcome ?? ((t, o) => setPendingEditOutcome(getTxPool(), t, o));
  const applyEdit = deps.applyEdit ?? ((root, edit) => applyExactEdit(root, edit));
  const recordAttribution = deps.recordAttribution ?? defaultRecordAttribution;
  const releaseLock = deps.releaseLock ?? defaultReleaseLock;
  const cancelWakeAwaits = deps.cancelWakeAwaits ?? defaultCancelWakeAwaits;
  const notify = deps.notify ?? defaultNotify;

  const claimed = await claim(ticketId);
  if (!claimed) {
    // We did not win the latch. Derive whether the bridge should still wake.
    const st = await readDisposition(ticketId);
    return st === 'claiming' ? 'in-flight' : st; // 'none' | 'applied' | 'fallback' pass through
  }

  // Guardrail: single-file, and the edit's file must BE the one granted path.
  if (claimed.paths.length !== 1 || claimed.paths[0] !== claimed.pending_edit.file) {
    await setOutcome(ticketId, 'fallback');
    return 'fallback';
  }

  const res = applyEdit(claimed.coordination_domain, claimed.pending_edit);
  if (!res.applied) {
    // Region changed under the holder (or a guardrail tripped) → do NOT apply;
    // degrade to today's behaviour: the bridge wakes the agent to redo it.
    await setOutcome(ticketId, 'fallback');
    return 'fallback';
  }

  // Landed. Everything below is best-effort — the edit is already on disk.
  await recordAttribution({
    repoRoot: claimed.coordination_domain,
    file: claimed.pending_edit.file,
    owner: claimed.owner,
    workspaceId,
    intent: claimed.intent,
    goalRef: claimed.pending_edit.goal_ref,
  }).catch(() => {});
  await releaseLock(claimed).catch(() => {});
  await setOutcome(ticketId, 'applied').catch(() => {});
  await cancelWakeAwaits(ticketId, claimed.owner).catch(() => {});
  await notify({
    owner: claimed.owner,
    workspaceId,
    file: claimed.pending_edit.file,
    lockId: claimed.granted_lock_id,
  }).catch(() => {});
  return 'applied';
}
