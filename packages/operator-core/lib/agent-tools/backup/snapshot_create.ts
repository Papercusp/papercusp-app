/**
 * backup:snapshot_create — take a snapshot of the active workspace.
 * Agents should call this before destructive ops (e.g. before applying
 * a large rewrite, before `git reset --hard`, before clobbering files).
 *
 * Returns the new kopia snapshot id so the same agent can hand it
 * back to backup:restore if its action goes wrong.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { workspaceBackupFor, type SnapshotResult } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';
import { dbosBackupActive } from '../../dbos/dbos-flags';
import { dbosStarted } from '../../dbos/bootstrap';
import { softText, clampText, LIMITS } from '../limits';

// EI-18875467740392530: a real kopia snapshot of this workspace routinely runs
// 2.5-10+ minutes (measured: 2m31s/7m18s/10m31s/2m31s/2m30s on ~9GB), while this
// tool inherits the dispatch stack's default 60s hard AbortController deadline
// (it declares no static timeoutSec) and the ~55s MCP transport ceiling. So the
// call was ALWAYS reporting a bare "exceeded timeout of 60s" failure while the
// snapshot succeeded seconds-to-minutes later — the opposite of the truth, on
// the tool that is the designated PRE-DESTRUCTIVE safety rail. Kept safely
// under both outer ceilings.
// Exported (not just used internally) so a test can assert against it and a
// fake-timer race can advance by exactly this amount rather than a hardcoded
// duplicate literal that would silently drift from the real value.
export const SAFE_DEADLINE_MS = 45_000;

export default defineTool({
  name: 'backup:snapshot_create',
  profile: 'engineer',
  description:
    'Create a kopia snapshot of the active workspace before a destructive op. ' +
    'Returns the snapshot id so the same agent can restore from it if needed.',
  capability: 'backup:write',
  guidance: {
    when: `Create a new backup snapshot of the workspace. Use before risky migrations or major state changes.`,
    notWhen: `For routine commits, this isn't needed — backup snapshots are heavyweight (whole-workspace). For per-harness portable snapshots, use the snapshots tools instead. To reconcile a still-running receipt returned by an earlier call, pass that row as resumeSnapshotId instead of creating another snapshot.`,
    seeAlso: [
      'backup:snapshot_list (list existing snapshots)',
      'backup:settings_set (schedule recurring backups instead of one-shot)',
    ],
  },
  requirePrincipal: false,
  // EI-18803497769946984: the handler drives an external snapshot and blocks for its
  // duration (observed 134s) without reading `ctx.tx`. Holding the ambient workspace
  // transaction across that wait trips idle_in_transaction_session_timeout (60s).
  // See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  args: z.object({
    reason: z.enum([
      'pre_destructive', 'post_run', 'plugin_install', 'secret_change', 'manual',
    ]).default('pre_destructive'),
    note: softText(LIMITS.ANNOTATION).optional(),
    resumeSnapshotId: z.number().int().positive().optional(),
  }),
  async handler(args) {
    const ws = activeWorkspaceId();
    const note = clampText(args.note, LIMITS.ANNOTATION);
    const context = note ? { note } : undefined;
    if (args.resumeSnapshotId !== undefined) {
      const receipt = await workspaceBackupFor(ws).reconcileSnapshotReceipt(args.resumeSnapshotId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }] };
    }
    // Deliberately does NOT route through `triggerSnapshotEvent`, so it bypasses the
    // per-workspace `eventTriggers` gate. That gate answers "should this AUTOMATIC
    // event snapshot?"; this tool is an EXPLICIT request to snapshot now, and `reason`
    // is only the label stamped on the record. Routing it through the gate would let a
    // user who unchecked e.g. "After plugin install" silently turn an agent's direct
    // backup:snapshot_create into a no-op — an explicit ask must never be swallowed by
    // a preference about automatic triggers. Reviewed in settings-audit 2026-07-09
    // while wiring the post_run / plugin_install / secret_change emitters.
    // A/B (dbos-flows P-011): when the backup flag is opted-in AND DBOS actually
    // launched, run the snapshot as a durable workflow (crash-resume via the
    // StepRunner seam); otherwise call snapshot() directly. `getResult` is
    // awaited so the tool keeps its synchronous request→result contract.
    let result: SnapshotResult;
    if (dbosBackupActive() && dbosStarted()) {
      const { startBackupSnapshotWorkflow } = await import('../../dbos/backup-workflow');
      const nonce = Date.now().toString(36) + randomBytes(4).toString('hex');
      result = await startBackupSnapshotWorkflow({ workspaceId: ws, reason: args.reason, context }, nonce);
    } else {
      // EI-18875467740392530: race the real (potentially minutes-long) snapshot
      // against SAFE_DEADLINE_MS instead of letting the dispatch stack's own 60s
      // abort fire first and report a bare, misleading "timeout" for an operation
      // that is in fact succeeding. `onStarted` fires the moment the durable
      // tracking row exists (step 1 of snapshot(), well before the expensive
      // kopia shell-out), so even the deadline-loses branch can hand back a real
      // snapshotId to poll on. The snapshot promise is NOT cancelled when the
      // deadline wins — it keeps running to completion in this same long-lived
      // process; backup:snapshot_list is the authoritative way to observe it
      // finish (this is exactly what the tool's own row-update step records).
      let startedId: number | undefined;
      const wb = workspaceBackupFor(ws);
      const snapshotPromise = wb.snapshot(args.reason, context, {
        onStarted: (id) => { startedId = id; },
      });
      const deadline = new Promise<{ timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), SAFE_DEADLINE_MS).unref();
      });
      const winner = await Promise.race([
        snapshotPromise.then((r): { timedOut: false; result: SnapshotResult } => ({ timedOut: false, result: r })),
        deadline,
      ]);
      if (winner.timedOut) {
        // Never let a background failure vanish silently: it is already durably
        // recorded (snapshot()'s own catch path flips backup_snapshots.status to
        // 'failed' with error_text) — this is only a log line for live triage.
        snapshotPromise.catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[backup:snapshot_create] background snapshot for ${ws} failed after the tool's own deadline:`, err);
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              stillRunning: true,
              snapshotId: startedId ?? null,
              note: 'Snapshot is still running in the background — this routinely takes minutes on a large workspace. '
                + 'Poll backup:snapshot_list to confirm completion (status \'ok\'/\'failed\'). If the receipt remains '
                + 'running after its progress heartbeat stops, re-call backup:snapshot_create with resumeSnapshotId set '
                + 'to this snapshotId; the row-id tag recovers the exact completed Kopia artifact without starting a '
                + 'second snapshot. Do NOT retry without resumeSnapshotId or treat this response as a failure.',
            }),
          }],
        };
      }
      result = winner.result;
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
