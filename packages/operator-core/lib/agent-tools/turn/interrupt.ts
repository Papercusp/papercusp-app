/**
 * turn:interrupt — end a peer agent's CURRENT turn (turn-lifecycle-control
 * Phase 4: P-016/P-018/P-019; D-007/D-008/D-009). The dual of the always-arm
 * wake: a wake RESUMES an idle agent; an interrupt ENDS a running agent's turn.
 *
 * Two modes:
 *  - cooperative: inject a high-priority `yield` coord message mid-turn. The
 *    peer reaches a safe checkpoint, persists partial state, releases locks,
 *    writes a successor note, then ends its turn (persona P-017). The polite
 *    default — DEFERS if the target is in a critical section (holds file locks).
 *  - force: end the turn NOW, mid-thinking. A managed-pty session gets a Ctrl+C
 *    inject over its control socket (Phase-3 `interruptViaPty`); a headless
 *    spawn gets SIGINT to the session pid (the `-p`/`exec` turn ends but the
 *    session stays resumable by id — the TURN ends, not the agent).
 *
 * Operator-mediated (D-008): every fleet agent runs as the SAME OS user, so
 * authorization / attribution / rate-limit cannot live at the OS socket — they
 * live HERE. Per-agent identity from the MCP call, a REQUIRED reason, every call
 * audited (who → whom / mode / reason / outcome), and storm-rate-limited so a
 * confused or looping agent cannot halt the fleet (D-009).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';
import { shortHandle } from '../../coord-schema';
import { COORD_ROLES } from '../coordination/roles';
import { latestAdvSessionByCoordOwner, repairStaleAdvSessionTerminalMarkers } from '../../adv-sessions';
import { interruptViaPty } from '../../events/await/psu-pty-discovery';
import { readIdentity } from '../locks/identity';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';
import { captureHeldWorkItemFlightRecordsForOwner } from '../../work-item-flight-record';

/** Storm guard (D-009): max interrupts one actor may issue per rolling window
 *  before we refuse — the audit log IS the rate source (no extra table). */
const STORM_WINDOW_MS = 60_000;
const STORM_MAX = 10;

/**
 * Trusted SYSTEM recovery actors get a much higher storm ceiling than an
 * ordinary agent (gateway-mass-outage-storm-guard-2026-07-01, root-cause of
 * "the auto-ESC un-wedge didn't fire in ~50 of ~50 recent gateway-outage
 * cases" — su-b399e5ea's finding, confirmed via `turn.interrupt_rate_limited`
 * audit rows with `recent:10` during a correlated gateway-error burst).
 *
 * D-009's STORM_MAX=10/60s was sized for "a confused or looping AGENT
 * hammering ONE target" — but `stall-waker` is a single, code-reviewed,
 * fleet-wide recovery LOOP that legitimately force-ESCs MANY DISTINCT owners
 * within the same tick when a gateway error correlates across the fleet (the
 * exact scenario it exists to recover from). `recentInterruptCount` counts
 * ONLY by actor (not actor+target), so that single shared actor identity hit
 * the 10/60s cap after ~10 DIFFERENT owners in one burst — every 11th+ owner's
 * ESC was silently refused (`rate_limited`) and never retried promptly,
 * leaving it wedged until a human noticed. A regular agent-invoked
 * `turn:interrupt` call is unaffected — it keeps the tight per-actor cap
 * (still catches a genuinely confused/looping single agent).
 */
const STORM_MAX_SYSTEM_ACTOR = Number(process.env.PAPERCUSP_INTERRUPT_STORM_MAX_SYSTEM) || 200;
const SYSTEM_STORM_EXEMPT_ACTORS = new Set<string>(['stall-waker']);
function stormMaxFor(actor: string): number {
  return SYSTEM_STORM_EXEMPT_ACTORS.has(actor) ? STORM_MAX_SYSTEM_ACTOR : STORM_MAX;
}

export interface InterruptInput {
  actor: string;
  workspaceId: string;
  owner: string;
  mode: 'cooperative' | 'force';
  reason: string;
  /** Force-mode keystroke for a managed-pty session: 'sigint' (Ctrl+C `\x03`, the default — the
   *  turn:interrupt tool's behaviour) or 'esc' (`\x1b`, the claude TUI's "abort the turn, return to the
   *  prompt"). endTurn:true / stall-recovery passes 'esc' (D-001): it's the precise keystroke for ending a
   *  STUCK turn so the CLI re-arms its inbox-wake watch, with no Ctrl+C double-press-exit risk. */
  key?: 'sigint' | 'esc';
}

export interface InterruptDeps {
  /** Inject the cooperative yield coord message; returns the msg id. */
  sendYield?: (input: InterruptInput) => Promise<string>;
  /** Active file-lock paths the target currently holds (critical-section signal). */
  heldLockPaths?: (owner: string) => Promise<string[]>;
  /** Interrupts this actor has issued in the storm window (rate source). */
  recentInterrupts?: (actor: string) => Promise<number>;
  /** The target's live session pid, or null when not interruptibly live. */
  liveSessionPid?: (owner: string) => Promise<number | null>;
  /** Repair an observer-written terminal marker before resolving liveness. */
  repairStaleAdvSessionTerminalMarkers?: (owner: string) => Promise<number>;
  /** Managed-pty force inject over the session control socket (Ctrl+C `\x03` for 'sigint', ESC `\x1b` for
   *  'esc'); true on success. */
  ptyForce?: (owner: string, key: 'sigint' | 'esc') => Promise<boolean>;
  /** Send SIGINT to a pid; true on success. */
  sigint?: (pid: number) => boolean;
  /** Append an audit row (who → whom / action / details). */
  audit?: (
    action: string,
    subject: string,
    details: Record<string, unknown>,
    workspaceId: string,
    actor: string,
  ) => Promise<void>;
}

export interface InterruptResult {
  ok: boolean;
  mode: 'cooperative' | 'force';
  deferred?: boolean;
  channel?: 'pty-ctrl-c' | 'pty-esc' | 'sigint';
  delivered?: string;
  error?: string;
  /**
   * Stable discriminator for a `force` interrupt that found NOTHING to interrupt — no managed-pty control
   * socket and no live session pid, i.e. the target is idle or already ended its turn. It is NOT wedged.
   * Lets callers (e.g. the stall-waker) treat this as an EXPECTED non-event rather than a failure worth
   * logging, without brittly string-matching `error`. Only ever set on the force-no-live-session path.
   */
  code?: 'no_live_session';
  reason?: string;
  held?: string[];
  critical_warning?: string;
  note?: string;
}

/**
 * The testable core (deps injected, mirrors wake-executor's executeWake).
 * Never throws — every failure is a structured result.
 */
export async function performInterrupt(input: InterruptInput, deps: InterruptDeps): Promise<InterruptResult> {
  const audit = deps.audit ?? (async () => {});

  // Self-interrupt is a footgun — refuse.
  if (input.owner === input.actor) {
    return { ok: false, mode: input.mode, error: 'cannot interrupt your own turn' };
  }

  // Storm guard (D-009): cap interrupts/min/actor so a looping agent can't halt the fleet.
  // Trusted system recovery actors (stall-waker) get a much higher ceiling — see
  // stormMaxFor's doc comment for why a per-actor (not per actor+target) count needs it.
  const max = stormMaxFor(input.actor);
  const recent = (await deps.recentInterrupts?.(input.actor).catch(() => 0)) ?? 0;
  if (recent >= max) {
    await audit('turn.interrupt_rate_limited', input.owner, { mode: input.mode, reason: input.reason, recent, max }, input.workspaceId, input.actor);
    return {
      ok: false,
      mode: input.mode,
      error: 'rate_limited',
      reason: `more than ${max} interrupts in the last ${STORM_WINDOW_MS / 1000}s — refusing (storm guard)`,
    };
  }

  // Critical-section signal (D-009): active file locks = a mid multi-file edit.
  const held = (await deps.heldLockPaths?.(input.owner).catch(() => [])) ?? [];
  const critical = held.length > 0;

  if (input.mode === 'cooperative') {
    if (critical) {
      // Honor the critical section: a hard yield mid-edit can orphan a lock /
      // leave a half-written file. Let it finish its atomic edit + release.
      await audit('turn.interrupt_deferred', input.owner, { reason: input.reason, held }, input.workspaceId, input.actor);
      return {
        ok: false,
        mode: 'cooperative',
        deferred: true,
        held,
        reason: `target is in a critical section (holds ${held.length} file lock(s)) — cooperative yield DEFERRED so it can finish its atomic edit + release locks. Retry shortly, or use mode:'force' (warns + may orphan the edit).`,
      };
    }
    let msgId = '';
    try {
      msgId = (await deps.sendYield?.(input)) ?? '';
    } catch (e) {
      await audit('turn.interrupt_failed', input.owner, { mode: 'cooperative', error: String(e) }, input.workspaceId, input.actor);
      return { ok: false, mode: 'cooperative', error: `failed to deliver yield: ${String(e)}` };
    }
    await audit('turn.interrupt_cooperative', input.owner, { reason: input.reason, msg_id: msgId }, input.workspaceId, input.actor);
    return {
      ok: true,
      mode: 'cooperative',
      delivered: msgId,
      note: 'yield injected — the peer wraps up + ends its turn at its next checkpoint (it is NOT killed; if it ignores the yield, escalate to force).',
    };
  }

  // ── force ──
  let channel: 'pty-ctrl-c' | 'pty-esc' | 'sigint' | null = null;
  let err: string | null = null;
  let noLiveSession = false;

  // A reconciler can persist ended_by before its ended_at update (for example,
  // across a process/reconciler boundary). Repair that impossible state before
  // either liveness channel is consulted, so a dead owner cannot be routed as a
  // live turn merely because the timestamp half of the terminal tuple is stale.
  try {
    await deps.repairStaleAdvSessionTerminalMarkers?.(input.owner);
  } catch {
    /* fail-soft: the liveness read still handles ordinary live sessions */
  }

  // (1) managed-pty keystroke over the session control socket (graceful for a TUI): ESC ('esc') aborts the
  //     turn back to the prompt; Ctrl+C ('sigint', default) interrupts. ESC is endTurn's choice (D-001).
  const ptyKey = input.key ?? 'sigint';
  const ptyOk = (await deps.ptyForce?.(input.owner, ptyKey).catch(() => false)) ?? false;
  if (ptyOk) {
    channel = ptyKey === 'esc' ? 'pty-esc' : 'pty-ctrl-c';
  } else {
    // (2) headless SIGINT to the session pid — ends the turn; session stays resumable.
    const pid = (await deps.liveSessionPid?.(input.owner).catch(() => null)) ?? null;
    if (pid != null) {
      const ok = deps.sigint?.(pid) ?? false;
      if (ok) channel = 'sigint';
      else err = `SIGINT to pid ${pid} failed`;
    } else {
      noLiveSession = true;
      err =
        'no live interruptible session (no managed-pty control socket and no live session pid) — nothing to force-interrupt; the peer may be idle (use a wake instead) or already ended its turn';
    }
  }

  const warn = critical
    ? `target held ${held.length} file lock(s) (${held.slice(0, 3).join(', ')}${held.length > 3 ? '…' : ''}) — a forced interrupt may have orphaned a half-written edit or a lock; check + recover`
    : undefined;

  if (channel) {
    await audit('turn.interrupt_force', input.owner, { reason: input.reason, channel, critical, held: critical ? held : undefined }, input.workspaceId, input.actor);
    return { ok: true, mode: 'force', channel, ...(warn ? { critical_warning: warn } : {}) };
  }
  // WI-4994: `no_live_session` is an EXPECTED non-event (the target is idle or already ended its
  // turn — not actually wedged), not a genuine failure. The stall-waker's own `unwedge` caller
  // already treats it as `expected` and stays quiet on its console — but this audit call used to
  // fire `turn.interrupt_failed` unconditionally underneath that, so a permanently-dead owner
  // whose stall stays pending (soonestResetAt not yet reached / capacity still walled) produced a
  // steady stream of misleading "failed" audit rows every unwedge cooldown (once/45s, for up to
  // pendingTtlMs=2h per owner) — audit-noise that reads as a real failure in recent-activity.
  // Audit it under a DISTINCT, non-alarming action instead of silently dropping it (still
  // traceable), so a genuine force-interrupt failure (SIGINT-failed, pty refused, etc.) keeps the
  // `turn.interrupt_failed` name and stays easy to find.
  await audit(
    noLiveSession ? 'turn.interrupt_no_live_session' : 'turn.interrupt_failed',
    input.owner,
    { mode: 'force', error: err, critical },
    input.workspaceId,
    input.actor,
  );
  return {
    ok: false,
    mode: 'force',
    error: err ?? 'force interrupt failed',
    ...(noLiveSession ? { code: 'no_live_session' as const } : {}),
    ...(warn ? { critical_warning: warn } : {}),
  };
}

// ── real-dependency helpers (the production wiring) ──

function pidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeInterruptAudit(
  action: string,
  subject: string,
  details: Record<string, unknown>,
  workspaceId: string,
  actor: string,
): Promise<void> {
  // Mirror process-kill.ts: inline INSERT into harness_shared.audit_log (the
  // table audit:list reads). Audit failures never block the operation.
  try {
    const { sql } = getOrgPg();
    const id = `interrupt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, action, subject, JSON.stringify(details), workspaceId],
    );
  } catch (err) {
     
    console.warn('[turn:interrupt] audit write failed:', err);
  }
}

async function recentInterruptCount(actor: string): Promise<number> {
  try {
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.audit_log
        WHERE actor = $1
          AND action IN ('turn.interrupt_cooperative', 'turn.interrupt_force')
          AND ts > $2`,
      [actor, Date.now() - STORM_WINDOW_MS],
    )) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

async function liveSessionPid(owner: string): Promise<number | null> {
  const s = await latestAdvSessionByCoordOwner(owner);
  if (!s || s.endedAt) return null;
  return s.pid != null && pidAlive(s.pid) ? s.pid : null;
}

/**
 * End a peer's CURRENT turn via a forced ESC keystroke — the shared core of `coord:send {endTurn:true}`
 * (P-002) and the gateway stall-waker's ESC-then-wake recovery (P-003). It is the production-wired FORCE
 * branch of {@link performInterrupt} with `key:'esc'`: ESC (`\x1b`) into a managed-pty TUI ends the turn
 * back to the prompt (so the CLI re-arms its inbox-wake watch and a following wake can resume it), else
 * SIGINT to the headless session pid. Reuses the SAME audit, storm rate-limit, self-interrupt refusal, and
 * held-lock warning as the `turn:interrupt` tool. Never throws — every failure is a structured result.
 */
export async function forceEndTurn(
  input: {
    actor: string;
    workspaceId: string;
    owner: string;
    reason: string;
    coordinationDomain?: string | null;
  },
  testDeps?: {
    perform?: typeof performInterrupt;
    capture?: typeof captureHeldWorkItemFlightRecordsForOwner;
    interruptDeps?: InterruptDeps;
  },
): Promise<InterruptResult> {
  const interruptDeps = testDeps?.interruptDeps ?? {
    heldLockPaths: async (owner) => {
      if (!input.coordinationDomain) return [];
      try {
        await ensureBootstrap();
        const sql = getTxPool();
        const q = await readQueue(sql, { coordinationDomain: input.coordinationDomain, owner });
        return q.active_locks.map((l) => l.path);
      } catch {
        return [];
      }
    },
    recentInterrupts: recentInterruptCount,
    repairStaleAdvSessionTerminalMarkers,
    liveSessionPid,
    ptyForce: (owner, key) => interruptViaPty(owner, key),
    sigint: (pid) => {
      try {
        process.kill(pid, 'SIGINT');
        return true;
      } catch {
        return false;
      }
    },
    audit: writeInterruptAudit,
  };
  const result = await (testDeps?.perform ?? performInterrupt)(
    {
      actor: input.actor,
      workspaceId: input.workspaceId,
      owner: input.owner,
      mode: 'force',
      reason: input.reason,
      key: 'esc',
    },
    interruptDeps,
  );
  // A failed/no-op interrupt must never manufacture a flight record. A successful
  // force captures recovery evidence but deliberately leaves every claim intact.
  if (result.ok) {
    try {
      await (testDeps?.capture ?? captureHeldWorkItemFlightRecordsForOwner)({
        ownerId: input.owner,
        workspaceId: input.workspaceId,
        cause: 'forced-interrupt',
      });
    } catch {
      /* fail-soft: interrupt success stands even if evidence capture is unavailable */
    }
  }
  return result;
}

export default defineTool({
  name: 'turn:interrupt',
  description:
    "End a peer agent's CURRENT turn (the dual of a wake). mode:'cooperative' injects a high-priority `yield` so the peer reaches a safe checkpoint, saves partial state, releases locks, and ends its turn (the polite default; DEFERS if the target holds file locks). mode:'force' ends the turn NOW, mid-thinking — Ctrl+C to a managed-pty session or SIGINT to a headless one (the turn ends; the session stays resumable). reason is REQUIRED + audited; storm-rate-limited so it can't be used to halt the fleet.",
  guidance: {
    when: "A peer is doing the wrong thing / working on something now-obsolete / looping, and you need its current turn to STOP. Prefer cooperative (it wraps up cleanly + saves); use force only when it must stop mid-thinking and cooperative was ignored or there's no time.",
    notWhen:
      "To wake an IDLE peer, use coord:send {wake:true} — interrupt is for a RUNNING peer. To hand work over, coord:handoff. Don't force a peer that holds file locks unless necessary (it can orphan a half-written edit) — cooperative defers exactly to avoid that.",
  },
  capability: 'turn:interrupt',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    owner: z.string().min(1).describe('ownerId of the peer whose current turn to end (NOT yourself).'),
    mode: z
      .enum(['cooperative', 'force'])
      .describe(
        "cooperative = injected yield, peer wraps up at its next checkpoint (deferred if it holds locks); force = end the turn now (pty Ctrl+C / headless SIGINT), mid-thinking.",
      ),
    reason: z.string().min(1).describe('REQUIRED — why you are ending their turn. Audited + shown to the peer.'),
  }),
  async handler(args, ctx) {
    const me = resolveAgentIdentity(ctx);
    // The caller's coordination domain — file locks are domain-scoped, and the
    // whole fleet shares one domain, so the target's active locks resolve here.
    let coordinationDomain: string | null = null;
    try {
      coordinationDomain = readIdentity(ctx).coordinationDomain;
    } catch {
      coordinationDomain = null;
    }

    const input: InterruptInput = {
      actor: me.ownerId,
      workspaceId: me.workspaceId ?? '*',
      owner: args.owner,
      mode: args.mode,
      reason: args.reason,
    };

    const result = await performInterrupt(input, {
      sendYield: async (i) =>
        (
          await sendMessage(me, {
            to: [i.owner],
            summary: `yield requested by ${shortHandle(i.actor)}: ${i.reason}`,
            body:
              `A peer (${shortHandle(i.actor)}) asks you to YIELD your current turn — reason: ${i.reason}\n\n` +
              'Reach a safe checkpoint, persist partial state to your work_item, heartbeat/release any locks you hold, write a one-line successor note, then END YOUR TURN. You are NOT killed — a fresh turn can resume the work. (turn:interrupt cooperative)',
            kind: 'yield',
          })
        ).msg_id,
      heldLockPaths: async (owner) => {
        if (!coordinationDomain) return [];
        try {
          await ensureBootstrap();
          const sql = getTxPool();
          const q = await readQueue(sql, { coordinationDomain, owner });
          return q.active_locks.map((l) => l.path);
        } catch {
          return [];
        }
      },
      recentInterrupts: recentInterruptCount,
      repairStaleAdvSessionTerminalMarkers,
      liveSessionPid,
      // Phase-3 seam: keystroke into a live managed-pty session (ESC or Ctrl+C), else false → SIGINT-to-pid.
      ptyForce: (owner, key) => interruptViaPty(owner, key),
      sigint: (pid) => {
        try {
          process.kill(pid, 'SIGINT');
          return true;
        } catch {
          return false;
        }
      },
      audit: writeInterruptAudit,
    });

    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
