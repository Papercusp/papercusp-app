/**
 * Process kill — the only place that issues `process.kill` to host pids
 * from the operator surface.
 *
 * Defense layers, top to bottom:
 *   1. Principal/capability gate (`processes:kill`, Tier 1) — enforced
 *      by the dispatcher wrapper before this code runs. Bearer-required.
 *      Agents that pass URL spawn ctx (no bearer) cannot reach here.
 *   2. Kind allowlist — only `run.sh | omp | claude | codex`. Bare or
 *      otherwise-unclassified Claude/Codex commands are admitted by an exact
 *      argv[0] basename check on the raw PID probe rather than widening
 *      dev:processes' deliberately frozen inventory. `paperclip | next | pty |
 *      other` remain protected because killing them would break the user's
 *      autopilot or the operator itself.
 *   3. Audit log row written before signaling, so we have a record even
 *      if signaling crashes the process tree somehow.
 */

import { basename } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { listProcesses, probeProcess, type ProcessEntry } from './dev-data';

export type KillableKind = 'run.sh' | 'omp' | 'claude' | 'codex';
/**
 * Exported so the tool's GUIDANCE can be pinned to it in a test: if this set
 * is ever widened, the processes:kill guidance that enumerates it must be
 * updated in the same change (P-012 — a tool must not advertise reach it
 * does not have).
 */
export const KILLABLE: Set<string> = new Set(['run.sh', 'omp', 'claude', 'codex']);

type KillTarget = Pick<
  ProcessEntry,
  'pid' | 'executable' | 'role' | 'build' | 'started_at' | 'cwd' | 'harness_slug' | 'workspace_id'
> & {
  kind: ProcessEntry['kind'] | 'codex';
};

function targetAuditDetails(target: KillTarget): Record<string, unknown> {
  return {
    kind: target.kind,
    executable: target.executable,
    role: target.role,
    build: target.build,
    started_at: target.started_at,
    cwd: target.cwd,
    harness_slug: target.harness_slug,
    workspace_id: target.workspace_id,
  };
}

/**
 * Claude and Codex are intentionally not admitted here by widening
 * dev:processes' frozen six-kind inventory. The recovery path still needs to
 * stop an orphan agent when its raw PID probe exposes a bare or otherwise
 * unclassified CLI command, so admit only a process whose argv[0] basename is
 * exactly `claude` or `codex`. A command that merely mentions either name in a
 * later argument remains unsupported.
 */
function exactCliKind(cmdline: string): 'claude' | 'codex' | null {
  const executable = cmdline.trim().split(/\s+/, 1)[0];
  const command = executable ? basename(executable) : '';
  return command === 'claude' || command === 'codex' ? command : null;
}

export interface KillProcessInput {
  pid: number;
  /** 'SIGTERM' (default) or 'SIGKILL'. */
  signal?: 'SIGTERM' | 'SIGKILL';
  /** Actor slug for the audit log row. */
  actorSlug: string;
  workspaceId: string;
}

export interface KillProcessResult {
  ok: boolean;
  pid: number;
  kind?: string;
  signal?: string;
  error?: 'pid_not_found' | 'unsupported_kind' | 'protected_kind' | 'signal_failed';
  detail?: string;
}

async function writeAudit(
  workspaceId: string,
  actorSlug: string,
  ev: {
    action: string;
    subject: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const id = `kill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actorSlug, ev.action, ev.subject, JSON.stringify(ev.details), workspaceId],
    );
  } catch (err) {
    // Audit failures must not block the operation, but we should log
    // loudly so they're visible in dev.

    console.warn('[processes:kill] audit write failed:', err);
  }
}

export async function killProcess(input: KillProcessInput): Promise<KillProcessResult> {
  const signal = input.signal ?? 'SIGTERM';

  // Re-walk /proc to classify the target. We don't trust the caller's
  // claim about kind — they could send any pid number.
  const { processes } = await listProcesses({});
  let target: KillTarget | undefined = processes.find((p: ProcessEntry) => p.pid === input.pid);

  if (!target) {
    // listProcesses() silently drops any pid classified 'other' before the
    // caller ever sees it, so "not in the classified list" does NOT mean
    // "does not exist" — re-probe the raw pid before asserting that (see
    // EI-18698120633403217).
    const probe = await probeProcess(input.pid);
    const exactKind = probe.exists ? exactCliKind(probe.cmdline) : null;
    if (exactKind) {
      target = {
        pid: input.pid,
        kind: exactKind,
        executable: exactKind,
        role: null,
        build: null,
        started_at: null,
        cwd: null,
        harness_slug: null,
        workspace_id: null,
      };
    } else if (probe.exists) {
      await writeAudit(input.workspaceId, input.actorSlug, {
        action: 'processes.kill_rejected',
        subject: String(input.pid),
        details: {
          reason: 'unsupported_kind',
          kind: probe.kind,
        },
      });
      return {
        ok: false,
        pid: input.pid,
        kind: probe.kind,
        error: 'unsupported_kind',
        // WI-37516: this refusal recurs in practice (43 audited rejections in
        // the 60 days to 2026-09-05, all through the agent tool path) because
        // the caller reached for pid mode on a job that HAS a durable handle —
        // typically a capability:bash-launched build/test job. Widening
        // KILLABLE is deliberately NOT the answer (EI-20581852992216186 Fix #2
        // is superseded: "capability:bash already returns a taskId/scope_unit
        // and taskId-mode is now truthful, the recommended path is taskId, not
        // pid"), so the refusal must NAME that path instead of dead-ending.
        //
        // EI-20741459236918185: naming taskId ALONE still dead-ends the orphaned
        // case. `unaccounted` is DEFINED as residue no ledger row claims
        // (reconcile.ts: `else if (p.owned || scope) unaccountedProcs.push(p)`),
        // so for exactly that class there IS no owning taskId to look up — the
        // caller follows "processes:list gives the owning taskId", finds nothing,
        // and falls back to the raw `kill`/`pkill` the repo convention forbids.
        // The handle that does work is the scope unit, which `killScopeUnit`
        // re-validates against systemd and re-probes before signalling.
        detail:
          `pid ${input.pid} exists but is not a managed agent kind ` +
          `(run.sh|omp|claude|codex|paperclip|pty|next) — this tool only manages those. ` +
          `It was NOT killed and is STILL RUNNING (never read this as gone — EI-18698120633403217). ` +
          `Do not retry in pid mode: stop it by its DURABLE handle instead. ` +
          `processes:list gives the owning taskId (processes:kill { taskId } kills the whole cgroup ` +
          `subtree and cannot hit a recycled pid); a capability:bash background job is stopped with ` +
          `capability:bash_kill { task_id }. If it is ORPHANED residue — surfaced by ` +
          `processes:list { live:true } with no ledger row, so no taskId exists — read its scopeUnit ` +
          `from live.unaccountedGroups and pass processes:kill { scopeUnit }.`,
      };
    } else {
      await writeAudit(input.workspaceId, input.actorSlug, {
        action: 'processes.kill_rejected',
        subject: String(input.pid),
        details: { reason: 'pid_not_found', signal },
      });
      return { ok: false, pid: input.pid, error: 'pid_not_found' };
    }
  }

  if (!KILLABLE.has(target.kind)) {
    await writeAudit(input.workspaceId, input.actorSlug, {
      action: 'processes.kill_rejected',
      subject: String(input.pid),
      details: {
        reason: 'protected_kind',
        ...targetAuditDetails(target),
      },
    });
    return {
      ok: false,
      pid: input.pid,
      kind: target.kind,
      error: 'protected_kind',
      detail: `kind '${target.kind}' is in the protected list`,
    };
  }

  // Write the audit row BEFORE signaling so we have provenance even if
  // the kill cascades into something that takes us down.
  await writeAudit(input.workspaceId, input.actorSlug, {
    action: 'processes.kill',
    subject: String(input.pid),
    details: {
      signal,
      ...targetAuditDetails(target),
    },
  });

  try {
    process.kill(input.pid, signal);
    return { ok: true, pid: input.pid, kind: target.kind, signal };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await writeAudit(input.workspaceId, input.actorSlug, {
      action: 'processes.kill_failed',
      subject: String(input.pid),
      details: { signal, kind: target.kind, error: detail },
    });
    return { ok: false, pid: input.pid, kind: target.kind, error: 'signal_failed', detail };
  }
}
