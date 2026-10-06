/**
 * Wake executor — the liveness-adaptive re-invoke ladder
 * (await-event-primitive-2026-06-05 D-003/D-009).
 *
 * Given one due wake delivery + its await's stamped handle, pick the channel:
 *
 *   1. live managed pty (pid-matched in pty-bridge) → INJECT a wake turn.
 *   2. process exited → RESUME the session under a fresh managed pty
 *      (`spawnPty`), per-client resume args; the resumed session is then
 *      observable in /adv AND itself injectable for the next wake. claude
 *      falls back to a detached headless `-p` turn when the pty cap is hit.
 *   3. process alive but uninjectable (a detached terminal emulator — the
 *      common psu case; console-launch spawns gnome-terminal etc., we don't
 *      own its stdin) → PARK + a one-time inbox nudge; the pump re-checks and
 *      converts to a resume when the pid dies. Never inject keystrokes into a
 *      terminal we don't own (focus/ownership rules).
 *   4. nothing live + nothing resumable → DEGRADE to a coord inbox
 *      notification (P-001, wake-delivery-degradation-fix-2026-07-09): per the
 *      events:await registration contract a `notify`-policy subscriber always
 *      has an inbox to fall back to, so losing liveness/resumability is not
 *      the same as having no resolvable owner. Delivered with channel='inbox'
 *      (`degradeToInboxOrDrop`). Only a genuinely undeliverable inbox write
 *      (no resolvable owner / a durable write fault) still DROPS, visibly
 *      (D-004 net #2).
 *
 * Identity survives the resume: PAPERCUSP_SID is re-exported so the woken
 * session keeps its coord identity, lock hooks, and (crucially) its OWN
 * await registrations.
 *
 * claude resume REQUIRES the native session UUID — `--continue` resumes
 * most-recent-in-cwd, and on the shared papercup tree (one cwd for the whole
 * fleet) that would resume a RANDOM PEER's conversation. Without the UUID we
 * degrade to the inbox, visibly.
 */

import { spawn as childSpawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { resolveInheritedOperatorBaseUrl } from '../../mcp-base-url';
import { withBoundedTimeout } from '../../bounded-timeout';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { packWakeText, recordWakePack, renderSectionIndex } from './wake-text-budget';
import { getDoorConstantsSync } from '../../context-doors-config';
import {
  sessionClaudeConfigDir,
  sessionMcpJsonPath,
  codexHomeForSessionKey,
} from '@papercusp/orchestrator/session-launch-dirs';
import { capabilityPolicyFlags } from '@papercusp/orchestrator/managed-capability-policy';
import { readFleetClaudeToken } from '@papercusp/orchestrator/fleet-claude-token';
import {
  fallbackCodexLaunchSpecFromAdvSession,
  getAdvSession,
  claimAdvSessionResume,
  setAdvSessionPid,
} from '../../adv-sessions';
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from '../../task-manager/enroll-sync';
import { resolveAgentBinarySync } from '../../agent-bin-detect';
import {
  autoWakeAccountRoute,
  sanitizeInheritedWakeEnv,
  wakeAccountRouteFromArgv,
  type WakeAccountRoute,
} from '../../inference-gateway/spawn-env';
import {
  rehomeWakeOnBackend as defaultRehomeWakeOnBackend,
  resolveWakeRehome as defaultResolveWakeRehome,
  type WakeRehomeDecision,
} from './wake-rehome';
import {
  collectSessionFiles as defaultCollectSessionFiles,
  findArchivedSessionIdForAdv as defaultFindArchivedSessionIdForAdv,
  rematerializeSession as defaultRematerializeSession,
} from '../../session-archive';
import { ompSessionsRoot } from '../../omp-sessions';
import { findPtyByPid, killPty, spawnPty, writePty } from '../../pty-bridge';
import { localPtyHostId, type PtyAccessScope } from '../../pty-ticket';
import {
  freshContextWarmInjectTarget,
  runFreshContextWarmInject,
  type FreshContextDeps,
} from './wake-executor-fresh-context';
import { appendCrashResumeAdvisory } from './crash-resume-advisory';
import { getPresence, touchHeartbeat } from '../../agent-tools/coordination/presence';
import { resolveWakeMode } from '../../agent-tools/coordination/wake-mode';
import { stagePendingWake } from '../../agent-tools/coordination/pending-wakes';
import { fetchContextPressure, type ContextPressureBucket } from '../../agent-tools/coordination/context-pressure';
import { sendMessage } from '../../agent-tools/coordination/messages';
import { getSessionBriefLifecycle, type SessionBriefLifecycle } from '../../session-brief';
import { getWorkItem, isClaimHoldParked, isSettledWorkItemState } from '../../work-items';
import { CLAIM_STATES_ALLOWLIST } from '../../scheduler/claim-states';
import { lastProductiveToolCallAtByOwner } from '../../fleet/assignments';
// EI-21901188813309549: the SAME shared liveness oracle fleet-transition-events.ts's
// emit-time revalidation reads (there via the gatherCurrentFleetMemberObservation ⇒
// reconcileWakeability path). Imported directly here rather than importing that
// gather helper: fleet-transition-sweep-action.ts → fleet-transition-events.ts →
// events/await/engine.ts → wake-executor.ts would be a live import cycle (the same
// class of hazard the COORD_INBOX_WAKE_PREFIX duplication above exists to avoid).
// liveness-oracle.ts has no path back into wake-executor.ts (verified: its only
// events/await/* dependency is psu-pty-discovery.ts, which wake-executor already
// imports directly and which does not import wake-executor).
import { resolveSessionStates } from '../../agent-tools/coordination/liveness-oracle';
// EI-20489286325396940: `payloadIsTimeout` + `wakeSummaryHeadline` live in
// timeout-fallback.ts (PG-free, beside the other timeout wording) so engine.ts can
// import the summary renderer WITHOUT going through this module — engine.test.ts
// mocks './wake-executor' wholesale, which silently undefined-ed it and deleted the
// park nudge inside a best-effort catch.
import { payloadIsTimeout, wakeSummaryHeadline } from './timeout-fallback';
import { prepareCellWakeFold } from './cell-wake-fold';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import {
  findLiveHost,
  hostIsAgentLaunched,
  hostSupports,
  injectIntoHost,
  injectIntoHostWithConfirmation,
  readHostEventTail,
  type InjectConfirmation,
  type PsuPtyHost,
  type PtyHostEvent,
} from './psu-pty-discovery';
import {
  decideColdWake,
  readColdLoopMarker,
  renderColdWakeInjection,
  COLD_NOTE_POST_TURN_FLOOR_MS,
  type ColdLoopMarker,
  type ColdWakeDecision,
} from '../../su-cold-loop';
import { recordColdNoHostParkAndMaybeEscalate } from './cold-nohost-park-guard';
import {
  getLoopCarryNote,
  getLoopCarryNoteWithMeta as defaultGetLoopCarryNoteWithMeta,
  shortCarryHash,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
} from '../../carry-note';
import {
  clipLoopCheckpointForWake,
  renderLoopChecksBlock,
  renderLoopWallsBlock,
} from '../../harness/routines/loop-fire';
import { getLoopStatus, countAgentToolCallsInWindow } from '../../harness/routines/loop';
import {
  formatEnvelope,
  mintNonce,
  tagTurnForInjection,
  type TaggedTurn,
} from '../../turn-provenance/turn-provenance';

/** The envelope+ledger tagger seam. The real one is async (WI-10005327: its
 *  ledger write must not block the event loop); hermetic test stubs may stay
 *  sync, so callers always await the result. */
export type WakeTurnTagger = (args: Parameters<typeof tagTurnForInjection>[0]) => TaggedTurn | Promise<TaggedTurn>;

// Text accepted by the lower-level injector only after tagWakeText has written
// its provenance ledger entry and prefixed the envelope. The brand lets the
// source guard preserve that proof through the nested warm-wake closure.
declare const ENROLLED_WAKE_TEXT: unique symbol;
type EnrolledWakeText = string & { readonly [ENROLLED_WAKE_TEXT]: true };
import { isInboxOwnerReplyPayload } from '../../agent-tools/coordination/inbox-reply';
import {
  readOwnerChatTurnText,
  ownerChatTurnText,
  OWNER_CHAT_TURN_ORIGIN,
} from '../../agent-tools/coordination/owner-chat-turn';
import {
  analyzeClaudeResumeTranscriptFile,
  appendClaudeToolReferencesToSeed,
  CLAUDE_TOOL_REFERENCE_POISON_TURNS,
  isMissingClaudeToolReferenceError,
  neutralizeResumeNativeToolReferences,
} from '../../claude-resume-tool-references.mjs';
import {
  claudeInheritedEffortOverride,
  readClaudeLaunchSettings,
  type ClaudeLaunchSettings,
} from '../../model-context-budget.mjs';
import { quarantineRepeatedClaudeToolReferenceFailures } from './poisoned-resume-session';
import type { ToolReferenceDeathRecovery } from '../../system-health/compaction-compliance-watchdog';
import type { ResumeTurnContext, ResumeTurnExitRaw } from './resume-turn-outcome';
import type { DeliveryWork, WakeChannel, WakeOutcome } from './types';

/** Bounded output-tail capture for an observed resume turn (P0a). The CLIs print
 *  API errors (incl. the 429 / usage-limit lines) to STDOUT; the dying turn's error
 *  is at the END of its output, so a tail is enough to classify it. */
const RESUME_OUTPUT_TAIL_BYTES = Number(process.env.PAPERCUSP_RESUME_OUTPUT_TAIL_BYTES) || 8192;
const WAKE_MODE_DELIVERY_LOOKUP_TIMEOUT_MS = 15_000;

/** WI-666: bound the attended-loop recovery leg. A resumable loop owner may be
 * alive in a terminal the operator cannot inject, so send SIGINT and wait only
 * briefly for the current process to exit before falling back to the safe park.
 * The loop marker is the safety boundary: ordinary interactive sessions are
 * never force-interrupted by the wake pump. */
export const FORCE_RESUME_EXIT_TIMEOUT_MS = Number(process.env.PAPERCUSP_WAKE_FORCE_RESUME_TIMEOUT_MS) || 2_000;
const FORCE_RESUME_POLL_MS = 50;

export function waitForProcessExit(
  pid: number,
  alive: (pid: number | null) => boolean,
  timeoutMs = FORCE_RESUME_EXIT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      resolve(exited);
    };
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const poll = () => {
      let stillAlive = true;
      try {
        stillAlive = alive(pid);
      } catch {
        stillAlive = true;
      }
      if (!stillAlive) {
        finish(true);
        return;
      }
      if (Date.now() >= deadline) {
        finish(false);
        return;
      }
      pollTimer = setTimeout(poll, FORCE_RESUME_POLL_MS);
      pollTimer.unref?.();
    };
    poll();
  });
}

async function defaultForceResume(pid: number, alive: (pid: number | null) => boolean): Promise<boolean> {
  try {
    // SIGINT ends the current CLI turn while preserving the native session for
    // the normal headless resume leg below. It is intentionally not SIGTERM.
    process.kill(pid, 'SIGINT');
  } catch {
    // A race with natural exit is already a successful force-resume boundary.
    try {
      return !alive(pid);
    } catch {
      return false;
    }
  }
  return waitForProcessExit(pid, alive);
}

/** A growing-but-bounded byte tail — keeps only the last `maxBytes`, so an observed
 *  resume turn that prints megabytes never accumulates more than the tail in memory. */
export function makeTailCollector(maxBytes: number): { push: (b: Buffer) => void; value: () => string } {
  let buf = Buffer.alloc(0);
  return {
    push: (b: Buffer) => {
      buf = buf.length === 0 ? Buffer.from(b) : Buffer.concat([buf, b]);
      if (buf.length > maxBytes) buf = buf.subarray(buf.length - maxBytes);
    },
    value: () => buf.toString('utf8'),
  };
}

/**
 * The default detached-resume spawn (P0a). When an `onExit` observer is wired it
 * spawns with piped stdout/stderr, ACTIVELY DRAINS them into bounded tails (an
 * undrained pipe would backpressure-deadlock the turn), and fires `onExit` once on
 * close — so a turn that 429s after the PID is assigned is observable. Without an
 * observer it is byte-identical to the original (`stdio:'ignore'`, zero overhead).
 * Always returns the PID immediately (the delivery is 'delivered' on spawn either way);
 * the observation is asynchronous + best-effort (a missed exit degrades to the
 * reconcile stuck-park backstop). Exported so the integration test can drive it with a
 * real subprocess (the deadlock-prone path).
 */
export function defaultSpawnDetached(
  bin: string,
  args: string[],
  o: { cwd: string; env: Record<string, string> },
  onExit?: (exit: ResumeTurnExitRaw) => void,
): number | null {
  // The operator services intentionally run with a stripped PATH. Resolve the
  // known agent CLIs through the shared resolver before spawning so an npm
  // install beside the node running the operator remains reachable even when
  // that node prefix is absent from the service environment. Keep arbitrary
  // commands (the real-subprocess test uses process.execPath) byte-identical.
  const spawnBin = resolveResumeSpawnBin(bin);
  const child = childSpawn(spawnBin, args, {
    cwd: o.cwd,
    // The operator itself may use the inference gateway for in-process calls.
    // Never leak that ambient route into a resumed child; executeWake overlays
    // the route reconstructed from this session's persisted launch argv.
    env: { ...sanitizeInheritedWakeEnv(process.env), ...o.env },
    detached: true,
    stdio: onExit ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  if (onExit) {
    const out = makeTailCollector(RESUME_OUTPUT_TAIL_BYTES);
    const err = makeTailCollector(RESUME_OUTPUT_TAIL_BYTES);
    // Attaching a `data` listener puts the stream in flowing mode → continuously
    // drained → no backpressure. Errors on the pipe are swallowed (a dead pipe is not
    // a turn outcome). unref the pipes so they never keep the operator alive.
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    // unref the pipe sockets so they never keep the operator's loop alive on the child
    // (Readable doesn't type `unref`, but the socket-backed stdio pipes have it).
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      try {
        onExit({ exitCode: code, signal, stdoutTail: out.value(), stderrTail: err.value() });
      } catch {
        /* the outcome observer must NEVER throw back into the spawn path */
      }
    };
    // 'close' = stdio fully flushed (complete tails). 'error' (post-pid failure) →
    // settle as a death. Best-effort: a missed exit degrades to the reconcile stuck-park
    // backstop (≥30min), exactly as today.
    child.on('close', (code, signal) => settle(code, signal));
    child.on('error', () => settle(null, null));
  }
  child.unref();
  return child.pid ?? null;
}

const RESUMABLE_AGENT_BINS = new Set(['claude', 'codex', 'omp']);

/** Resolve a headless-resume backend without changing arbitrary subprocesses. */
export function resolveResumeSpawnBin(bin: string): string {
  if (!RESUMABLE_AGENT_BINS.has(bin)) return bin;
  return resolveAgentBinarySync(bin) ?? bin;
}

// ── WI-10002854: one live process per session ─────────────────────────────
//
// A `resume-headless` turn used to be invisible after spawn. It had no task-ledger
// row, and its pid never reached the adv-session row, so the row kept the pid of
// the process that had just died. The next wake therefore read the session as
// dead and could resume it a second time while the first turn was still running.
// A terminal relaunch could do the same. On 2026-09-24 that produced two live
// processes on one coord identity, and only one of them showed in presence.

/**
 * Whether `argv` is a HEADLESS one-turn resume of `resumeId`, in any of the
 * shapes resumeCommandFor emits: claude `--resume <id> -p`, omp `-r <id> … -p`,
 * or codex `exec resume <id>`. The id must be a whole argv token. Pure, so the
 * park guard is testable without a live process.
 */
export function isHeadlessResumeArgv(argv: readonly string[], resumeId: string): boolean {
  if (!resumeId || !argv.includes(resumeId)) return false;
  if (argv.includes('-p') || argv.includes('--print')) return true;
  return argv.includes('exec') && argv.includes('resume');
}

/** Default oracle: read the live pid's argv from `/proc`. Anything unreadable
 *  (the pid is gone, or the host has no `/proc`) answers false, which keeps the
 *  existing liveness ladder unchanged. */
export function defaultIsHeadlessResumeTurn(pid: number, resumeId: string | null): boolean {
  if (!resumeId || !Number.isInteger(pid) || pid <= 0) return false;
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false;
  }
  const argv = raw.split('\0').filter((a) => a.length > 0);
  return isHeadlessResumeArgv(argv, resumeId);
}

/** Argv as stored on the ledger row. Leaves out two things: the `--settings`
 *  payload, because the account route puts ANTHROPIC_AUTH_TOKEN in it, and the
 *  wake text, which can be large and is already on the delivery row. */
export function ledgerSafeResumeArgv(bin: string, args: readonly string[], wakeText: string): string[] {
  const out: string[] = [bin];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--settings' && i + 1 < args.length) {
      out.push(a, '<redacted>');
      i++;
    } else if (a.startsWith('--settings=')) {
      out.push('--settings=<redacted>');
    } else if (a === wakeText) {
      out.push(`<wake-text ${a.length} chars>`);
    } else {
      out.push(a.length > 200 ? `${a.slice(0, 200)}…` : a);
    }
  }
  return out;
}

export interface HeadlessResumeTurnInput {
  pid: number;
  advSessionId: number;
  /** The row's own workspace. The await plane is pinned to the coord workspace,
   *  so the ambient id cannot be trusted to scope this write. */
  sessionWorkspaceId: string | null;
  /** The coordination workspace, which the delivery carries. */
  deliveryWorkspaceId: string;
  coordOwnerId: string;
  /** Nullable, as on the handle: a legacy row may not record its backend. */
  agent: string | null;
  resumeId: string | null;
  cwd: string;
  argv: string[];
}

export interface HeadlessResumeTurnAccounting {
  /** Resolves once the pid has been written to the adv-session row. The spawn is
   *  never blocked on this write. */
  pidRecorded: Promise<void>;
  /** Close the ledger row when the child exits. Safe to call more than once. */
  finish: (exit: ResumeTurnExitRaw) => void;
}

/**
 * Record a spawned resume-headless turn in two places: a task-ledger row, which
 * gives `processes:list` provenance and makes `processes:kill { taskId }` work,
 * and the pid on its adv-session row, which the next wake and every relaunch read
 * for liveness.
 *
 * `confine:false` keeps the spawn byte-identical: the recorded pid is the agent
 * CLI itself and not a systemd-run client, so the pid write and the exit tails
 * both describe the real turn. The trade-off: the turn stays in the spawner's
 * cgroup and does not get the EI-9748 escape, so it does not survive a bg-host
 * restart.
 */
export function defaultAccountHeadlessResumeTurn(input: HeadlessResumeTurnInput): HeadlessResumeTurnAccounting {
  const enrolment = beginSyncEnrolment({ class: 'agent-session' }, { confine: false });
  completeSyncEnrolment(
    enrolment,
    {
      class: 'agent-session',
      title: `wake resume (headless): ${input.coordOwnerId}`,
      argv: input.argv,
      cwd: input.cwd,
      launchedBy: 'wake-executor:resume-headless',
      sessionId: input.resumeId,
      detail: {
        launchSurface: 'wake-resume-headless',
        coordOwnerId: input.coordOwnerId,
        advSessionId: input.advSessionId,
        agent: input.agent,
      },
    },
    input.pid,
    { workspaceId: input.sessionWorkspaceId ?? input.deliveryWorkspaceId },
  );
  // WI-10005725: a resume-headless turn has no psu launcher, so no supervisor
  // beat ever reports its pid. Without this stamp the presence row keeps the
  // DEAD launcher pid of the session being resumed, the liveness oracle's ESRCH
  // probe outranks the turn's own fresh activity, and the working turn reads
  // `ended` (a goal-holder respawner then replaces it). Stamp the child's
  // pid/host so the probe describes the process actually running; once the
  // child exits, the same probe correctly reads it gone. Best-effort like the
  // adv write: the spawn never waits on it, a failure never rejects
  // `pidRecorded`, and touchHeartbeat is a no-op without a presence row.
  const presenceStamped = touchHeartbeat(input.coordOwnerId, {
    pid: input.pid,
    host: hostname(),
  }).catch(() => undefined);
  let finished = false;
  return {
    pidRecorded: Promise.all([
      setAdvSessionPid(input.advSessionId, input.pid, undefined, input.sessionWorkspaceId),
      presenceStamped,
    ]).then(() => undefined),
    finish: (exit) => {
      if (finished) return;
      finished = true;
      finishSyncEnrolment(enrolment, {
        state: exit.signal ? 'killed' : 'exited',
        exitCode: exit.exitCode,
        exitReason: exit.signal ?? null,
      });
    },
  };
}

/** A codex rollout filename ends `…-<uuid>.jsonl`; the trailing UUID is the
 *  conversation id `codex exec resume <uuid>` wants. */
const CODEX_ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_HISTORY_TAIL_BYTES = 1024 * 1024;

/**
 * Codex 0.144+ may persist the live thread in state_5.sqlite and remove the
 * rollout JSONL while keeping a bounded prompt history. Each history row is
 * stamped with the native `session_id`, which is exactly the id accepted by
 * `codex exec resume`. Read only the tail so a long-running session never puts
 * its whole history on the wake hot path.
 */
function findCodexHistorySessionId(codexHome: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(join(codexHome, 'history.jsonl'), 'r');
    const total = fstatSync(fd).size;
    const size = Math.min(total, CODEX_HISTORY_TAIL_BYTES);
    if (size <= 0) return null;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, total - size);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]?.trim()) continue;
      try {
        const row = JSON.parse(lines[i]) as { session_id?: unknown };
        if (typeof row.session_id === 'string' && CODEX_SESSION_UUID_RE.test(row.session_id)) {
          return row.session_id;
        }
      } catch {
        // The bounded tail may begin in the middle of a JSON line.
      }
    }
  } catch {
    // Absent/raced history is the normal pre-0.144 or not-yet-started case.
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close on a read-only diagnostic path.
      }
    }
  }
  return null;
}

/**
 * Recover a codex session's conversation UUID from its per-session CODEX_HOME —
 * the newest `<home>/sessions/**​/rollout-*-<uuid>.jsonl` (turn-lifecycle-control
 * P-009). codex doesn't take a forced `--session-id`, so tracked rows carry no
 * native id; recovering it lets a wake `resume <uuid> <prompt>` resolve EXACTLY
 * this session with two positionals — avoiding the `resume --last <prompt>`
 * clap ambiguity where the prompt would be read as the session id. null if none.
 */
export function findCodexRolloutSessionId(codexHome: string): string | null {
  type RolloutMatch = { id: string; mtime: number };
  let best: RolloutMatch | null = null;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const m = e.name.match(CODEX_ROLLOUT_UUID_RE);
      if (!m) continue;
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        /* ignore */
      }
      if (!best || mtime > best.mtime) best = { id: m[1], mtime };
    }
  };
  walk(join(codexHome, 'sessions'));
  return (best as RolloutMatch | null)?.id ?? findCodexHistorySessionId(codexHome);
}

/** The per-session CODEX_HOME bootstrap-su/psu minted for a tracked codex
 *  session, keyed by the adv-session row id (`writeSuCodexHome`). Delegates to
 *  the ONE shared key helper so launch + resume never drift (unify-launch-mechanics
 *  P-004). */
export function codexHomeForAdvSession(advSessionId: number): string {
  return codexHomeForSessionKey(advSessionId);
}

type CodexRepairSessionRow = Parameters<typeof fallbackCodexLaunchSpecFromAdvSession>[0];

export interface EnsureCodexHomeForWakeInput {
  advSessionId: number;
  owner: string;
  codexHome: string;
  /** Channel-2 wake resumes are detached/headless and must retain that config policy. */
  headless: true;
  sessionRow?: CodexRepairSessionRow | null;
  /** The launcher passes this when the rollout is bound to the gateway provider. */
  requireGatewayProvider?: boolean;
}

export type EnsureCodexHomeForWakeResult = {
  ok: boolean;
  repaired?: boolean;
  reason?: string;
};

/**
 * Repair the existing per-session Codex home using the same launch inputs as
 * POST /adv/sessions/ensure-codex-home. This is deliberately a lazy/default
 * dependency: wake-executor's unit tests can inject a filesystem-only seam, and
 * a live wake does not load the launch-spec/PG graph until it actually needs a
 * Codex resume. `ensureSuCodexHomeConfig` only rewrites managed files in an
 * existing home, so the rollout restored by the archive leg remains intact.
 */
async function defaultEnsureCodexHomeForWake(
  input: EnsureCodexHomeForWakeInput,
): Promise<EnsureCodexHomeForWakeResult> {
  try {
    const [
      { readSuLaunchSpecByOwner },
      { parseSuLaunchSpecRecord },
      { buildLaunchSpec },
      { ensureSuCodexHomeConfig },
      { readSuperuserToken },
    ] = await Promise.all([
      import('../../adv-sessions'),
      import('../../su-persona-render'),
      import('../../role-launch-spec'),
      import('../../role-codex-home'),
      import('../../superuser-token'),
    ]);
    const persistedRecord = parseSuLaunchSpecRecord(await readSuLaunchSpecByOwner(input.owner));
    const record =
      persistedRecord ??
      fallbackCodexLaunchSpecFromAdvSession(
        input.sessionRow ?? (await getAdvSession(input.advSessionId).catch(() => null)),
        input.owner,
      );
    if (!record) return { ok: true, repaired: false, reason: 'no-launch-spec' };
    if (record.agent !== 'codex') return { ok: true, repaired: false, reason: 'unsupported-agent' };

    const operatorBaseUrl =
      resolveInheritedOperatorBaseUrl(process.env.PAPERCUSP_OPERATOR_URL) ||
      `http://localhost:${process.env.PAPERCUSP_HONO_PORT ?? '3070'}`;
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'codex',
      workspaceId: record.workspaceId,
      operatorBaseUrl,
      harnessSlug: record.harnessSlug,
      profile: record.profile,
      contextSize: record.contextSize,
      personaTier: record.personaTier,
      model: record.model,
      planSlug: record.planSlug,
    });
    return {
      ok: true,
      ...ensureSuCodexHomeConfig({
        sessionKey: input.advSessionId,
        mcpUrl: spec.mcpUrl,
        sid: input.owner,
        model: record.model,
        token: readSuperuserToken(),
        codexGatewayAuto: input.requireGatewayProvider === true,
        codexGatewayPriority: input.requireGatewayProvider === true ? 'su' : null,
        headless: input.headless,
        trustDir: null,
        projectDir: input.sessionRow?.cwd,
      }),
    };
  } catch (err) {
    // A repair failure must not turn a recoverable rollout into a dropped wake;
    // the exact UUID check below remains the authoritative resume safety gate.
    console.warn(`[wake-executor] codex home repair failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, repaired: false, reason: 'repair-failed' };
  }
}

/** Whether a (possibly coalesced) delivery payload carries a timeout fire.
 *  A plain timeout fire is `{ timeout: true }` (engine.ts sweeper). A COALESCED
 *  wake replaces that headline with `{ coalesced, count, events, latest }`
 *  (engine.ts coalesceDeliveries), so the raw `payload.timeout` is gone — look
 *  inside the union (the latest fire AND any folded event) or the marker would be
 *  silently dropped and the agent told the event FIRED when it actually TIMED OUT. */
/** WI-3940: default upper bound on each rematerialize-on-miss PG call in the
 *  wake resume leg. Generous for a healthy restore (a 2.6MB session restores
 *  in well under a second) while bounding the WI-2009 wedged-connection class. */
export const REMATERIALIZE_TIMEOUT_MS = 30_000;

/** WI-3940: race a wake-hot-path promise against a timer. Resolves the value,
 *  or `null` on TIMEOUT or REJECTION (both logged) — never throws, never
 *  hangs. The rematerialize seams are fail-soft on rejection, but a wedged PG
 *  connection HANGS past every try/catch; this is what actually bounds the
 *  wake pipeline. The timer is unref'd so it never holds the process open;
 *  the underlying promise is abandoned on expiry, not cancelled. */
export function withWakeTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[wake-executor] ${label} timed out after ${ms}ms — proceeding without it (WI-3940)`);
      resolve(null);
    }, ms);
    t.unref?.();
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        console.warn(`[wake-executor] ${label} failed: ${(e as Error)?.message ?? e}`);
        resolve(null);
      },
    );
  });
}

/** The per-agent inbox-wake key prefix (`coord:inbox-wake:<owner>`). Kept in
 *  lockstep with the canonical export in agent-tools/coordination/inbox-wake.ts —
 *  duplicated (not imported) ONLY to avoid the wake-executor → inbox-wake →
 *  engine → wake-executor import cycle (engine.ts imports THIS module; inbox-wake
 *  imports engine). Same "two owners, one string, in lockstep" pattern as
 *  TURN_SUBMIT_CR_DELAY_MS above. */
const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';
/**
 * EI-21555327100993502: fleet claim-release wakes are emitted when an item is
 * returned to the pool, but the delivery can sit behind a gate/retry long
 * enough for another agent to claim that item again. Re-check the item at the
 * actual delivery boundary before re-invoking the fleet leader.
 */
const FLEET_CLAIM_RELEASED_PREFIX = 'fleet:claim-released:';
const FLEET_CLAIM_RELEASED_LOOKUP_TIMEOUT_MS = 1_000;
const WORK_ITEM_CLAIMABLE_KEY = 'work-item:claimable';
const CLAIMABLE_LOOKUP_TIMEOUT_MS = 1_000;
/**
 * EI-22449230917085417: a grant wake can sit in the delivery queue after the
 * owner has used and released the lock. Re-check the lock at the actual wake
 * boundary so a late grant cannot re-invoke a session for a lock it no longer
 * holds.
 */
const LOCK_GRANT_PREFIX = 'lock:grant:';
const LOCK_GRANT_OWNERSHIP_LOOKUP_TIMEOUT_MS = 1_000;

type LockGrantPayload = { lockId: string };

/** Parse only the positive grant shape. Terminal no-grant wakes remain useful
 * notifications and malformed payloads fail open to the normal wake ladder. */
function parseLockGrantPayload(payload: unknown): LockGrantPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as { granted?: unknown; lock_id?: unknown };
  if (record.granted !== true || typeof record.lock_id !== 'string' || record.lock_id.trim().length === 0) {
    return null;
  }
  return { lockId: record.lock_id };
}

/** Read the live lock table through the existing cross-domain diagnostic queue
 * read. The owner id is globally unique, while a domain is checkout-specific;
 * reading all domains avoids declaring a valid grant stale from the wrong tree. */
async function readCurrentLockGrantOwnership(ownerId: string, lockId: string): Promise<boolean> {
  const { getTxPool, readQueue } = await import('../../agent-tools/locks/su-lock-store');
  const queue = await readQueue(getTxPool(), {
    coordinationDomain: null,
    owner: ownerId,
  });
  return queue.active_locks.some((lock) => lock.lock_id === lockId);
}

/** Confirmed stale only when the ownership read resolves false. Missing,
 * malformed, rejected, or timed-out reads preserve the wake (fail-open). */
async function currentLockGrantIsStale(
  d: DeliveryWork,
  readOwnership: (ownerId: string, lockId: string) => Promise<boolean | null>,
  timeoutMs: number,
): Promise<{ stale: boolean; lockId: string | null }> {
  if (!d.eventKey.startsWith(LOCK_GRANT_PREFIX)) return { stale: false, lockId: null };
  const parsed = parseLockGrantPayload(d.payload);
  if (!parsed) return { stale: false, lockId: null };
  const owned = await withWakeTimeout(
    Promise.resolve().then(() => readOwnership(d.subscriberId, parsed.lockId)),
    `lock grant ownership revalidation/${parsed.lockId}`,
    Math.max(1, timeoutMs),
  );
  return { stale: owned === false, lockId: parsed.lockId };
}

type FleetClaimReleasedPayload = {
  id: string;
  harness?: string;
};

/** Parse only the payload shape needed by the delivery-time claim check. */
function parseFleetClaimReleasedPayload(payload: unknown): FleetClaimReleasedPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as { id?: unknown; harness?: unknown };
  if (typeof record.id !== 'string' || record.id.trim().length === 0) return null;
  if (record.harness !== undefined && record.harness !== null && typeof record.harness !== 'string') return null;
  return {
    id: record.id,
    ...(typeof record.harness === 'string' ? { harness: record.harness } : {}),
  };
}

/**
 * Read the current claim for a fleet-scoped release wake. Every uncertain result
 * is deliberately `null`: a missing/malformed payload, a missing item, a
 * rejected lookup, or a timeout must preserve the normal wake rather than
 * silently strand it. The timeout bounds a wedged PG connection on this hot
 * delivery path.
 */
async function currentFleetClaimReleasedItem(
  d: DeliveryWork,
  lookup: typeof getWorkItem,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof getWorkItem>> | null> {
  if (!d.eventKey.startsWith(FLEET_CLAIM_RELEASED_PREFIX) || d.eventKey.length <= FLEET_CLAIM_RELEASED_PREFIX.length) {
    return null;
  }
  const parsed = parseFleetClaimReleasedPayload(d.payload);
  if (!parsed) return null;
  try {
    return await withWakeTimeout(
      Promise.resolve().then(() => lookup(parsed.id, parsed.harness)),
      `fleet claim-release lookup/${parsed.id}`,
      Math.max(1, timeoutMs),
    );
  } catch {
    // Fail open even if an injected lookup violates the Promise contract.
    return null;
  }
}

/**
 * EI-21901188813309549: `fleet:member-dead:<slug>` (and its `context-critical`
 * sibling, sharing the same emitter) assert a PRESENT-TENSE transition —
 * `{fleetSlug,agentId,transition:'member-dead',from,to:'ended'}` — captured once
 * at emit time in fleet-transition-events.ts's `emitFleetTransitionEdge`, which
 * DOES revalidate against the current roster before its own first `emit()` call.
 *
 * That revalidation runs exactly ONCE. If the resulting delivery then parks
 * behind an unconfirmed psu-host turn-start proof (`injectPsuHostWake`'s
 * "delivery accepted before turn-start proof; retry remains durable" park
 * reason), the store's normal parked-row recheck retries the SAME frozen
 * delivery — re-injecting the identical stale DEAD assertion, with no
 * re-validation, for as long as the park persists. Measured: 7 identical
 * deliveries over ~30 minutes for a member that was live the entire time
 * (EI-21901188813309549's filing; EI-21634342529334849 independently confirms
 * a stale delivery landing well after the emit-time check passed).
 *
 * Re-run the SAME shared liveness oracle at the delivery boundary — the exact
 * discipline `currentFleetClaimReleasedItem` / `revalidateClaimableDelivery`
 * already apply to `fleet:claim-released:*` / `work-item:claimable`. Only a
 * POSITIVE non-'ended' current reading counts as stale; a missing/malformed
 * payload, an unmatched event key, or an unknown/degraded oracle read all
 * preserve the original wake (fail-open — a transient PG hiccup must never
 * silently swallow a real death).
 */
const FLEET_MEMBER_DEAD_PREFIX = 'fleet:member-dead:';
const FLEET_MEMBER_DEAD_LOOKUP_TIMEOUT_MS = 1_000;

type FleetMemberDeadPayload = { fleetSlug: string; agentId: string };

/** Parse only the payload shape needed by the delivery-time member-dead check. */
function parseFleetMemberDeadPayload(payload: unknown): FleetMemberDeadPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as { fleetSlug?: unknown; agentId?: unknown; transition?: unknown };
  if (record.transition !== 'member-dead') return null;
  if (typeof record.fleetSlug !== 'string' || record.fleetSlug.trim().length === 0) return null;
  if (typeof record.agentId !== 'string' || record.agentId.trim().length === 0) return null;
  return { fleetSlug: record.fleetSlug, agentId: record.agentId };
}

/**
 * Whether a parked/retried `fleet:member-dead:*` delivery's asserted DEAD
 * transition no longer holds. Deliberately mirrors
 * fleet-transition-events.ts's CONFIRMED_DEAD_SESSION_STATES: only
 * `sessionState !== 'ended'` on a KNOWN current reading counts as stale.
 */
async function currentFleetMemberDeadIsStale(
  d: DeliveryWork,
  resolveStates: typeof resolveSessionStates,
  timeoutMs: number,
): Promise<{ stale: boolean; currentState: string | null }> {
  if (!d.eventKey.startsWith(FLEET_MEMBER_DEAD_PREFIX) || d.eventKey.length <= FLEET_MEMBER_DEAD_PREFIX.length) {
    return { stale: false, currentState: null };
  }
  const parsed = parseFleetMemberDeadPayload(d.payload);
  if (!parsed) return { stale: false, currentState: null };
  try {
    const verdicts = await withWakeTimeout(
      Promise.resolve().then(() => resolveStates([{ ownerId: parsed.agentId }], { hydratePerId: true })),
      `fleet member-dead revalidation/${parsed.agentId}`,
      Math.max(1, timeoutMs),
    );
    const verdict = verdicts?.get(parsed.agentId);
    if (!verdict || verdict.sessionState == null) return { stale: false, currentState: null }; // unknown → preserve
    return { stale: verdict.sessionState !== 'ended', currentState: verdict.sessionState };
  } catch {
    // Fail open even if an injected resolver violates the Promise contract.
    return { stale: false, currentState: null };
  }
}

/**
 * EI-220670: `fleet:context-critical:*` carries a fire-time pressure snapshot.
 * A parked/retried delivery can outlive both the pressure bucket and the
 * member's context generation, so the snapshot must be checked again at the
 * actual wake boundary. Unknown reads deliberately preserve the wake.
 */
const FLEET_CONTEXT_CRITICAL_PREFIX = 'fleet:context-critical:';
const FLEET_CONTEXT_CRITICAL_LOOKUP_TIMEOUT_MS = 1_000;

type FleetContextCriticalPayload = {
  fleetSlug: string;
  agentId: string;
  contextEpoch: number | null;
};

function parseFleetContextCriticalPayload(payload: unknown): FleetContextCriticalPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as {
    fleetSlug?: unknown;
    agentId?: unknown;
    transition?: unknown;
    contextEpoch?: unknown;
  };
  if (record.transition !== 'context-critical') return null;
  if (typeof record.fleetSlug !== 'string' || record.fleetSlug.trim().length === 0) return null;
  if (typeof record.agentId !== 'string' || record.agentId.trim().length === 0) return null;
  const contextEpoch =
    typeof record.contextEpoch === 'number' && Number.isSafeInteger(record.contextEpoch) && record.contextEpoch >= 0
      ? record.contextEpoch
      : null;
  return { fleetSlug: record.fleetSlug, agentId: record.agentId, contextEpoch };
}

type FleetContextCriticalFreshness = {
  stale: boolean;
  currentPressure: ContextPressureBucket | null;
  currentEpoch: number | null;
};

async function currentFleetContextCriticalIsStale(
  d: DeliveryWork,
  getCurrentPressure: (agentId: string) => Promise<ContextPressureBucket | null>,
  getCurrentEpoch: (agentId: string) => Promise<number | null>,
  timeoutMs: number,
): Promise<FleetContextCriticalFreshness> {
  if (!d.eventKey.startsWith(FLEET_CONTEXT_CRITICAL_PREFIX) || d.eventKey.length <= FLEET_CONTEXT_CRITICAL_PREFIX.length) {
    return { stale: false, currentPressure: null, currentEpoch: null };
  }
  const parsed = parseFleetContextCriticalPayload(d.payload);
  if (!parsed) return { stale: false, currentPressure: null, currentEpoch: null };

  const [pressureRead, epochRead] = await Promise.all([
    withWakeTimeout(
      Promise.resolve().then(() => getCurrentPressure(parsed.agentId)),
      `fleet context-critical pressure/${parsed.agentId}`,
      Math.max(1, timeoutMs),
    ),
    parsed.contextEpoch === null
      ? Promise.resolve(null)
      : withWakeTimeout(
          Promise.resolve().then(() => getCurrentEpoch(parsed.agentId)),
          `fleet context-critical generation/${parsed.agentId}`,
          Math.max(1, timeoutMs),
        ),
  ]);
  const currentPressure =
    pressureRead === 'ok' || pressureRead === 'high' || pressureRead === 'critical' ? pressureRead : null;
  const currentEpoch =
    typeof epochRead === 'number' && Number.isSafeInteger(epochRead) && epochRead >= 0 ? epochRead : null;
  const pressureStale = currentPressure !== null && currentPressure !== 'critical';
  const generationStale =
    parsed.contextEpoch !== null && currentEpoch !== null && currentEpoch > parsed.contextEpoch;
  return { stale: pressureStale || generationStale, currentPressure, currentEpoch };
}

type CoalescedDeliveryEvent = {
  event?: unknown;
  summary?: unknown;
  payload?: unknown;
  delivery_id?: unknown;
  createdAt?: unknown;
};

type ClaimableDeliveryComponent = {
  payload: unknown;
  eventIndex: number | null;
};

type ClaimableDeliveryFreshness = {
  delivery: DeliveryWork;
  staleOnly: boolean;
  staleIds: string[];
};

type BlockedBoundDeliveryComponent = {
  itemId: string;
  eventIndex: number | null;
};

type BlockedBoundDeliveryFreshness = {
  delivery: DeliveryWork;
  staleOnly: boolean;
  staleIds: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Find canonical claimable-event components in either a plain or coalesced wake. */
function claimableDeliveryComponents(d: DeliveryWork): ClaimableDeliveryComponent[] {
  if (d.eventKey === WORK_ITEM_CLAIMABLE_KEY && !(isRecord(d.payload) && d.payload.coalesced === true)) {
    return [{ payload: d.payload, eventIndex: null }];
  }

  if (!isRecord(d.payload) || d.payload.coalesced !== true) return [];
  if (Array.isArray(d.payload.events)) {
    return d.payload.events.flatMap((event, eventIndex) => {
      if (!isRecord(event) || event.event !== WORK_ITEM_CLAIMABLE_KEY) return [];
      return [{ payload: event.payload, eventIndex }];
    });
  }

  // Compatibility with envelopes written before `events[]` was added.
  if (isRecord(d.payload.latest) && d.payload.latest.event === WORK_ITEM_CLAIMABLE_KEY) {
    return [{ payload: d.payload.latest.payload, eventIndex: null }];
  }
  return [];
}

function currentWorkItemIsClaimable(item: Awaited<ReturnType<typeof getWorkItem>>): boolean {
  if (!item || item.assignee || isSettledWorkItemState(item.state)) return false;
  if (!CLAIM_STATES_ALLOWLIST.includes(item.state as (typeof CLAIM_STATES_ALLOWLIST)[number])) return false;
  return !isClaimHoldParked(item.payload);
}

function deliveryEventLabel(event: CoalescedDeliveryEvent): string {
  return typeof event.event === 'string' ? event.event : 'unknown event';
}

function deliveryEventSummary(event: CoalescedDeliveryEvent): string | null {
  return typeof event.summary === 'string' && event.summary.length > 0 ? event.summary : null;
}

function deliveryEventPayloadIsTimeout(event: CoalescedDeliveryEvent): boolean {
  return isRecord(event.payload) && event.payload.timeout === true;
}

/** Rebuild the coalesced headline after stale components are removed. */
function rebuildCoalescedDelivery(
  d: DeliveryWork,
  events: CoalescedDeliveryEvent[],
): DeliveryWork {
  const payload = d.payload as Record<string, unknown>;
  const latest = events[events.length - 1];
  const eventDeliveries = events.filter((event) => !deliveryEventPayloadIsTimeout(event));
  const timeoutDeliveries = events.filter((event) => deliveryEventPayloadIsTimeout(event));
  const plural = (count: number, singular: string): string => (count === 1 ? singular : `${singular}s`);
  const summaryParts: string[] = [];
  if (eventDeliveries.length > 0) {
    summaryParts.push(
      `${eventDeliveries.length} ${plural(eventDeliveries.length, 'event')} fired while you slept: ${eventDeliveries.map(deliveryEventLabel).join(', ')}`,
    );
  }
  if (timeoutDeliveries.length > 0) {
    summaryParts.push(
      `${timeoutDeliveries.length} ${plural(timeoutDeliveries.length, 'await deadline')} expired while you slept: ${timeoutDeliveries.map(deliveryEventLabel).join(', ')}`,
    );
  }

  const latestSummary = latest ? deliveryEventSummary(latest) : null;
  return {
    ...d,
    eventKey: latest ? deliveryEventLabel(latest) : d.eventKey,
    summary: summaryParts.join('; ') + (latestSummary ? ` — latest: ${latestSummary}` : ''),
    payload: {
      ...payload,
      count: events.length,
      eventCount: eventDeliveries.length,
      timeoutCount: timeoutDeliveries.length,
      events,
      latest: latest
        ? {
            event: deliveryEventLabel(latest),
            payload: latest.payload,
            createdAt: latest.createdAt,
            delivery_id: latest.delivery_id,
          }
        : undefined,
    },
    coalescedCount: events.length,
  };
}

/**
 * Revalidate canonical claimable wakes at the delivery boundary. The event payload is
 * a fire-time snapshot and can outlive the item returning to a claimed/terminal/held
 * state while the delivery waits behind a gate. Unknown reads deliberately preserve
 * the original wake (fail-open); only a confirmed non-claimable current row is stale.
 */
async function revalidateClaimableDelivery(
  d: DeliveryWork,
  lookup: typeof getWorkItem,
  timeoutMs: number,
): Promise<ClaimableDeliveryFreshness> {
  const components = claimableDeliveryComponents(d);
  if (components.length === 0) return { delivery: d, staleOnly: false, staleIds: [] };

  const freshnessByRef = new Map<string, Promise<boolean | null>>();
  const staleEventIndexes = new Set<number>();
  const staleIds = new Set<string>();

  const check = (payload: unknown): Promise<boolean | null> => {
    const parsed = parseFleetClaimReleasedPayload(payload);
    if (!parsed) return Promise.resolve(false);
    const ref = `${parsed.harness ?? ''}:${parsed.id}`;
    const existing = freshnessByRef.get(ref);
    if (existing) return existing;
    const pending = withWakeTimeout(
      Promise.resolve().then(() => lookup(parsed.id, parsed.harness)),
      `claimable delivery lookup/${parsed.id}`,
      Math.max(1, timeoutMs),
    ).then((item) => {
      if (!item) return null;
      return !currentWorkItemIsClaimable(item);
    });
    freshnessByRef.set(ref, pending);
    return pending;
  };

  for (const component of components) {
    let stale = false;
    try {
      stale = (await check(component.payload)) === true;
    } catch {
      // An injected/non-conforming lookup must remain fail-open like the real read.
      stale = false;
    }
    if (!stale) continue;
    const parsed = parseFleetClaimReleasedPayload(component.payload);
    if (parsed) staleIds.add(parsed.id);
    if (component.eventIndex != null) staleEventIndexes.add(component.eventIndex);
  }

  if (staleIds.size === 0) return { delivery: d, staleOnly: false, staleIds: [] };

  const coalescedPayload =
    isRecord(d.payload) && d.payload.coalesced === true && Array.isArray(d.payload.events) ? d.payload : null;
  if (!coalescedPayload) {
    const ids = [...staleIds].join(', ');
    return {
      delivery: {
        ...d,
        payload: null,
        summary: `${WORK_ITEM_CLAIMABLE_KEY} delivery is stale; ${ids} is no longer claimable`,
      },
      staleOnly: true,
      staleIds: [...staleIds],
    };
  }

  const coalescedEvents = coalescedPayload.events as unknown[];
  const remaining = coalescedEvents.filter(
    (_event: unknown, index: number) => !staleEventIndexes.has(index),
  ) as CoalescedDeliveryEvent[];
  if (remaining.length === 0) {
    const ids = [...staleIds].join(', ');
    return {
      delivery: {
        ...d,
        payload: null,
        summary: `${WORK_ITEM_CLAIMABLE_KEY} delivery is stale; ${ids} is no longer claimable`,
      },
      staleOnly: true,
      staleIds: [...staleIds],
    };
  }

  return {
    delivery: rebuildCoalescedDelivery(d, remaining),
    staleOnly: false,
    staleIds: [...staleIds],
  };
}

/** Find the blocked work-item lifecycle target stamped on an auto-armed wake. */
function blockedBoundWorkItemId(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.bound_to)) return null;
  const binding = payload.bound_to;
  if (binding.kind !== 'work-item-blocked' || typeof binding.ref !== 'string') return null;
  const ref = binding.ref.trim();
  return ref || null;
}

/** Preserve per-event binding provenance when the engine coalesced several wakes. */
function blockedBoundDeliveryComponents(d: DeliveryWork): BlockedBoundDeliveryComponent[] {
  if (isRecord(d.payload) && d.payload.coalesced === true && Array.isArray(d.payload.events)) {
    return d.payload.events.flatMap((raw, eventIndex) => {
      const itemId = isRecord(raw) ? blockedBoundWorkItemId(raw.payload) : null;
      return itemId ? [{ itemId, eventIndex }] : [];
    });
  }
  const itemId = blockedBoundWorkItemId(d.payload);
  return itemId ? [{ itemId, eventIndex: null }] : [];
}

/**
 * A fired one-shot may already have a queued delivery by the time its bound
 * work-item settles, so cancelling the await row alone cannot suppress it.
 * Re-read that lifecycle target at delivery time and remove only components
 * whose `work-item-blocked` target is confirmed terminal. Unreadable targets
 * stay fail-open so a transient store problem cannot swallow a live wake.
 */
async function revalidateBlockedBoundDelivery(
  d: DeliveryWork,
  lookup: typeof getWorkItem,
  timeoutMs: number,
): Promise<BlockedBoundDeliveryFreshness> {
  const components = blockedBoundDeliveryComponents(d);
  if (components.length === 0) return { delivery: d, staleOnly: false, staleIds: [] };

  const freshnessById = new Map<string, Promise<boolean | null>>();
  const staleEventIndexes = new Set<number>();
  const staleIds = new Set<string>();
  for (const component of components) {
    let terminal: boolean | null = null;
    try {
      let pending = freshnessById.get(component.itemId);
      if (!pending) {
        pending = withWakeTimeout(
          Promise.resolve().then(() => lookup(component.itemId)),
          `blocked-bound delivery lookup/${component.itemId}`,
          Math.max(1, timeoutMs),
        ).then((item) => (item ? isSettledWorkItemState(item.state) : null));
        freshnessById.set(component.itemId, pending);
      }
      terminal = await pending;
    } catch {
      // Unknown reads preserve the original wake, matching the other delivery gates.
      terminal = null;
    }
    if (terminal !== true) continue;
    staleIds.add(component.itemId);
    if (component.eventIndex != null) staleEventIndexes.add(component.eventIndex);
  }

  if (staleIds.size === 0) return { delivery: d, staleOnly: false, staleIds: [] };

  const ids = [...staleIds].join(', ');
  const coalescedPayload =
    isRecord(d.payload) && d.payload.coalesced === true && Array.isArray(d.payload.events) ? d.payload : null;
  if (!coalescedPayload) {
    return {
      delivery: {
        ...d,
        payload: null,
        summary: `work-item-blocked wake is stale; bound work-item(s) ${ids} are terminal`,
      },
      staleOnly: true,
      staleIds: [...staleIds],
    };
  }

  const events = coalescedPayload.events as unknown[];
  const remaining = events.filter((_event, index) => !staleEventIndexes.has(index)) as CoalescedDeliveryEvent[];
  if (remaining.length === 0) {
    return {
      delivery: {
        ...d,
        payload: null,
        summary: `work-item-blocked wake is stale; bound work-item(s) ${ids} are terminal`,
      },
      staleOnly: true,
      staleIds: [...staleIds],
    };
  }

  return {
    delivery: rebuildCoalescedDelivery(d, remaining),
    staleOnly: false,
    staleIds: [...staleIds],
  };
}

type LoopDeliveryMarker = {
  marker: ColdLoopMarker;
  /** The source delivery's timestamp. Absent on a non-coalesced payload. */
  createdAt?: string;
};

/**
 * Read loop-fire markers from either a plain delivery or a coalesced union.
 *
 * Coalescing replaces the headline payload with an envelope, so inspecting only
 * `d.payload` loses a loop marker carried by an older sibling. The union keeps
 * the original payloads and (now) their creation timestamps; enumerate every
 * marker so lifecycle checks can reject any stale loop fire in the group.
 */
function readLoopDeliveryMarkers(payload: unknown): LoopDeliveryMarker[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as {
    coalesced?: unknown;
    events?: unknown;
    latest?: unknown;
  };

  if (record.coalesced === true) {
    const markers: LoopDeliveryMarker[] = [];
    if (Array.isArray(record.events)) {
      for (const event of record.events) {
        if (!event || typeof event !== 'object') continue;
        const entry = event as { payload?: unknown; createdAt?: unknown };
        const marker = readColdLoopMarker(entry.payload);
        if (!marker) continue;
        markers.push({
          marker,
          ...(typeof entry.createdAt === 'string' ? { createdAt: entry.createdAt } : {}),
        });
      }
    }
    if (markers.length > 0) return markers;

    // Keep compatibility with an envelope produced before `events[].createdAt`
    // was added, or with a hand-authored latest-only payload.
    if (record.latest && typeof record.latest === 'object') {
      const latest = record.latest as { payload?: unknown; createdAt?: unknown };
      const marker = readColdLoopMarker(latest.payload);
      if (marker) {
        return [
          {
            marker,
            ...(typeof latest.createdAt === 'string' ? { createdAt: latest.createdAt } : {}),
          },
        ];
      }
    }
    return [];
  }

  const marker = readColdLoopMarker(payload);
  return marker ? [{ marker }] : [];
}

/** The newest loop marker in a delivery, used by text/provenance/channel paths. */
function readLoopDeliveryMarker(payload: unknown): ColdLoopMarker | null {
  const markers = readLoopDeliveryMarkers(payload);
  return markers.length > 0 ? markers[markers.length - 1].marker : null;
}

function readLatestLoopDeliveryMarker(payload: unknown): LoopDeliveryMarker | null {
  const markers = readLoopDeliveryMarkers(payload);
  return markers.length > 0 ? markers[markers.length - 1] : null;
}

/**
 * EI-21393930883750326: whether the delivery carries any NON-loop component —
 * a one-shot await-event fire, a timeout fire, an inbox wake — that owns the
 * wake independently of the loop lifecycle. Coalescing folds sibling
 * deliveries into ONE attempt, so a stale loop fire can ride beside a live
 * await-event fire; dropping the whole attempt on the loop's supersession
 * silently strands the waiter (observed live: await 93491 on
 * work-item:claimable fired, but delivery #166616 was dropped wholesale
 * because a folded loop fire post-dated loop:end — the member parked per the
 * documented await → loop:end protocol was never re-woken). Composition
 * decides the drop: only a PURELY-loop attempt may be suppressed wholesale.
 *
 * Enumeration mirrors readLoopDeliveryMarkers exactly: events[] when the
 * envelope carries them, the latest-only compat headline otherwise, the plain
 * payload when not coalesced. A component is non-loop when readColdLoopMarker
 * finds no loop marker on it (bare event `harness` metadata is already NOT a
 * marker — see readColdLoopMarker's pairing rule).
 */
function deliveryHasNonLoopComponent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true; // no marker possible ⇒ non-loop
  const record = payload as { coalesced?: unknown; events?: unknown; latest?: unknown };
  if (record.coalesced === true) {
    if (Array.isArray(record.events) && record.events.length > 0) {
      return record.events.some((event) => {
        if (!event || typeof event !== 'object') return true;
        return readColdLoopMarker((event as { payload?: unknown }).payload) === null;
      });
    }
    // Compat with a pre-events[] envelope / hand-authored latest-only payload:
    // judge composition by the same headline the marker read falls back to.
    if (record.latest && typeof record.latest === 'object') {
      return readColdLoopMarker((record.latest as { payload?: unknown }).payload) === null;
    }
    return true;
  }
  return readColdLoopMarker(payload) === null;
}

/** Compose the single-line wake turn injected/submitted into the woken session. */
export function wakeTurnText(d: DeliveryWork): string {
  // EI-20130618357432548 — the owner's own chat-pane message is delivered AS the
  // turn, not wrapped in the machinery below. The wrapper is right for every
  // agent/system wake (it names the key, the delivery id and the reconcile rule),
  // and wrong for exactly this one case: the chat pane renders the agent's
  // transcript back to the owner, so the wrapper is what the OWNER ends up
  // reading in place of their own message — and its text is what defeated the
  // pane's echo absorption. Gated on the marker the authenticated owner-GUI send
  // path stamps (owner-chat-turn.ts); the same payload-marker gate the
  // inbox-owner-reply path already uses at tagWakeText below. Every other
  // delivery is byte-identical.
  const ownerChatText = readOwnerChatTurnText(d.payload);
  if (ownerChatText) return ownerChatTurnText(ownerChatText);

  const note = d.note ? ` (your note: ${d.note})` : '';
  const summary = d.summary ? ` — ${d.summary}` : '';
  const payload = d.payload != null ? ` payload: ${JSON.stringify(d.payload).slice(0, 400)}` : '';
  // EI-21925527092611786: stamp the delivery's OWN await_id (the event_wake_deliveries
  // row's await_id column — always populated, independent of payload shape) so a stale/
  // delayed re-delivery of an earlier, already-retired timeout is mechanically
  // distinguishable from one about the CURRENTLY live registration on the same key,
  // instead of forcing a second events:status round-trip to tell them apart.
  const timeout = payloadIsTimeout(d.payload)
    ? ` [TIMEOUT (fired_reason: timeout, await_id: ${d.awaitId}) — the event did NOT fire before your deadline;` +
      ' the awaited source did NOT complete. If a re-arm on this key already created a NEWER await_id,' +
      ' cross-check events:status active_awaits before re-arming again — this delivery is only about' +
      ` await_id ${d.awaitId}]`
    : '';
  // EI-16648: an always-armed inbox-wake (`coord:inbox-wake:<owner>`) can be
  // CONSUMED late. A continuously-busy recipient's OWN periodic coord:inbox
  // polling may already have surfaced + acted on the quoted message before the
  // injected wake turn is drained from its CLI's input queue — a PUSH (wake
  // injection) vs PULL (the recipient's own inbox read) race, not a duplicate-row
  // or stale-pump bug (each delivery is distinct + fresh at fire time; the
  // staleness only emerges at consumption). Presenting the possibly-already-
  // handled `summary`/`payload` as fresh actionable work ("continue the work…")
  // then misleads the woken agent into re-doing handled mail. So for inbox-wake
  // keys ONLY, stamp a self-identifying reconciliation instruction (the EI-15799
  // precedent for the analogous stale cold-loop-wake delivery) — keep the quoted
  // body (useful when genuinely new) but tell the agent to reconcile against
  // coord:inbox before trusting it. The agent-facing inbox is a cursor-free
  // VIEW (D-013); only the delivery hook owns an internal floor. Every
  // non-inbox-wake key is byte-identical.
  const inboxWakeReconcile = d.eventKey.startsWith(COORD_INBOX_WAKE_PREFIX)
    ? " NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new."
    : '';
  // P-006 (fleet-member-dx, EI-9018): `d.id` is the DELIVERY-LOG row id, not a
  // wake count — unlabeled "wake #12672" next to a loop's own "wake #5" read as
  // two contradictory counters and confused resuming agents. Label it as an id.
  const base = (
    `[await-event] ${d.eventKey} fired${timeout}${summary}.${note}${payload} ` +
    `(event-wake delivery #${d.id} — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.)${inboxWakeReconcile}`
  ).replace(/\s*\n\s*/g, ' ');
  // Ambient-push rail (P-003) and the P-022 cell fold: prepared blocks ride the wake
  // injection. Appended AFTER the collapse so they keep their own line formatting;
  // both undefined on the default path ⇒ byte-identical. They then flow through
  // applyInjectionDoor. The cell fold goes FIRST: it re-answers the very value quoted
  // in `payload` above, so it belongs next to what it corrects, not below unrelated
  // ambient material.
  const blocks = [d.cellWakeFoldBlock, d.ambientPushBlock].filter((b): b is string => !!b);
  return blocks.length ? `${base}\n\n${blocks.join('\n\n')}` : base;
}

/**
 * EI-10935: a loop wake's `d.summary` (built by {@link wakeTurnText}, which embeds
 * loop-fire.ts's rendered checkpoint + walls block) is a SNAPSHOT taken at FIRE
 * time. If ACTUAL delivery is delayed — staged behind the manual wake-mode gate,
 * queued behind another delivery, retried after a missed inject, coalesced with a
 * later event — the agent may have written a NEWER `loop:checkpoint` (clearing an
 * owner-gated wall, updating its next-action) in the gap between fire and
 * delivery. The stale snapshot then RE-SERVES a CLEARED wall as still-open: a
 * live incident (2026-07-13) resurrected an irreversible-action wall the owner
 * had already cleared, risking either a re-run of the irreversible action or a
 * manufactured re-ask of consent already given. This is CRITICAL, not cosmetic —
 * walls exist precisely to survive context loss, and a wall surface that can't be
 * cleared is worse than none.
 *
 * Fix: at ACTUAL delivery time (inside `executeWake`, right before injection —
 * every channel: live psu-socket inject, plan-run resume, adv-session inject),
 * for a LOOP wake ONLY (`readColdLoopMarker` finds an explicit loop marker signal
 * and its optional `harness` scope — stamped for BOTH warm and cold loops per
 * loop-fire.ts), re-read the carry-note
 * FRESH and append a live re-check block. The block is appended EVEN WHEN walls
 * are now empty — silence there would NOT override a stale walls block rendered
 * above it, so "no open walls" must be stated explicitly, not omitted.
 *
 * A non-loop wake (marker null — the overwhelming majority of deliveries) is
 * BYTE-IDENTICAL: this returns `baseText` unchanged without ever reading the
 * carry-note store. Fail-soft end to end: any read/render error falls back to
 * the original text unmodified — a rehydration hiccup must never block or alter
 * a delivery that would otherwise have succeeded.
 *
 * EI-18825117783927950: the walls/checks re-read above fixes the CONTENT going
 * stale between fire and delivery, but not the loop's OWN lifecycle going stale
 * the same way — `loop:end` (or a re-arm) only stops *future* fires; a fire
 * already created and sitting gate-waited/queued when the owner ends (or
 * re-arms with a new goal) the loop still lands, carrying a FROZEN goal and the
 * imperative "this is the authority for what to do this wake" framing for a
 * loop that, by delivery time, no longer means that. Observed live: a session
 * called `loop:end`, was told "no further wakes will fire", and ~10min later
 * received exactly such a stale fire — avoided only by the receiving agent's
 * own suspicion. Since this function already runs at the true "about to
 * deliver" moment for every channel (live psu-socket inject, plan-run resume,
 * adv-session inject), it is the natural single choke point to ALSO re-check
 * the loop's current `active`/`armedAt` state and, if superseded, append an
 * unmissable banner stripping the stale imperative framing. `executeWake`
 * applies the terminal delivery gate before entering any injection/resume
 * branch; this helper keeps its direct-call behavior observable for callers
 * that only assemble wake text.
 */

type LoopStatusSnapshot = Awaited<ReturnType<typeof getLoopStatus>>;
type LoopDeliverySupersession =
  | { kind: 'ended' }
  | { kind: 're-armed' }
  | { kind: 'lineage-mismatch'; markerHarness: string; currentHarness: string };

/**
 * Classify a loop delivery against the loop lifecycle observed at delivery time.
 * A missing/inactive row means `loop:end` won the race; an arm newer than the
 * delivery means the queued fire belongs to the prior loop instance. Invalid
 * timestamps are deliberately fail-open because they cannot prove supersession.
 */
function classifyLoopDeliverySupersession(
  d: DeliveryWork,
  status: LoopStatusSnapshot,
  candidate?: LoopDeliveryMarker,
): LoopDeliverySupersession | null {
  if (!status || status.active === false) return { kind: 'ended' };

  const marker = candidate?.marker ?? readLoopDeliveryMarker(d.payload);
  if (!marker) return null;

  // A queued fire carries the routine's install_slug in its marker. If the same
  // owner now has an active loop under a different harness, the fire belongs to
  // an older loop lineage. Do not read that marker's carry-note: the same owner
  // can legitimately have a fresh note under the current routine's harness, and
  // selecting the old row would make the delivery-time re-check authoritative for
  // the wrong mission (EI-21164618811036992).
  const markerHarness = marker.harness;
  const currentHarness = typeof status.harnessSlug === 'string' ? status.harnessSlug.trim() : '';
  if (markerHarness && currentHarness && markerHarness !== currentHarness) {
    return { kind: 'lineage-mismatch', markerHarness, currentHarness };
  }

  const armedAtMs = status.armedAt ? new Date(status.armedAt).getTime() : NaN;
  const createdAtMs = new Date(candidate?.createdAt ?? d.createdAt).getTime();
  if (Number.isFinite(armedAtMs) && Number.isFinite(createdAtMs) && armedAtMs > createdAtMs) {
    return { kind: 're-armed' };
  }
  return null;
}

/** Read and classify a loop delivery's lifecycle without blocking normal wakes.
 *  Returns the supersession that justifies DROPPING the whole delivery attempt —
 *  which, per EI-21393930883750326, exists only for a PURELY-loop attempt: a
 *  coalesced union that also carries a non-loop component (a one-shot
 *  await-event / timeout fire) must still be delivered, so a stale folded loop
 *  fire yields null here and is instead neutralized by rehydrateLoopWakeText's
 *  🛑 supersession banner on the delivered text. */
async function readLoopDeliverySupersession(
  d: DeliveryWork,
  getStatus: typeof getLoopStatus,
): Promise<{
  delivery: DeliveryWork;
  supersession: LoopDeliverySupersession | null;
  strippedLoopComponents: number;
}> {
  const candidates = readLoopDeliveryMarkers(d.payload);
  if (candidates.length === 0) {
    return { delivery: d, supersession: null, strippedLoopComponents: 0 };
  }
  try {
    const status = await getStatus(d.subscriberId);
    const firstSupersession = candidates
      .map((candidate) => classifyLoopDeliverySupersession(d, status, candidate))
      .find((candidate): candidate is LoopDeliverySupersession => candidate != null);
    if (!firstSupersession) {
      return { delivery: d, supersession: null, strippedLoopComponents: 0 };
    }

    // A coalesced wake is one delivery attempt. If every folded component is a
    // loop fire, an ended/re-armed/lineage-mismatched loop suppresses the whole
    // attempt. A non-loop sibling owns an independent wake and must survive.
    if (!deliveryHasNonLoopComponent(d.payload)) {
      return { delivery: d, supersession: firstSupersession, strippedLoopComponents: 0 };
    }

    // EI-21429789011259186: preserving the mixed attempt is not enough. The old
    // path left the superseded loop event inside payload.events (and sometimes as
    // the top-level headline), so wakeTurnText re-injected its frozen checkpoint,
    // tagWakeText mislabeled the surviving event turn as loop-fire, and the channel
    // chooser could still take the cold-loop branch. Remove stale LOOP components
    // before ANY of those consumers run, then rebuild the union from the surviving
    // events. This keeps the one-shot event wake without replaying ended-loop state.
    const record = d.payload as {
      coalesced?: unknown;
      events?: unknown;
      latest?: unknown;
    };
    if (record.coalesced !== true) {
      // Defensive: deliveryHasNonLoopComponent can only reach this branch for a
      // malformed/legacy mixed shape. Preserve the wake rather than guessing which
      // bytes belong to the non-loop component.
      return { delivery: d, supersession: null, strippedLoopComponents: 0 };
    }

    type FoldedEvent = {
      event?: unknown;
      summary?: unknown;
      payload?: unknown;
      delivery_id?: unknown;
      createdAt?: unknown;
    };
    const rawEvents = Array.isArray(record.events)
      ? record.events.filter((event): event is FoldedEvent => event != null && typeof event === 'object')
      : [];
    const sourceEvents: FoldedEvent[] =
      rawEvents.length > 0
        ? rawEvents
        : record.latest && typeof record.latest === 'object'
          ? [record.latest as FoldedEvent]
          : [];
    const survivors: FoldedEvent[] = [];
    let strippedLoopComponents = 0;
    for (const event of sourceEvents) {
      const marker = readColdLoopMarker(event.payload);
      if (marker) {
        const supersession = classifyLoopDeliverySupersession(d, status, {
          marker,
          ...(typeof event.createdAt === 'string' ? { createdAt: event.createdAt } : {}),
        });
        if (supersession) {
          strippedLoopComponents += 1;
          continue;
        }
      }
      survivors.push(event);
    }

    if (strippedLoopComponents === 0 || survivors.length === 0) {
      // The empty-survivor case should be unreachable after the positive mixed
      // composition test above, but fail safely: a confirmed stale loop must not
      // be replayed merely because a malformed envelope hid its sibling.
      return survivors.length === 0
        ? { delivery: d, supersession: firstSupersession, strippedLoopComponents: 0 }
        : { delivery: d, supersession: null, strippedLoopComponents: 0 };
    }

    const latest = survivors[survivors.length - 1];
    const eventKey = typeof latest.event === 'string' && latest.event.length > 0 ? latest.event : d.eventKey;
    const latestSummary = typeof latest.summary === 'string' ? latest.summary : null;
    const suppressionSummary =
      `${strippedLoopComponents} superseded loop ${strippedLoopComponents === 1 ? 'component was' : 'components were'} ` +
      'removed at delivery after loop lifecycle re-check';
    let payload: unknown = latest.payload ?? null;
    let summary = latestSummary ? `${suppressionSummary} — ${latestSummary}` : suppressionSummary;

    if (survivors.length > 1) {
      const timeoutEvents = survivors.filter((event) => payloadIsTimeout(event.payload));
      const eventEvents = survivors.filter((event) => !payloadIsTimeout(event.payload));
      const summaryParts: string[] = [];
      if (eventEvents.length > 0) {
        summaryParts.push(
          `${eventEvents.length} ${eventEvents.length === 1 ? 'event' : 'events'} fired while you slept: ` +
            eventEvents.map((event) => String(event.event ?? 'unknown')).join(', '),
        );
      }
      if (timeoutEvents.length > 0) {
        summaryParts.push(
          `${timeoutEvents.length} ${timeoutEvents.length === 1 ? 'await deadline' : 'await deadlines'} expired while you slept: ` +
            timeoutEvents.map((event) => String(event.event ?? 'unknown')).join(', '),
        );
      }
      summary =
        `${suppressionSummary}; ${summaryParts.join('; ')}` + (latestSummary ? ` — latest: ${latestSummary}` : '');
      payload = {
        coalesced: true,
        count: survivors.length,
        eventCount: eventEvents.length,
        timeoutCount: timeoutEvents.length,
        events: survivors,
        latest: {
          event: latest.event,
          payload: latest.payload,
          createdAt: latest.createdAt,
          delivery_id: latest.delivery_id,
        },
      };
    }

    return {
      delivery: {
        ...d,
        eventKey,
        payload,
        summary,
        // The coalescer does not persist sibling notes in its union. Keeping the
        // old headline note when that headline was the removed loop would replay
        // stale imperative text, so the safe rebuilt representation has no note.
        note: null,
        coalescedCount: survivors.length,
        ...(typeof latest.createdAt === 'string' ? { createdAt: latest.createdAt } : {}),
      },
      supersession: null,
      strippedLoopComponents,
    };
  } catch {
    // Status lookup is a safety signal, not a new delivery dependency. If it is
    // unavailable, preserve the existing wake rather than dropping on inference.
    return { delivery: d, supersession: null, strippedLoopComponents: 0 };
  }
}

type DeliveryCarryNoteMeta = Awaited<ReturnType<typeof defaultGetLoopCarryNoteWithMeta>>;

type CarryNoteSnapshotIdentity = {
  bodyHash: string | null;
  updatedAtMs: number | null;
  readFailed: boolean;
};

/**
 * Reduce a carry-note read to the identity the delivery consumers can verify.
 * Compare the body hash rather than the body itself: the body is intentionally
 * clipped for the injection budget, while the hash still identifies the full
 * checkpoint that was read. `readFailed` is normalized because older injected
 * readers omit it and therefore mean a successful read by compatibility.
 */
function carryNoteSnapshotIdentity(meta: DeliveryCarryNoteMeta | null | undefined): CarryNoteSnapshotIdentity {
  const readFailed = meta?.readFailed === true;
  const body = !readFailed && typeof meta?.note === 'string' && meta.note.length > 0 ? meta.note : null;
  const updatedAtMs =
    typeof meta?.updatedAtMs === 'number' && Number.isFinite(meta.updatedAtMs) ? meta.updatedAtMs : null;
  return {
    bodyHash: body === null ? null : shortCarryHash(body),
    updatedAtMs,
    readFailed,
  };
}

function carryNoteSnapshotMismatch(
  refreshed: DeliveryCarryNoteMeta | null | undefined,
  cached: DeliveryCarryNoteMeta | null | undefined,
): { refreshed: CarryNoteSnapshotIdentity; cached: CarryNoteSnapshotIdentity; fields: string[] } | null {
  const refreshedIdentity = carryNoteSnapshotIdentity(refreshed);
  const cachedIdentity = carryNoteSnapshotIdentity(cached);
  const fields: string[] = [];
  if (refreshedIdentity.bodyHash !== cachedIdentity.bodyHash) fields.push('bodyHash');
  if (refreshedIdentity.updatedAtMs !== cachedIdentity.updatedAtMs) fields.push('updatedAtMs');
  if (refreshedIdentity.readFailed !== cachedIdentity.readFailed) fields.push('readFailed');
  return fields.length === 0 ? null : { refreshed: refreshedIdentity, cached: cachedIdentity, fields };
}

function formatCarryNoteSnapshotIdentity(identity: CarryNoteSnapshotIdentity): string {
  return `bodyHash=${identity.bodyHash ?? 'null'}, updatedAtMs=${identity.updatedAtMs ?? 'null'}, ` +
    `readStatus=${identity.readFailed ? 'failed' : 'ok'}`;
}

export async function rehydrateLoopWakeText(
  d: DeliveryWork,
  baseText: string,
  deps: {
    getLoopCarryNoteWithMetaFn?: typeof defaultGetLoopCarryNoteWithMeta;
    /**
     * Delivery-boundary refresh. The normal reader may be memoized so the cold
     * injection and the rehydrated text share one snapshot, but a queued wake can
     * cross a checkpoint write between those reads. A refresh reader may perform
     * one additional authoritative read and must return the newest valid snapshot.
     */
    refreshLoopCarryNoteWithMetaFn?: typeof defaultGetLoopCarryNoteWithMeta;
    /** Capture the exact delivery-time snapshot used to compose the live block. */
    captureLoopCarryNoteMeta?: (meta: DeliveryCarryNoteMeta) => void;
    getLoopStatusFn?: typeof getLoopStatus;
  } = {},
): Promise<string> {
  try {
    const markerCandidate = readLatestLoopDeliveryMarker(d.payload);
    const marker = markerCandidate?.marker ?? null;
    if (!marker?.harness) return baseText; // not a loop wake — untouched, no DB read
    const getNoteMeta =
      deps.refreshLoopCarryNoteWithMetaFn ?? deps.getLoopCarryNoteWithMetaFn ?? defaultGetLoopCarryNoteWithMeta;
    const getStatus = deps.getLoopStatusFn ?? getLoopStatus;
    let statusRead = false;
    let liveLoopHarness: string | null = null;
    let deliverySupersession: LoopDeliverySupersession | null = null;
    try {
      const status = await getStatus(d.subscriberId);
      statusRead = true;
      // Keep the live routine's install slug OUT here: the absence banner below has to
      // state whether this reader's scope was ever confirmed against loop:status', and
      // that comparison is otherwise trapped inside classifyLoopDeliverySupersession.
      const liveSlug = typeof status?.harnessSlug === 'string' ? status.harnessSlug.trim() : '';
      liveLoopHarness = liveSlug === '' ? null : liveSlug;
      deliverySupersession = classifyLoopDeliverySupersession(d, status, markerCandidate ?? undefined);
    } catch {
      // Status is a safety signal, not a new delivery dependency. If it is
      // unavailable, preserve the existing fail-soft carry-note read below.
    }

    // Never read a carry-note under a marker whose harness no longer owns the
    // subscriber's active loop. The stale fire text remains available below for
    // diagnosis, but the live block must not manufacture authority from the old
    // same-owner row.
    const lineageMismatch = deliverySupersession?.kind === 'lineage-mismatch' ? deliverySupersession : null;
    const meta = lineageMismatch
      ? { note: null, updatedAtMs: null, readFailed: false }
      : await getNoteMeta({
          harness: marker.harness,
          ownerId: d.subscriberId,
          workspaceId: d.workspaceId,
        });
    // Keep the exact meta read alongside the rendered text so a later cold
    // injector can prove it is using the same snapshot, not merely a note that
    // happens to look similar after a second read.
    deps.captureLoopCarryNoteMeta?.(meta);
    // EI-21969383091076581: WHEN this read ran, stated on every branch below.
    //
    // Filed as "the delivery-time lookup false-negatives — the header says NO checkpoint
    // while loop:status returns the note". Measured, both reads were correct and 56s apart:
    // the delivery read ran at 11:51:34Z and found nothing, the banner told the agent to
    // "write the FIRST one before this turn ends", the agent did so at 11:52:30Z, and the
    // loop:status call that "contradicted" the banner was reading the note the banner had
    // just caused to exist.
    //
    // The absence branch stated no time at all while the success branch reported writtenAt,
    // so there was no way to ORDER the two observations — which makes a correct banner and a
    // correct status read look like a contradiction, and turns following the instruction into
    // apparent proof the instruction was wrong. A reader that can see both timestamps sees a
    // sequence instead of a conflict.
    const deliveryReadAtIso = new Date().toISOString();
    const carryNoteReadFailed = meta.readFailed === true;
    // A failed read must not be rendered as an empty note. In particular, the
    // "none open" wall text would turn an unavailable store into a false
    // clearance signal and invite a stale wake to proceed.
    const readableNote = carryNoteReadFailed ? null : meta.note;
    const { walls } = splitCarryNoteWalls(readableNote);
    const wallsNow = carryNoteReadFailed
      ? '  ⚠ UNKNOWN — the carry-note read failed at delivery time; do not infer that no walls are open'
      : renderLoopWallsBlock(walls) ?? '  (none open — any wall shown OPEN above has been CLEARED since)';
    // P-001 (cold-carry-system-hardening) delivery parity: the live re-read covers
    // carried checks too — a stale staged wake must not resurrect a cleared check
    // (or hide a fresh one) any more than a wall.
    const { checks } = splitCarryNoteChecks(readableNote);
    const checksNow = carryNoteReadFailed
      ? '🧪 CARRIED CHECKS — UNKNOWN: the delivery-time carry-note read failed; do not infer that no checks are open.'
      : renderLoopChecksBlock(checks);
    const ageMs = readableNote && meta.updatedAtMs != null ? Date.now() - meta.updatedAtMs : null;
    const ageStr = ageMs != null ? `${Math.max(0, Math.round(ageMs / 1000))}s` : 'unknown';

    // EI-20230529647745311: the re-check used to be appended after the fire-time
    // snapshot. The injection door intentionally keeps the HEAD and spills the TAIL,
    // so a delayed loop wake could still inject the old candidate/next-action while
    // the fresh read lived only in the spill file. Put the delivery-time state first
    // so the state that governs the turn survives the door. Keep the narrative note in
    // this high-priority block (not only walls/checks): those fields carry the candidate
    // and next action that a stale wake can otherwise resurrect.
    const liveNote = readableNote ? clipLoopCheckpointForWake(readableNote, 2_200) : null;
    // A note body alone is not enough to call the delivery-time read current: a
    // legacy/corrupt row (or a degraded reader) can return text without the
    // committed write timestamp needed to order it against later checkpoint writes.
    // Derive the same short hash the checkpoint writer returns so the recipient can
    // compare this exact body with a verified loop:checkpoint result.
    const checkpointHash = readableNote ? shortCarryHash(readableNote) : null;
    const hasCommittedTimestamp =
      typeof meta.updatedAtMs === 'number' && Number.isFinite(meta.updatedAtMs) && meta.updatedAtMs > 0;
    const checkpointProvenCurrent = Boolean(liveNote && checkpointHash && hasCommittedTimestamp);
    // EI-21971731335245747: the two carry-note readers select the row by DIFFERENT keys.
    // THIS reader uses the wake marker's harness (above); loop:status uses the LIVE
    // routine's install slug, and agent-tools/loop/status.ts calls that slug "the
    // authoritative carry-note harness, just as it is for the cold wake reader" — an
    // agreement this reader does not actually honour. classifyLoopDeliverySupersession
    // catches a PROVEN divergence as a lineage-mismatch, but only when the status read
    // succeeded AND named a harness to compare against. When it did not, scope agreement
    // is UNKNOWN rather than fine.
    //
    // An unknown scope is survivable for every branch that FOUND a note — the row's
    // existence is its own evidence. It is not survivable for an ABSENCE, because the
    // absence banner's own remedy is "write loop:checkpoint before ending this turn":
    // reported as clean, a wrong-scope read invites the agent to overwrite the very
    // checkpoint it failed to see. So an absence states its scope, or qualifies itself.
    const scopeAgreementVerified = statusRead && liveLoopHarness === marker.harness;
    const scopeUnverifiedReason = statusRead
      ? 'the live loop status named no harness to compare against'
      : 'the live loop status could not be read at delivery time';
    const checkpointState = lineageMismatch
      ? `⚠ LOOP DELIVERY LINEAGE MISMATCH for owner ${d.subscriberId}: the wake marker names harness ` +
        `${lineageMismatch.markerHarness}, but the current active loop is scoped to harness ` +
        `${lineageMismatch.currentHarness}. The marker-scoped carry-note was NOT read; the wake text below ` +
        `may be a stale prior-lineage snapshot. Reconcile loop:status / coord:orient before acting.`
      : carryNoteReadFailed
        ? `⚠ LOOP CHECKPOINT RE-CHECK FAILED at delivery time for owner ${d.subscriberId}, harness ${marker.harness}. ` +
          `The carry-note store read failed; this is NOT confirmation that no checkpoint exists. The wake text below ` +
          `may be a stale fire-time snapshot, so do not re-execute it or overwrite a possibly existing checkpoint. ` +
          `Reconcile the carry-note store identity and write loop:checkpoint before ending this turn.`
      : checkpointProvenCurrent
        ? `Current verified loop:checkpoint (resolved at delivery for owner ${d.subscriberId}, harness ${marker.harness}; ` +
          `contentHash=${checkpointHash}; writtenAt=${new Date(meta.updatedAtMs!).toISOString()}; readAt=${deliveryReadAtIso}):\n${liveNote}`
        : liveNote
          ? `⚠ UNPROVEN delivery-time loop:checkpoint for owner ${d.subscriberId}, harness ${marker.harness} ` +
            `(readAt=${deliveryReadAtIso}). ` +
            `The latest committed checkpoint could not be established (contentHash or write timestamp is unavailable); ` +
            `treat this note as a stale snapshot and do not trust or re-execute it. Reconcile the carry-note store ` +
            `identity and write loop:checkpoint before ending this turn:\n${liveNote}`
          : scopeAgreementVerified
            ? `⚠ NO delivery-time loop:checkpoint was found for owner ${d.subscriberId}, harness ${marker.harness} ` +
              `as of readAt=${deliveryReadAtIso} — this is a statement about that instant, NOT about the whole turn. ` +
              `If you write a checkpoint after it (including the one this line is about to ask you for), a later ` +
              `loop:status WILL return a note; that is the two reads being ordered, not a contradiction, so do not ` +
              `file it as a false negative (EI-21969383091076581). ` +
              `If the wake text below contains a checkpoint, it is a stale fire-time snapshot; do not trust or re-execute it. ` +
              `Reconcile the carry-note store identity and write loop:checkpoint before ending this turn.`
            : `⚠ NO delivery-time loop:checkpoint was found for owner ${d.subscriberId}, harness ${marker.harness} ` +
              `as of readAt=${deliveryReadAtIso} — but THE SCOPE OF THAT READ IS UNVERIFIED: ${scopeUnverifiedReason}. ` +
              `This reader selects the carry-note by the wake MARKER's harness, while loop:status selects it by the ` +
              `LIVE routine's install slug. Those two keys are normally the same and were not confirmed to be here, so ` +
              `this absence may be a WRONG-SCOPE read rather than evidence that no checkpoint exists. ` +
              `Do NOT treat it as confirmation of absence and do NOT let it justify an overwrite: call loop:status ` +
              `first and compare its harness against ${marker.harness}. If they differ, the note lives under the ` +
              `harness loop:status reports — write there and reconcile the carry-note store identity rather than ` +
              `starting a fresh checkpoint here. ` +
              `Independently of scope, an absence is only a statement about that instant, NOT about the whole turn: ` +
              `if you write a checkpoint after it, a later loop:status WILL return a note; that is the two reads ` +
              `being ordered, not a contradiction, so do not file it as a false negative (EI-21969383091076581). ` +
              `If the wake text below contains a checkpoint, it is a stale fire-time snapshot; do not trust or re-execute it.`;

    // EI-18825117783927950: best-effort, SEPARATELY caught so a status-read hiccup
    // degrades only this banner, never the walls/checks rehydration above it.
    let supersededNote = '';
    if (statusRead) {
      const supersession = deliverySupersession;
      if (supersession?.kind === 'ended') {
        supersededNote =
          `\n\n🛑 THIS LOOP WAS ENDED (loop:end) before this wake was actually delivered — it was queued while ` +
          `the loop was still active and only reached you afterward. The goal/checkpoint text above is FROZEN ` +
          `from before the end and is NOT authoritative: do not resume, re-open, or re-do work off it. Call ` +
          `loop:status to confirm before acting; if the loop's goal was already achieved, take no further ` +
          `action on it this turn.`;
      } else if (supersession?.kind === 're-armed') {
        supersededNote =
          `\n\n🛑 THIS LOOP WAS RE-ARMED (loop:arm) after this wake was queued but before it was delivered — the ` +
          `goal/checkpoint text above is from the PRIOR arm and may no longer reflect the current goal. Call ` +
          `loop:status / coord:orient to read the CURRENT goal before treating the text above as authoritative.`;
      } else if (supersession?.kind === 'lineage-mismatch') {
        supersededNote =
          `\n\n🛑 THIS LOOP WAKE HAS A HARNESS LINEAGE MISMATCH — it was queued by harness ` +
          `${supersession.markerHarness}, but the owner's current active loop is harness ` +
          `${supersession.currentHarness}. The queued wake is NOT authoritative; do not resume work from it.`;
      }
    }

    const liveRecheck =
      `🔄 LIVE RE-CHECK at actual delivery time (EI-10935 / EI-20230529647745311 — this delivery may have been ` +
      `queued/staged, so the checkpoint/walls text below can be a stale snapshot from when the wake FIRED, not ` +
      `from now). Freshest carry-note is ${ageStr} old.\n\n` +
      checkpointState +
      `\n\nCurrent open walls:\n${wallsNow}\n` +
      (checksNow ? `${checksNow}\n` : '') +
      // EI-21988107654213811: the delivery read is ordered only to its own
      // readAt instant. A newer loop:checkpoint can be written immediately
      // afterward, so the authority claim must not make a recipient trust this
      // snapshot over a later status/checkpoint it actually observes.
      `TRUST THIS BLOCK AS OF readAt=${deliveryReadAtIso} — it outranks the fire-time snapshot below for state observed at that instant, ` +
      `but it is NOT a promise that the carry-note stayed unchanged afterward. If you write a checkpoint, receive a newer status, ` +
      `or otherwise observe progress after readAt, re-read loop:status / loop:checkpoint before acting; do not re-execute an ` +
      `irreversible action or re-ask the owner about a wall not listed in this snapshot.`;

    // Keep both the live state and a lifecycle supersession warning ahead of the
    // generic fire-time text. The latter is just as important to preserve: an ended
    // or re-armed loop must not be revived by a queued stale imperative.
    return `${liveRecheck}${supersededNote}\n\n${baseText}`;
  } catch {
    // The delivery itself remains fail-soft, but do not silently present a loop
    // snapshot as authoritative when the delivery-time read failed completely.
    return (
      `⚠ LOOP CHECKPOINT RE-CHECK FAILED at delivery time for owner ${d.subscriberId}. ` +
      `The checkpoint below may be stale; reconcile the loop:checkpoint store/identity before acting.\n\n${baseText}`
    );
  }
}

/** Injections door (deterministic-context-carry P-006 enforcement leg (b), plan D-007):
 *  the per-hop budget for machine-composed injected text. The FLOOR door — /26 lands
 *  virtually every fleet model AT the 8K floor (the brief's own observation), and the spill
 *  pointer preserves the full text for the models the floor over-trims. Resolved per
 *  delivery through the P-023 config surface (workspace defaults ⟵ the RECIPIENT
 *  session's override; fail-soft to this baked floor); `PAPERCUSP_INJECTION_DOOR_OFF=1`
 *  stays the operational kill-switch. */
function injectionDoorTokens(subscriberId: string | null | undefined): number {
  return computeTurnDoors(0, getDoorConstantsSync(subscriberId)).injections;
}

/**
 * Fit a composed wake text to the injections door. A wake's unbounded fields (`summary`
 * carries a loop's whole carry-note; a coord body can ride a wake) previously injected
 * without ANY cap — the "injections" lane of the 2026-07-13 hop-budget analysis.
 *
 * P-024 clause D (review-system-rework-reduction-2026-09-23; P-026): the door BUILDS TO
 * the budget instead of cutting a finished document. `packWakeText` keeps whole sections
 * by priority (headline, then next-action / owner / blocker sections, then document
 * order) and names every section it left out in one `[injection-door: …]` pointer; the
 * FULL original plus a section index is spilled to
 * `~/.papercusp/wake-spills/<subscriber>/delivery-<id>.md`. Nothing is cut mid-section.
 * FAIL-SOFT: a spill write failure delivers the FULL untrimmed text (a lost wake tail is
 * worse than a fat hop), and the kill-switch env bypasses entirely. Applied BEFORE
 * provenance tagging so the envelope is never sheared.
 */
export function applyInjectionDoor(d: DeliveryWork, text: string): string {
  try {
    if (process.env.PAPERCUSP_INJECTION_DOOR_OFF === '1') return text;
    const doorTokens = injectionDoorTokens(d.subscriberId);
    const budgetChars = Math.max(1, Math.floor(doorTokens * CHARS_PER_TOKEN_ESTIMATE));
    if (text.length <= budgetChars) return text;
    const dir = join(
      homedir(),
      '.papercusp',
      'wake-spills',
      String(d.subscriberId ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_'),
    );
    const file = join(dir, `delivery-${d.id}.md`);
    const packed = packWakeText(text, budgetChars, doorTokens, file);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `# Wake spill — delivery #${d.id} (event ${d.eventKey})\n\n` +
        `The composed wake exceeded the per-hop injection door (~${doorTokens} tokens), so ` +
        `${packed.omitted.length} whole section(s) were left out of the delivered text. ` +
        `This file carries the FULL original text. Safe to delete after reading.\n\n` +
        `## Section index\n\n${renderSectionIndex(packed)}\n\n---\n\n${text}\n`,
      { mode: 0o600 },
    );
    recordWakePack(packed.omitted.length);
    console.info(
      `[wake-budget] delivery #${d.id} for ${d.subscriberId}: ${packed.omitted.length} section(s) left out whole ` +
        `(${packed.text.length}/${budgetChars} chars delivered)`,
    );
    return packed.text;
  } catch {
    return text;
  }
}

/**
 * turn-provenance P-002 (turn-provenance-owner-vs-agent-2026-07-11): envelope +
 * ledger-tag a wake turn BEFORE it is typed into a PTY / submitted as a resume
 * prompt, so the recipient's UserPromptSubmit hook classifies it as verified
 * agent-origin instead of owner input. Applied ONLY to PTY/prompt deliveries —
 * never to inbox bodies (coord messages carry native `from` provenance).
 * Origin: a loop fire's wake (cold-loop marker on the payload) tags `loop-fire`;
 * an owner-Inbox-authored reply wake (owner-inbox-single-pane-2026-07-17 D-006 —
 * `inbox-reply.ts`'s marker on the payload) tags `coord-inject:owner`; every
 * other await delivery tags `wake-pump`. Fail-soft by construction: a failed
 * ledger write still returns deliverable tagged text (the turn then shows as
 * UNVERIFIED at the hook — visible, never a dropped wake).
 */
async function tagWakeText(d: DeliveryWork, text: string, tag: WakeTurnTagger): Promise<EnrolledWakeText> {
  const origin = readLoopDeliveryMarker(d.payload)
    ? 'loop-fire'
    : // EI-20130618357432548: an owner CHAT-PANE turn is the same authority as an
      // owner INBOX reply — both are authored by the authenticated human through an
      // admin-only surface — so it mints the SAME existing distinguished origin
      // rather than a new one. Deliberately still ENROLLED: delivering it
      // unenveloped would classify it OWNER (interactive), and the admin route
      // accepts a no-Origin localhost POST, so that would let any agent curl an
      // owner-stamped turn (and thus an auto-registered mode grant) into a peer's
      // session. See owner-chat-turn.ts's SECURITY note.
      // EI-20135573616431912: the SHARED constant, not a literal — the owner's
      // chat pane hides every user turn whose origin is not this exact string,
      // so a drift between here and that filter would silently VANISH the
      // owner's own messages from their conversation.
      isInboxOwnerReplyPayload(d.payload) || readOwnerChatTurnText(d.payload)
      ? OWNER_CHAT_TURN_ORIGIN
      : 'wake-pump';
  try {
    return (await tag({ sid: d.subscriberId, origin, text })).taggedText as EnrolledWakeText;
  } catch {
    // The wake itself is fail-soft, but returning it without an envelope turns a
    // machine prompt into affirmative owner speech in every transcript reader.
    // Keep delivery moving with a syntactically valid, unverified envelope; the
    // prompt hook can classify it as unverified (there is no ledger row), while
    // owner-visible readers still fail closed on the non-owner origin.
    return `${formatEnvelope(origin, mintNonce())}\n${text}` as EnrolledWakeText;
  }
}

function pidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** System identity for the degrade-to-inbox notify send below (mirrors
 *  engine.ts's own `emitterIdentity` — kept as a private duplicate rather
 *  than a shared export to avoid a wake-executor↔engine import cycle). */
function inboxNotifierIdentity(workspaceId: string): AgentIdentity {
  return {
    ownerId: 'await-event',
    ownerLabel: 'await-event',
    source: 'static-client',
    workspaceId,
    userId: null,
  } as AgentIdentity;
}

/** Durable owner + fleet notice for a resume incarnation quarantined by the
 * missing-tool-reference detector. The roster/end marker remains the liveness
 * authority; this message explains why the member's claims are returning. */
async function notifyPoisonedResumeSession(
  delivery: DeliveryWork,
  context: ResumeTurnContext,
  error: string,
  send: typeof sendMessage,
): Promise<void> {
  try {
    await send(inboxNotifierIdentity(delivery.workspaceId), {
      to: [delivery.subscriberId],
      summary: `Claude session #${context.advSessionId} quarantined after repeated unavailable tool references`,
      body:
        `The Claude transcript recorded at least ${CLAUDE_TOOL_REFERENCE_POISON_TURNS} consecutive assistant turns ` +
        `rejected because a Papercusp tool_reference was absent from the resumed tool list. Wake retries for this ` +
        `session incarnation have stopped; session-end lease cleanup was scheduled to release its work-item claims.\n\n` +
        `Last provider evidence: ${error}`,
      category: 'event',
      extra: {
        auto: true,
        event_key: delivery.eventKey,
        wake_delivery_id: delivery.id,
        adv_session_id: context.advSessionId,
        terminal_status: 'poisoned',
        poison_reason: context.poisonReason,
      },
    });
  } catch (e) {
    console.warn(`[wake-executor] poisoned-resume notification failed for ${delivery.subscriberId}: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Degrade a would-be DROP to a coord inbox notification (P-001,
 * wake-delivery-degradation-fix-2026-07-09). Per the events:await
 * registration contract, a subscriber always has a coord inbox to fall back
 * to — no live pty/socket to inject into and nothing safely resumable is NOT
 * the same as "no resolvable owner". Only when the inbox write itself fails
 * (the one case where delivery is genuinely impossible) does this still drop,
 * visibly, folding the inbox failure into the reason.
 *
 * Exported (EI-16559) so the pump's exhausted-retries path (engine.ts) can
 * reuse the SAME fallback for a delivery that keeps ERRORing until it burns
 * through MAX_ATTEMPTS — see that call site for why this was previously drop
 * -only and left `error`-exhausted deliveries silently 'dead'.
 */
export async function degradeToInboxOrDrop(
  d: DeliveryWork,
  reason: string,
  send: typeof sendMessage,
): Promise<WakeOutcome> {
  try {
    await send(inboxNotifierIdentity(d.workspaceId), {
      to: [d.subscriberId],
      summary: `${wakeSummaryHeadline(d.eventKey, d.payload)} — delivered to your coord inbox (${reason})`,
      body: wakeTurnText(d),
      category: 'event',
      extra: { auto: true, event_key: d.eventKey, wake_delivery_id: d.id },
    });
    return { kind: 'delivered', channel: 'inbox' };
  } catch (err) {
    return {
      kind: 'drop',
      reason: `${reason} — inbox delivery also failed (no resolvable owner): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * WI-10005900: `claude --resume` names no effort, so the resumed CLI falls back
 * to the effortLevel in its settings.json — a key Claude Code writes itself. A
 * session whose settings were written while Opus 5 offered `xhigh` then resumes
 * with `xhigh` and 400s on its first request. The gateway clamps that on the
 * `auto`/pinned routes, but the `default` route skips the gateway, so the resume
 * argv carries the clamped level explicitly (the same rule psu-launcher applies
 * to its own launches). Returns `args` itself when nothing needs clamping, the
 * argv already names an effort, or it has no `--resume`.
 */
export function withClaudeResumeEffortClamp(args: string[], settings: ClaudeLaunchSettings): string[] {
  if (args.some((a) => a === '--effort' || a.startsWith('--effort='))) return args;
  const at = args.indexOf('--resume');
  if (at < 0) return args;
  const modelAt = args.indexOf('--model');
  const model = modelAt >= 0 && modelAt + 1 < args.length ? args[modelAt + 1] : null;
  const level = claudeInheritedEffortOverride({ model, settings });
  if (!level) return args;
  return [...args.slice(0, at), '--effort', level, ...args.slice(at)];
}

/** Per-client resume invocation (mirrors psu-launcher resumeArgsFor, headless-
 *  capable). Returns null when the session is not safely resumable. */
export function resumeCommandFor(
  handle: {
    agent: string | null;
    sessionId: string | null;
    ompThreadId: string | null;
    /** adv_sessions.coord_owner_id — for tracked hive launches this is the spawn
     *  id that keys the persistent signed MCP config dir (D-010 resume leg). */
    coordOwnerId?: string | null;
  },
  wakeText: string,
  accountRoute?: WakeAccountRoute | null,
): { bin: string; args: string[]; promptViaPty: boolean } | null {
  if (handle.agent === 'claude') {
    // Exact-session resume only (see header). Prompt rides as the positional
    // arg — claude submits it as the first user message of the resumed turn.
    if (!handle.sessionId) return null;
    // Tracked hive launches (invoke route, bpkind=hive) bake their signed MCP
    // config at a PERSISTENT conventional path keyed by the coord owner id —
    // remount it on resume or the resumed Queen wakes toolless (her original
    // spawn loaded it via --mcp-config; resume must too).
    const mcpArgs: string[] = [];
    if (handle.coordOwnerId) {
      const cfg = sessionMcpJsonPath(handle.coordOwnerId);
      if (existsSync(cfg)) mcpArgs.push('--mcp-config', cfg, '--strict-mcp-config');
    }
    return {
      bin: 'claude',
      args: [
        ...(accountRoute?.claudeArgs ?? []),
        '--resume',
        handle.sessionId,
        // Headless one-turn (`-p`): a wake IS one turn — run the resumed turn to
        // completion and exit, leaving the session file updated for the NEXT
        // wake. WITHOUT `-p`, claude boots its interactive TUI which, spawned
        // into a managed pty nothing drives, just sits idle and never runs the
        // turn — every "delivered:resume" produced silence (Stage-B finding,
        // 2026-06-07; the manual `-p` resume is what actually worked).
        '-p',
        '--dangerously-skip-permissions',
        '--permission-mode',
        'bypassPermissions',
        // Capability policy, re-armed for the WAKE surface (P-005).
        //
        // CLI deny flags do NOT persist into a `--resume`, so every autonomous
        // wake must re-arm the full restriction set or it silently lapses.
        // This used to be three hand-listed `*DenyFlag()` calls here and four
        // at the headless launch site — and they had already drifted: the
        // owner-desktop-notify deny held at launch and was silently absent on
        // every wake. Resolving the ONE policy per surface makes that class of
        // drift unrepresentable rather than merely fixed once.
        //
        // Every emitted flag stays a single `=` token: the space form is
        // variadic and would eat the positional wakeText below (D-002).
        ...capabilityPolicyFlags({ client: 'claude', surface: 'wake' }),
        ...mcpArgs,
        wakeText,
      ],
      promptViaPty: false,
    };
  }
  if (handle.agent === 'omp') {
    if (!handle.ompThreadId) return null;
    if (process.env.PAPERCUSP_OMP_RESUME_VIA_PTY === '1') {
      // Fallback for older OMP builds: resume interactively and inject once the
      // TUI is ready. The default modern path below is true headless one-turn.
      return {
        bin: 'omp',
        args: ['-r', handle.ompThreadId, '--approval-mode', 'yolo'],
        promptViaPty: true,
      };
    }
    // OMP supports the same shape as `--continue "prompt"`: combine resume
    // with `-p` and the wake text as the one turn. Prefer this over PTY
    // injection so a wake has a bounded subprocess lifecycle.
    return {
      bin: 'omp',
      args: ['-r', handle.ompThreadId, '--approval-mode', 'yolo', '-p', wakeText],
      promptViaPty: false,
    };
  }
  if (handle.agent === 'codex') {
    // Headless single-turn resume (codex 0.137 `exec resume <uuid> <prompt>`):
    // runs the wake turn to completion in the session's CODEX_HOME (set by
    // executeWake from the adv-session id) and exits, leaving the session
    // updated for the next wake — the codex counterpart of claude's
    // `--resume … -p`. `sessionId` is the conversation UUID executeWake
    // recovered from the rollout; without it we degrade to park/inbox (a bare
    // `--last <prompt>` would have clap read the prompt as the session id).
    // Bypass flags mirror the interactive su resume. (turn-lifecycle-control
    // P-009 / D-004.)
    if (!handle.sessionId) return null;
    return {
      bin: 'codex',
      args: [
        'exec',
        // Machine-readable completion proof. A detached wake is not complete
        // merely because the wrapper exits zero: the outcome classifier requires
        // Codex's terminal `turn.completed` JSONL event and reopens/re-arms the
        // delivery when the marker is missing or `turn.failed` is emitted.
        '--json',
        '--dangerously-bypass-hook-trust',
        '--dangerously-bypass-approvals-and-sandbox',
        'resume',
        handle.sessionId,
        wakeText,
      ],
      promptViaPty: false,
    };
  }
  return null;
}

/**
 * Fresh-per-wake fire for the Hive Queen (queen-brief-cache-assembly B-01 / P-012).
 * The Queen NEVER resumes a prior conversation — she re-derives her working state
 * from durable world-state every wake (D-009). Her own declared/event/watchdog
 * wakes already spawn fresh (`--session-id <new uuid>` via the hive launch
 * blueprint); this routes the ONE remaining resume path (a `coord:send {wake:true}`
 * inbox-wake, or an events:await she registered) through the SAME fresh hive-launch
 * path, with the wake text as the kickoff. Mirrors the `pot:wake` tool's core
 * (floor-debounce + record) so a burst of bee-wakes collapses to one fresh launch.
 * Lazy imports keep the await engine free of the blueprint graph (module header).
 * Returns true when the wake is handled (fired OR floor-skipped — a recent fresh
 * wake already covers it); false on failure so the caller parks rather than resumes.
 */
async function defaultFireHiveWake(input: { installSlug: string; kickoff: string }): Promise<boolean> {
  try {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { fireLaunchBlueprint } = await import('../../blueprint/launch-blueprint');
    const { POT_BLUEPRINT_ID, readPotWakeState, recordPotWake, withinWakeFloor, effectivePotWakeFloorSec } =
      await import('../../pot/wake');
    const workspaceId = activeWorkspaceId();
    const state = await readPotWakeState(workspaceId);
    // A fresh wake within the floor window already covers this delivery — the
    // just-launched (or about-to-survey) Queen will see the same durable state.
    // Honour the owner's raised wake-cadence floor (queen-steering-panel P-006).
    const floorSec = await effectivePotWakeFloorSec(workspaceId, input.installSlug);
    if (withinWakeFloor(state, Date.now(), floorSec)) return true;
    // EI-7871 (WI-3082 follow-up): this fire is a genuine coord/events:await wake
    // continuation (the Queen's ended session getting a fresh-launch in place of a
    // resume, D-010) — override the /invoke route's 'cron' default so her
    // agent_usage_samples row is attributed 'coord-wake', matching the semantics
    // every OTHER coord-wake-triggered spawn already carries (bee/spawn.ts,
    // place_batch.ts, and this same file's resume-channel env above).
    await fireLaunchBlueprint(POT_BLUEPRINT_ID, {
      installSlug: input.installSlug,
      workspaceId,
      kickoff: input.kickoff,
      bodyExtra: { turnTrigger: 'coord-wake' },
    });
    await recordPotWake(workspaceId);
    return true;
  } catch {
    return false;
  }
}

/** Parse the install slug out of a pot-operator adv_sessions label
 *  (`pot · <slug>/<role>`, set at spawn.ts on the bpkind=hive invoke). null when
 *  the row is not a pot operator.
 *  WI-3967: prefix corrected from the stale 'hive · ' literal to 'pot · ' —
 *  the hive→pot rename updated spawn.ts's WRITER (see its own comment) but this
 *  reader was left on the old prefix, so it silently matched ZERO real sessions
 *  and the "fresh-per-wake, never resumed" cutover below never fired post-rename. */
export function hiveInstallSlugFromLabel(label: string | null | undefined): string | null {
  const l = (label ?? '').trim();
  if (!l.startsWith('pot · ')) return null;
  const slug = l.slice('pot · '.length).split('/')[0]?.trim();
  return slug || null;
}

/** Upper bound for an omp resume PTY to present an injectable screen. */
const OMP_RESUME_READY_TIMEOUT_MS = Number(process.env.PAPERCUSP_OMP_RESUME_READY_TIMEOUT_MS) || 15_000;

/** A settled OMP screen is injectable even when its prompt chrome changes. */
const OMP_RESUME_QUIET_READY_MS = Number(process.env.PAPERCUSP_OMP_RESUME_QUIET_READY_MS) || 750;

const OMP_RESUME_TRANSCRIPT_TAIL_BYTES = 4_096;

const OMP_READY_PATTERNS = [
  /(^|[\r\n])\s*(>|[$#])\s*$/m,
  /(?:type|enter|send)\s+(?:a\s+)?(?:message|prompt|request)/i,
  /(?:what would you like|how can i help|ask me anything)/i,
  /\/help/i,
];

/** Delay before the submit Enter (CR) is sent as its OWN keystroke after a turn's
 *  text. A one-shot `text + CR` burst is swallowed by the Claude Code TUI's paste
 *  detector — the CR becomes a literal newline in the input box and the turn never
 *  submits. This is the SAME fix as the psu-pty-host.mjs `controlWrites` split; the
 *  two live in different processes/pty-owners so they can't share code, but they
 *  read the SAME env var to stay in lockstep. */
const TURN_SUBMIT_CR_DELAY_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS) || 150;

interface OmpResumePtyLike {
  id: string;
  accessScope: PtyAccessScope;
  onData?: Set<(chunk: Buffer) => void>;
  onExit?: Set<(code: number, signal: number) => void>;
  history?: Buffer[];
  killed?: boolean;
  exitCode?: number | null;
}

export type OmpPtyPromptInjectionResult =
  | { ok: true; transcriptTail: string }
  | { ok: false; error: string; transcriptTail: string };

function timer(fn: () => void, ms: number): NodeJS.Timeout {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer(resolve, ms);
  });
}

function tailBytes(chunks: Buffer[], maxBytes: number): string {
  if (chunks.length === 0) return '';
  let bytes = 0;
  const out: Buffer[] = [];
  for (let i = chunks.length - 1; i >= 0 && bytes < maxBytes; i -= 1) {
    const b = chunks[i];
    if (!b) continue;
    bytes += b.length;
    out.unshift(b);
  }
  return Buffer.concat(out).subarray(-maxBytes).toString('utf8');
}

export function ompResumePtyLooksReady(transcript: string): boolean {
  return OMP_READY_PATTERNS.some((p) => p.test(transcript));
}

export async function injectOmpWakeTurnWhenReady(input: {
  pty: OmpResumePtyLike;
  wakeText: string;
  write: typeof writePty;
  readyTimeoutMs?: number;
  quietReadyMs?: number;
  submitCrDelayMs?: number;
}): Promise<OmpPtyPromptInjectionResult> {
  const readyTimeoutMs = input.readyTimeoutMs ?? OMP_RESUME_READY_TIMEOUT_MS;
  const quietReadyMs = input.quietReadyMs ?? OMP_RESUME_QUIET_READY_MS;
  const submitCrDelayMs = input.submitCrDelayMs ?? TURN_SUBMIT_CR_DELAY_MS;
  const chunks = [...(input.pty.history ?? [])];

  const transcript = () => tailBytes(chunks, OMP_RESUME_TRANSCRIPT_TAIL_BYTES);
  const initial = transcript();
  if (!ompResumePtyLooksReady(initial)) {
    const ready = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      let done = false;
      let quietTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        done = true;
        clearTimeout(timeoutTimer);
        if (quietTimer) clearTimeout(quietTimer);
        input.pty.onData?.delete(onData);
        input.pty.onExit?.delete(onExit);
      };
      const finish = (result: { ok: true } | { ok: false; error: string }) => {
        if (done) return;
        cleanup();
        resolve(result);
      };
      const markQuietReady = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = timer(() => finish({ ok: true }), quietReadyMs);
      };
      const onData = (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const t = transcript();
        if (ompResumePtyLooksReady(t)) finish({ ok: true });
        else markQuietReady();
      };
      const onExit = (code: number, signal: number) => {
        finish({ ok: false, error: `omp resume pty exited before readiness (code ${code}, signal ${signal})` });
      };
      const timeoutTimer = timer(() => {
        finish({ ok: false, error: `omp resume pty did not become ready within ${readyTimeoutMs}ms` });
      }, readyTimeoutMs);

      if (input.pty.killed || input.pty.exitCode !== null) {
        finish({ ok: false, error: 'omp resume pty is already closed' });
        return;
      }
      input.pty.onData?.add(onData);
      input.pty.onExit?.add(onExit);
    });
    if (!ready.ok) return { ok: false, error: ready.error, transcriptTail: transcript() };
  }

  try {
    const wrotePrompt = input.write(input.pty.id, Buffer.from(input.wakeText, 'utf8'), input.pty.accessScope);
    if (!wrotePrompt) return { ok: false, error: 'omp resume pty rejected prompt write', transcriptTail: transcript() };
    await sleep(submitCrDelayMs);
    const wroteSubmit = input.write(input.pty.id, Buffer.from('\r', 'utf8'), input.pty.accessScope);
    if (!wroteSubmit) return { ok: false, error: 'omp resume pty rejected submit write', transcriptTail: transcript() };
    return { ok: true, transcriptTail: transcript() };
  } catch (err) {
    return {
      ok: false,
      error: `omp resume pty injection failed: ${err instanceof Error ? err.message : String(err)}`,
      transcriptTail: transcript(),
    };
  }
}

export interface ExecuteWakeDeps {
  /** Injected for tests; default real implementations below. */
  getSession?: typeof getAdvSession;
  findPty?: typeof findPtyByPid;
  write?: typeof writePty;
  spawnManagedPty?: typeof spawnPty;
  /** WI-10005900: reads the settings.json a resumed claude child falls back to
   *  for its model + effort, given the env that child will run with. */
  readClaudeLaunchSettings?: (env: Record<string, string | undefined>) => ClaudeLaunchSettings;
  spawnDetached?: (
    bin: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
    /** P0a: when provided, the default spawn captures bounded output tails + observes
     *  the detached turn's exit, firing this on close. */
    onExit?: (exit: ResumeTurnExitRaw) => void,
  ) => number | null;
  /** P0a (loop-wake-rate-limit-robustness): observe the eventual EXIT of a detached
   *  `resume-headless` turn. Fired best-effort when the subprocess closes, carrying the
   *  exit code/signal + bounded stdout/stderr tails — the seam the loop turn-outcome
   *  handler uses to feed the autoloop circuit on a 429 turn-DEATH (the wake records
   *  `delivered` on spawn, so a later death is otherwise invisible). Absent ⇒ today's
   *  fire-and-forget (`stdio:'ignore'`, zero capture overhead); delivery still returns
   *  `delivered` the instant a PID is assigned either way. */
  onResumeTurnExit?: (d: DeliveryWork, exit: ResumeTurnExitRaw, context?: ResumeTurnContext) => void;
  /** Injected detector/quarantine seam for repeated unavailable Claude tool references. */
  quarantineToolReferenceSession?: typeof quarantineRepeatedClaudeToolReferenceFailures;
  /** WI-10003466: move a LIVE Claude session whose transcript replays an unavailable
   *  tool reference onto fresh context (the compaction watchdog's forced carry-respawn)
   *  BEFORE any quarantine. Injected for tests; defaults to the watchdog's recovery. */
  recoverToolReferenceDeath?: (ownerId: string, opts: { workspaceId: string }) => Promise<ToolReferenceDeathRecovery>;
  /** WI-10002854: the task-ledger row and adv-session pid for a spawned
   *  `resume-headless` turn. Injected for tests; the default writes PG. */
  accountHeadlessResumeTurn?: (input: HeadlessResumeTurnInput) => HeadlessResumeTurnAccounting;
  /** WI-10002854: is this live recorded pid a headless resume turn of the same
   *  session? When it is, the wake parks. It never force-interrupts that turn. */
  isHeadlessResumeTurn?: (pid: number, resumeId: string | null) => boolean;
  kill?: typeof killPty;
  presence?: typeof getPresence;
  /** EI-203843: durable release-latch read, before any wake reanimation. */
  getSessionLifecycle?: (ownerId: string) => Promise<SessionBriefLifecycle | null>;
  /** Re-read the target's effective mode before consuming a queued wake. */
  resolveWakeModeFn?: typeof resolveWakeMode;
  /** Stage a queued delivery when manual mode became active after its emit. */
  stageManualWakeFn?: typeof stagePendingWake;
  wakeModeDeliveryLookupTimeoutMs?: number;
  /** EI-22449230917085417: delivery-time ownership read for positive
   *  `lock:grant:*` wakes. A confirmed false downgrades a delayed grant to the
   *  coord inbox; null/rejection/timeout preserves the normal wake. */
  readLockGrantOwnership?: (ownerId: string, lockId: string) => Promise<boolean | null>;
  /** Upper bound for the delivery-time lock-grant ownership lookup. */
  lockGrantOwnershipLookupTimeoutMs?: number;
  /** EI-21555327100993502: delivery-time lookup for fleet claim-release wakes.
   *  A re-claimed item is downgraded to inbox so a delayed fleet wake cannot
   *  spend a leader turn on an event that is no longer actionable. */
  getCurrentWorkItem?: typeof getWorkItem;
  /** Upper bound for the delivery-time fleet claim lookup. */
  fleetClaimReleasedLookupTimeoutMs?: number;
  /** Upper bound for the delivery-time canonical claimable lookup. */
  claimableLookupTimeoutMs?: number;
  /** EI-21901188813309549: delivery-time liveness re-check for parked/retried
   *  `fleet:member-dead:*` wakes. A confirmed non-'ended' current reading
   *  downgrades the wake to inbox instead of re-injecting a stale DEAD
   *  assertion. Injected for tests; defaults to the real resolveSessionStates. */
  resolveMemberLiveness?: typeof resolveSessionStates;
  /** Upper bound for the delivery-time fleet member-dead liveness lookup. */
  fleetMemberDeadLookupTimeoutMs?: number;
  /** EI-220670: delivery-time context-pressure read for fleet context-critical wakes. */
  getCurrentContextPressure?: (agentId: string) => Promise<ContextPressureBucket | null>;
  /** Upper bound for the delivery-time fleet context-critical lookup. */
  fleetContextCriticalLookupTimeoutMs?: number;
  /** EI-220670: current compaction/context generation for the event's member. */
  getCurrentContextEpoch?: (agentId: string) => Promise<number | null>;
  alive?: (pid: number | null) => boolean;
  /** WI-666: whether this owner has an active engine loop. Only loop owners
   *  are eligible for the bounded alive-but-uninjectable recovery leg. */
  isLoopArmed?: (ownerId: string) => Promise<boolean>;
  /** WI-666: injected force-resume seam for hermetic tests. */
  forceResume?: (pid: number) => Promise<boolean>;
  /** EI-212246: atomic single-winner claim immediately before Channel 2 resume. */
  claimResume?: (advSessionId: number) => Promise<boolean>;
  /** P-001 (wake-delivery-degradation-fix-2026-07-09): the coord-message send
   *  used to degrade a would-be DROP into a durable inbox notification.
   *  Injected for tests; defaults to the real sendMessage. */
  sendCoordMessage?: typeof sendMessage;
  /** turn-provenance P-002: the envelope+ledger tagger applied to every PTY/prompt
   *  wake delivery (never inbox bodies). Injected for tests (a hermetic test stubs
   *  it to avoid real ~/.papercusp/turn-provenance writes, or to a passthrough to
   *  assert un-tagged text); defaults to the real tagTurnForInjection. */
  tagTurn?: WakeTurnTagger;
  resumePlanRun?: (input: { runId: number; wakeText: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** turn-lifecycle-control Phase 3 (P-014): discover + inject into a live
   *  psu-hosted managed-pty session's control socket. The operator can't see it
   *  via findPty — the pty lives in the psu process (D-006). */
  findPsuHost?: typeof findLiveHost;
  injectPsuHost?: typeof injectIntoHost;
  /** WI-6862: the confirmation-carrying transport used for a COLD context-reset, so the delivery
   *  ledger can distinguish a host ACK from the optimistic bare-close fallback. Defaults to the
   *  real one — but ONLY when no `injectPsuHost` stub was supplied, since a stub has no
   *  confirmation channel and must keep today's behavior. */
  injectPsuHostWithConfirmation?: typeof injectIntoHostWithConfirmation;
  /** measured-agent-productivity P-004: owner-scoped lifecycle receipts for a
   * quota recovery, and the existing productive-tool writer used to prove the
   * recovered successor actually picked the wake up. */
  readPsuHostEventTail?: typeof readHostEventTail;
  lastProductiveToolCallAtByOwner?: typeof lastProductiveToolCallAtByOwner;
  /** queen-brief-cache-assembly B-01/P-012: fire a FRESH hive launch instead of
   *  resuming a hive-operator session. Injected for tests; default fires the
   *  hive blueprint with the wake text as kickoff. */
  fireHiveWake?: (input: { installSlug: string; kickoff: string }) => Promise<boolean>;
  /** bee-context-efficiency P-005: the fresh-context warm-inject fork seam (flag
   *  gate + fresh-bee spawn + stale-claim release). Injected for tests; defaults to
   *  the real bindings (flag OFF ⇒ never fires, legacy `--resume` carry preserved). */
  freshContext?: FreshContextDeps;
  /** session-db-archive-retire-dirs-2026-07-10 P-008: the rematerialize-on-miss
   *  seams used by the resume leg. Injected for tests; default to the real
   *  session-archive bindings, which READ PG. A unit test that leaves these
   *  un-stubbed does not merely touch the DB — it BLOCKS: the PG read never
   *  settles, so it hangs *past* the surrounding try/catch (which only catches
   *  throws) until the suite timeout. That wedged the green gate on 2026-07-10
   *  (11 wake-executor tests × 180s). Stub them in any hermetic unit test. */
  collectSessionFiles?: typeof defaultCollectSessionFiles;
  rematerializeSession?: typeof defaultRematerializeSession;
  findArchivedSessionIdForAdv?: typeof defaultFindArchivedSessionIdForAdv;
  /** WI-212651: repair an existing Codex home before resolving its rollout UUID.
   *  Injected so the archive/repair ordering is testable without PG or a live
   *  launch-spec store; the default reuses the /adv route's repair inputs. */
  ensureCodexHomeForWake?: (input: EnsureCodexHomeForWakeInput) => Promise<EnsureCodexHomeForWakeResult>;
  /** WI-3940: upper bound (ms) on each rematerialize-on-miss PG call in the
   *  resume leg. The seams above are fail-soft on REJECTION, but a WEDGED PG
   *  connection HANGS past every try/catch and stalls the whole wake pipeline
   *  (the WI-2009 hung-await class — a1a71's gate-unwedge flagged this hot
   *  path). On expiry the wake logs and proceeds down the normal miss path;
   *  the underlying query is abandoned, not cancelled. Injected for tests. */
  rematerializeTimeoutMs?: number;
  /** su-cold-auto-mode-2026-07-03 Phase 2 (P-005/P-006/P-007): the cold-auto MASTER
   *  GATE, resolved by the caller (the P-007 flag lands Phase 3). DEFAULT ()=>false ⇒
   *  the psu-host cold fork stays DORMANT — every loop wake injects the warm
   *  `mode:'turn'` turn, byte-identical to today — until a real caller wires an enabled
   *  gate. Read ONLY when a wake carries a `carry:'cold'` loop marker (never on the
   *  warm hot path). */
  coldAutoEnabled?: () => Promise<boolean>;
  /** EI-21431587306904888: streak-track a cold no-host park and pause+escalate the loop
   *  at the threshold (the ended-but-resumable limbo guard). Injected for tests;
   *  defaults to the real recordColdNoHostParkAndMaybeEscalate (fail-soft: null ⇒
   *  the caller parks exactly as before). */
  recordColdNoHostPark?: typeof recordColdNoHostParkAndMaybeEscalate;
  /** Start a new context under the exited owner's existing coord identity. */
  launchColdFreshSuccessor?: (input: {
    subscriberId: string;
    workspaceId: string;
    harness: string | null;
    wakeText: string;
    deliveryId: number;
    /** Explicit cold wakes override carry; transcript recovery preserves the source. */
    carry?: 'cold';
  }) => Promise<boolean>;
  /** P-013 part A (review-system-rework-reduction-2026-09-23, RSR-P-013-A): decide whether a
   *  dead Claude session's resume must be RE-HOMED because its account is walled. Injected
   *  for tests; defaults to the account-pool projection read in wake-rehome.ts (fail-soft:
   *  an unreadable pool is `keep`). */
  resolveWakeRehome?: (input: { workspaceId: string; route: WakeAccountRoute | null }) => Promise<WakeRehomeDecision>;
  /** P-013 part A: continue the dead session on another backend (the session-port
   *  conversion). Injected for tests; defaults to wake-rehome.ts `rehomeWakeOnBackend`. */
  rehomeWakeOnBackend?: (input: {
    subscriberId: string;
    workspaceId: string;
    harnessSlug: string | null;
    cwd: string | null;
    wakeText: string;
    backend: 'codex';
  }) => Promise<{ ok: boolean; detail: string }>;
  /** deterministic-context-carry P-021: the verdict-gated cold-by-default resolver —
   *  given the wake target's live host view, decide whether its session CLASS is
   *  drill-proven cold (COLD_BY_DEFAULT_PROVEN_CLASSES flag + gradeColdBootDrills
   *  sufficientClasses + no active interactive exchange; su-cold-by-default.ts).
   *  DEFAULT ()=>false ⇒ only explicitly cold-armed loops ever cold (today's
   *  behavior) — engine.ts wires the real classDefaultColdForWake, mirroring
   *  coldAutoEnabled so this module stays flag-system-free. Read ONLY on a loop-
   *  marked wake with no explicit carry, AFTER the master gate passed. */
  classDefaultCold?: (host: { bridgeTty?: boolean | null; lastInputAt?: number | null }) => Promise<boolean>;
  /** EI-21572316039386007: is a HUMAN actively in this exchange (a keystroke on the
   *  session's bridged TTY inside the active-exchange window)? Unlike classDefaultCold
   *  this is read on EVERY cold route including the explicit `carry:'cold'` opt-in —
   *  the opt-in previously had no human-presence guard at all, so a cold-armed loop
   *  reset a live session while its owner was mid-conversation. DEFAULT ()=>false ⇒
   *  byte-identical to today's behavior, and it is also what a genuinely headless
   *  session resolves to (no bridged TTY ⇒ no keystroke timestamp), so the cold-loop
   *  lifecycle is untouched. engine.ts wires the real activeInteractiveExchangeForWake. */
  activeInteractiveExchange?: (host: { bridgeTty?: boolean | null; lastInputAt?: number | null }) => boolean | Promise<boolean>;
  /** Read an su AUTO loop's carry-note — the P-006 cold-start anchor a RESET-CONTEXT /
   *  RECYCLE reconstructs from. Injected for tests; defaults to the real
   *  getLoopCarryNote (carry-note.ts). */
  getLoopCarryNoteFn?: (ref: { harness: string; ownerId: string; workspaceId?: string }) => Promise<string | null>;
  /** EI-10935: read an su AUTO loop's carry-note WITH its write-instant, used at
   *  ACTUAL delivery time (not just fire time) by {@link rehydrateLoopWakeText}
   *  to re-check whether a queued/staged delivery's pre-rendered checkpoint/
   *  walls text is still current. Injected for tests; defaults to the real
   *  getLoopCarryNoteWithMeta (carry-note.ts). */
  getLoopCarryNoteWithMetaFn?: typeof defaultGetLoopCarryNoteWithMeta;
  /**
   * Delivery-boundary refresh for the carry-note snapshot. The normal reader is
   * memoized so all paths in one wake agree, while this seam may perform one
   * additional read and retain whichever valid version is newer.
   */
  refreshLoopCarryNoteWithMetaFn?: typeof defaultGetLoopCarryNoteWithMeta;
  /** WI-6860: read the subscriber's loop status (for `lastTurnAt`) — used ONLY by
   *  the EI-19294445744419497 un-checkpointed-work staleness hint to compare a
   *  cold carry-note's write instant against the subscriber's actual last turn.
   *  Injected for tests; defaults to the real getLoopStatus (harness/routines/loop.ts).
   *  Without this seam, the real getLoopStatus (which opens a live Postgres
   *  connection via getOrgPg) is unmockable, so any unit test that reaches this
   *  branch trips assertRealPgAllowed and fails via vitest-fail-on-console. */
  getLoopStatusFn?: typeof getLoopStatus;
  /** EI-19984789589075138: count agent-authored tool calls in the post-note window, to
   *  distinguish a genuine working turn from a usage-wall/withheld-fire bounce that still
   *  moves `lastRealTurnAt` but did zero work. Injected for tests (same unmockable-real-PG
   *  reason as getLoopStatusFn above); defaults to the real countAgentToolCallsInWindow
   *  (harness/routines/loop.ts). */
  countAgentToolCallsFn?: typeof countAgentToolCallsInWindow;
  /** compaction-continuity-hardening-2026-07-07 P-003: assemble the subscriber's
   *  carry BRIEF (held work-items + checkpoints, standing facts/walls, armed awaits,
   *  fleet pointer) appended to a COLD injection after the carry-note. Injected for
   *  tests; defaults to the real buildCarryBrief (carry-brief.ts). Best-effort — a
   *  failed read injects the note alone. */
  buildCarryBriefFn?: (
    ownerId: string,
    opts?: { workspaceId?: string },
  ) => Promise<import('../../carry-brief').CarryBrief>;
  /** ambient-semantic-push P-003: prepare + record the ambient teaser block that
   *  rides this wake's injection (default: real prepareAmbientPushBlock, imported
   *  lazily and ONLY when PAPERCUSP_AMBIENT_CURSOR is on). Inject a stub for tests;
   *  pass `null` to force-disable even with the flag on (hermetic tests that must
   *  not touch the ambient store). */
  prepareAmbientPushBlock?: ((input: { ownerId: string }) => Promise<string>) | null;
  /** P-023 / D-008: advance the subscriber's CONTEXT GENERATION when a cold wake
   *  discards its context (see the call site). Injected for tests for the SAME
   *  unmockable-real-PG reason as getLoopStatusFn above — the default reaches
   *  Postgres via getOrgPg, which trips assertRealPgAllowed in a unit test.
   *  Defaults to the real bumpSessionEpoch (memory/session-epoch-ledger.ts);
   *  best-effort — a failed bump degrades the dedup, never the wake. */
  bumpSessionEpochFn?: (ownerId: string) => Promise<void>;
}

/**
 * The minimal live-host view the psu-host inject fork needs: the control socket
 * to write, plus the P-021 class-verdict fields (bridgeTty → session class;
 * lastInputAt → the active-interactive-exchange guard). A real PsuPtyHost
 * satisfies it; hermetic tests hand in a literal.
 */
type PsuInjectHostView = {
  sock: string;
  ownerId?: string | null;
  bridgeTty?: boolean | null;
  lastInputAt?: number | null;
  quotaBlocked?: boolean | null;
  caps?: string[] | null;
  launchedBy?: string | null;
};

export interface QuotaWakeRecoveryDecision {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'wrong-owner'
    | 'not-quota-blocked'
    | 'not-headless'
    | 'not-agent-launched'
    | 'route-not-auto'
    | 'host-capability-missing';
  operationId: string;
}

/** Pure, fail-closed eligibility gate for the one automatic lifecycle action in
 * this path. A recycle is useful only when gateway auto-routing can choose a
 * different credential, and safe only for a headless agent-owned host carrying
 * the new operation/dedup contract. */
export function decideQuotaWakeRecovery(input: {
  host: PsuInjectHostView;
  subscriberId: string;
  deliveryId: string;
  accountMode?: string | null;
}): QuotaWakeRecoveryDecision {
  const base = { operationId: input.deliveryId } as const;
  if (input.host.ownerId !== input.subscriberId) return { ...base, eligible: false, reason: 'wrong-owner' };
  if (input.host.quotaBlocked !== true) return { ...base, eligible: false, reason: 'not-quota-blocked' };
  if (input.host.bridgeTty !== false) return { ...base, eligible: false, reason: 'not-headless' };
  if (!hostIsAgentLaunched(input.host as PsuPtyHost)) {
    return { ...base, eligible: false, reason: 'not-agent-launched' };
  }
  if (input.accountMode !== 'auto') return { ...base, eligible: false, reason: 'route-not-auto' };
  if (!hostSupports(input.host as PsuPtyHost, 'quota-recovery')) {
    return { ...base, eligible: false, reason: 'host-capability-missing' };
  }
  return { ...base, eligible: true, reason: 'eligible' };
}

export interface QuotaRecoveryReceipt {
  status: 'ready' | 'dropped';
  operationId: string;
  ownerId: string;
  startedAtMs: number;
  reason: string | null;
}

/** Resolve the terminal receipt for exactly one durable delivery operation from
 * the existing per-owner host ledger. Exact operation+owner matching is the
 * mutation guard; a neighboring recovery can never confirm this one. */
export function quotaRecoveryReceiptForDelivery(
  events: readonly PtyHostEvent[],
  ownerId: string,
  operationId: string,
): QuotaRecoveryReceipt | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as Record<string, unknown>;
    if (event.kind !== 'quota-recovery-ready' && event.kind !== 'quota-recovery-dropped') continue;
    if (event.operationId !== operationId || event.recoveryOwnerId !== ownerId) continue;
    const startedAtMs = event.startedAtMs;
    if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs <= 0) continue;
    return {
      status: event.kind === 'quota-recovery-ready' ? 'ready' : 'dropped',
      operationId,
      ownerId,
      startedAtMs,
      reason: typeof event.reason === 'string' ? event.reason : null,
    };
  }
  return null;
}

/** A native turn marker proves submission; this stricter predicate proves the
 * SAME owner subsequently invoked a productive tool after recovery began. */
export function quotaRecoveryPickupConfirmed(
  receipt: QuotaRecoveryReceipt,
  latestProductiveToolCallAt: string | null | undefined,
): boolean {
  if (receipt.status !== 'ready') return false;
  const toolAtMs = latestProductiveToolCallAt ? Date.parse(latestProductiveToolCallAt) : NaN;
  return Number.isFinite(toolAtMs) && toolAtMs > receipt.startedAtMs;
}

/**
 * WI-10005134: an ACKED `deferred-*` refusal (busy gate, pending carry-respawn,
 * owner typing, quota wall) is the live psu host deciding "not now". The host is
 * alive and owns the session, so the only safe outcome is a durable park. Treating
 * it as a socket miss (null) let the executor fall through to `resume-headless`,
 * which put a second `claude --resume` process on the live session.
 */
export function parkOnHostDeferral(
  confirmation: InjectConfirmation | null | undefined,
  reason: string | null | undefined,
): WakeOutcome | null {
  if (confirmation !== 'acked' || typeof reason !== 'string' || !reason.startsWith('deferred-')) return null;
  return {
    kind: 'park',
    reason: `psu-host ${reason}: the live host deferred this wake; parked for a durable retry, never a second process`,
  };
}

/**
 * Inject a wake into a live psu-pty host, forking WARM (default) vs COLD
 * (su-cold-auto-mode-2026-07-03 Phase 2). Shared by BOTH executeWake psu-host inject
 * branches (the handle-less always-armed path + the main adv-session path) so the
 * cold fork can never be wired into one and missed in the other.
 *
 * DORMANT BY DEFAULT: the cold branch fires ONLY when decideColdWake says so — the
 * loop was armed `carry:'cold'` (the payload marker), cold-auto is enabled
 * (deps.coldAutoEnabled, DEFAULT ()=>false so nothing is cold until a caller wires the
 * P-007 gate), AND a carry-note anchor EXISTS (P-006). On {cold:true} it injects the
 * RESET-CONTEXT / RECYCLE control verb carrying the carry-note; otherwise the warm
 * `mode:'turn'` inject, byte-identical to today. FAIL-SOFT end to end: a marker-parse /
 * flag / carry-note error falls back to warm, and a failed COLD inject retries warm in
 * place — the cold path never drops or corrupts a wake.
 *
 * Returns the delivered WakeOutcome on a clean inject, a park when the live host
 * acknowledged and deferred it (WI-10005134), or null on a socket miss (the caller
 * then falls through to the normal channels, exactly as before).
 */
async function injectPsuHostWake(
  d: DeliveryWork,
  host: PsuInjectHostView,
  warmText: EnrolledWakeText,
  injectPsuHost: typeof injectIntoHost,
  deps: ExecuteWakeDeps,
  capturedCarryNoteMeta: DeliveryCarryNoteMeta | null = null,
  accountRoute: WakeAccountRoute | null = null,
): Promise<WakeOutcome | null> {
  const sock = host.sock;
  // WI-5510: read the loop-fire marker ONCE up front — both the warm and cold
  // branches below need {wakeCount, routineId} to stamp the delivery-side
  // stale-fire guard (psu-pty-host.mjs), not only the cold path's carry
  // decision. A non-loop wake (no marker) yields undefined for both — the
  // guard is then a no-op for this delivery, exactly like today.
  const loopMarker = readLoopDeliveryMarker(d.payload);
  const fireNumber = loopMarker?.wakeCount;
  const routineId = loopMarker?.routineId;
  const injectWarm = async (useConfirmation = true): Promise<WakeOutcome | null> => {
    const quotaRecovery = decideQuotaWakeRecovery({
      host,
      subscriberId: d.subscriberId,
      deliveryId: String(d.id),
      accountMode: accountRoute?.mode,
    });
    const recoveryStartedAtMs = Date.now();
    // EI-19311270129974785: thread this delivery's own durable id so a retry the
    // CLIENT believes is fresh (its ack-wait timed out, or the host's ack write
    // back failed) is recognized by the host as the SAME delivery it already
    // committed to, instead of injecting a second real duplicate turn.
    const injectMsg = {
      mode: quotaRecovery.eligible && useConfirmation ? 'recycle' : 'turn',
      data: warmText,
      fireNumber,
      routineId,
      ownerId: d.subscriberId,
      deliveryId: String(d.id),
      ...(quotaRecovery.eligible && useConfirmation
        ? {
            quotaRecovery: {
              operationId: String(d.id),
              ownerId: d.subscriberId,
              startedAtMs: recoveryStartedAtMs,
            },
          }
        : {}),
    } as const;
    // The real transport can report the host's early `accepted` ACK. That ACK
    // only means the detached gate pipeline was queued; it is not proof that a
    // turn started. Keep the durable wake parked until a later retry observes a
    // completed/duplicate outcome. Boolean test stubs retain today's behavior.
    const confirming = useConfirmation
      ? (deps.injectPsuHostWithConfirmation ?? (deps.injectPsuHost ? null : injectIntoHostWithConfirmation))
      : null;
    if (confirming) {
      const result = await confirming(sock, injectMsg);
      if (!result.ok) return parkOnHostDeferral(result.confirmation, result.reason);
      if (result.reason === 'accepted' || result.reason === 'pending-delivery-id') {
        return {
          kind: 'park',
          reason: `psu-host ${result.reason}: delivery accepted before turn-start proof; retry remains durable`,
          hostCommitPending: true,
        };
      }
      if (result.reason === 'duplicate-delivery-id') {
        const events = (deps.readPsuHostEventTail ?? readHostEventTail)(d.subscriberId);
        const receipt = quotaRecoveryReceiptForDelivery(events, d.subscriberId, String(d.id));
        if (receipt?.status === 'dropped') {
          return {
            kind: 'park',
            reason: `quota recovery operation ${d.id} dropped (${receipt.reason ?? 'unknown'}); retry remains durable`,
          };
        }
        if (receipt?.status === 'ready') {
          const latest = await (deps.lastProductiveToolCallAtByOwner ?? lastProductiveToolCallAtByOwner)([
            d.subscriberId,
          ]);
          const latestAt = latest.get(d.subscriberId) ?? null;
          if (!quotaRecoveryPickupConfirmed(receipt, latestAt)) {
            return {
              kind: 'park',
              reason:
                `quota recovery operation ${d.id} restarted owner ${d.subscriberId}, but pickup is unconfirmed; ` +
                'waiting for a productive same-owner tool invocation',
            };
          }
          return { kind: 'delivered', channel: 'psu-socket-recycle' };
        }
      }
      return {
        kind: 'delivered',
        channel: quotaRecovery.eligible ? 'psu-socket-recycle' : 'psu-socket-inject',
      };
    }
    const ok = await injectPsuHost(sock, injectMsg);
    return ok ? { kind: 'delivered', channel: 'psu-socket-inject' } : null;
  };

  let decision: ColdWakeDecision = { cold: false, reason: 'warm (cold fork not engaged)' };
  // EI-18224278118395857: the carry-note's absolute write instant, threaded into
  // renderColdWakeInjection so a cold successor can detect a note that went stale in
  // the fire→busy-gate-flush gap (see that function's `updatedAtMs` doc). null when
  // unknown (the getLoopCarryNoteFn test seam is note-only) ⇒ no stamp, byte-identical.
  let noteUpdatedAtMs: number | null = null;
  let cachedCarryNoteMeta: DeliveryCarryNoteMeta | null = null;
  try {
    const marker = loopMarker;
    // Cheap short-circuit: only a harness-scoped LOOP wake can go cold — either
    // explicitly cold-armed (carry:'cold') or, P-021, a no-carry loop marker whose
    // session class is drill-proven cold-by-default. Anything else resolves nothing
    // (no flag read, no PG carry-note read) and warms.
    if (marker?.harness && (marker.carry === 'cold' || marker.carry === undefined)) {
      const coldEnabled = await (deps.coldAutoEnabled ?? (async () => false))();
      // P-021 verdict route: resolved ONLY behind the master gate, and only for a
      // loop wake WITHOUT an explicit carry (the opt-in route needs no verdict).
      // DEFAULT ()=>false keeps the fork dormant until engine.ts wires the real
      // resolver — mirroring coldAutoEnabled.
      const classDefaultCold =
        coldEnabled && marker.carry === undefined ? await (deps.classDefaultCold ?? (async () => false))(host) : false;
      // EI-21572316039386007: human-presence read, on BOTH routes. Resolved behind the
      // master gate (like the verdict) but WITHOUT the no-explicit-carry condition —
      // the opt-in route is precisely the one that was unguarded. Cheap and local: it
      // reads a timestamp off the host view already in hand, no flag and no DB read.
      const activeInteractiveExchange = coldEnabled
        ? await (deps.activeInteractiveExchange ?? (() => false))(host)
        : false;
      if (marker.carry === 'cold' || classDefaultCold) {
        // Only pay the carry-note read when the master gate is actually on (P-006's
        // anchor is moot if cold-auto is disabled). A test-injected getLoopCarryNoteFn
        // seam is note-only (no meta stamp); the production read uses the META variant
        // (same pinned-then-newest precedence as getLoopCarryNote) so it ALSO carries
        // the write instant for the staleness stamp — no extra DB round-trip.
        let carryNote: string | null = null;
        if (coldEnabled) {
          if (deps.getLoopCarryNoteFn) {
            carryNote = await deps.getLoopCarryNoteFn({
              harness: marker.harness,
              ownerId: d.subscriberId,
              workspaceId: d.workspaceId,
            });
          } else {
            // EI-21972787374193956: re-read at the cold-injection boundary instead
            // of silently reusing the snapshot that rendered the delivery-time
            // block. The delivery-scoped refresh keeps the newest valid version,
            // while the identity comparison below makes any mixed render loud.
            const meta = await (
              deps.refreshLoopCarryNoteWithMetaFn ??
              deps.getLoopCarryNoteWithMetaFn ??
              defaultGetLoopCarryNoteWithMeta
            )({
              harness: marker.harness,
              ownerId: d.subscriberId,
              workspaceId: d.workspaceId,
            });
            cachedCarryNoteMeta = meta;
            carryNote = meta.note;
            noteUpdatedAtMs = meta.updatedAtMs;
          }
        }
        decision = decideColdWake({
          payload: d.payload,
          coldEnabled,
          carryNote,
          classDefaultCold,
          activeInteractiveExchange,
        });
      }
    }
  } catch {
    // Any resolution failure ⇒ warm (never let the cold path drop a wake).
    decision = { cold: false, reason: 'cold resolution threw — warm fallback' };
  }

  if (decision.cold) {
    // ── P-023 / D-008: A COLD WAKE IS A CONTEXT BOUNDARY, AND IT WAS THE ONLY ONE
    //    NOT SAYING SO ────────────────────────────────────────────────────────────
    //
    // The text composed below is the cold successor's ENTIRE opening context;
    // everything the predecessor was told is gone. But the coord owner id SURVIVES
    // a cold wake — so every dedup keyed on the OWNER carries across a context that
    // no longer exists, and both context folds on the turn-start rail go quiet for a
    // reader that has seen neither:
    //   • the orientation fold's cursor suppresses ("already told you"), and
    //   • the memory surfaced-ledger dedups ("already surfaced").
    // Worse, the suppression is ANTI-correlated with need: a cold wake usually
    // changes no orientation state at all — the process merely restarted — which is
    // exactly the case the fingerprint reads as "nothing to say".
    //
    // The compaction boundary already advances this counter (request-compaction.ts
    // and compact-reprime.ts); a cold wake is the same kind of boundary and was
    // simply never wired to it. This is the wiring, not a new mechanism.
    //
    // FIRST in the block, deliberately — mirroring compact-reprime's own ordering
    // ("the epoch bump deliberately happens FIRST"): the context is being discarded
    // whether or not the extras below render.
    //
    // ⚠ If a later guard DROPS this delivery (the stale-fire drop below), the bump
    // still happened. That direction is the safe one: the cost is one redundant
    // orientation block and a re-primable memory pool, against the silent stale
    // suppression this exists to remove. Fail-soft like the extras render — a wake
    // must never be dropped or delayed for memory hygiene.
    //
    // Routed through the injectable seam rather than a direct import, per WI-6860's
    // ruling a few fields above: the real reader reaches Postgres via getOrgPg,
    // which is unmockable and trips assertRealPgAllowed in any unit test that
    // reaches this branch.
    try {
      const bump =
        deps.bumpSessionEpochFn ??
        (async (ownerId: string) => {
          const [{ bumpSessionEpoch }, { getOrgPg }] = await Promise.all([
            import('../../memory/session-epoch-ledger'),
            import('@papercusp/db-org'),
          ]);
          const { sql } = getOrgPg();
          await bumpSessionEpoch(sql, ownerId);
        });
      await bump(d.subscriberId);
    } catch {
      /* never block a wake on memory hygiene */
    }
    // Wrap the carry-note with the standing re-checkpoint mandate (P-002 producer): the
    // injected text is the cold agent's ENTIRE opening context, so it must both frame the
    // note as the working state AND tell the agent to refresh it before ending — else the
    // note goes stale after one cold wake.
    // P-003: append the wider carry brief (held items + checkpoints, walls/facts, awaits,
    // fleet pointer) after the note — best-effort, note-only on any failure.
    let extras = '';
    let carryNoteForInjection = decision.carryNote;
    try {
      const buildBrief = deps.buildCarryBriefFn ?? (await import('../../carry-brief')).buildCarryBrief;
      const { annotateCarryNoteLiveContradictions, renderCarryBriefColdExtras } = await import('../../carry-brief');
      const brief = await buildBrief(d.subscriberId, { workspaceId: d.workspaceId });
      // EI-19362981097884026: put the live contradiction on the exact carried
      // imperative the successor reads, not only in the roster below it. The
      // brief already paid to hydrate citedRefs; consuming that same result here
      // keeps the note and the shared extras renderer in agreement.
      if (carryNoteForInjection) {
        carryNoteForInjection = annotateCarryNoteLiveContradictions(
          carryNoteForInjection,
          brief.citedRefs ?? [],
        );
      }
      extras = renderCarryBriefColdExtras(brief);
    } catch (e) {
      // Note-only injection — but NEVER silently (EI-8593, then EI-11484: twice a
      // CarryBrief contract drift crashed the renderer here and this swallow hid a
      // fleet-wide loss of cold-wake continuity extras until a test caught it).
      console.warn('[wake-executor] cold carry-brief extras failed (note-only injection):', e as Error);
    }
    // turn-provenance P-002: the cold injection is composed HERE (not by the
    // callers, who tag the warm text) — tag it as a loop fire so the reset/
    // recycle continuation prompt classifies as verified agent-origin.
    // EI-15799: stamp the fire number into the cold-wake text so a receiving agent
    // (or the agent's own reconciliation) can detect a delivery that lagged past a
    // later fire — see renderColdWakeInjection's wakeCount doc. WI-5510 (the
    // follow-up EI-15799 left open): ALSO stamp {fireNumber, routineId} onto the
    // envelope itself (not just the text) so the delivery-side stale-fire guard
    // can DROP a superseded delivery instead of merely labeling it.
    const coldFireCount = loopMarker?.wakeCount;
    // EI-18224278118395857: pass the note's write instant so the cold injection stamps its
    // age — the successor's only signal that a late-flushed note may be stale (its transcript
    // is gone). Undefined on the note-only test-seam path ⇒ no stamp, byte-identical.
    // EI-19294445744419497: the note's write instant only tells the successor how OLD the
    // note is; this tells it whether the note is INCOMPLETE. A turn that completed after the
    // write is un-checkpointed work, so the note's "Next action" may already be done — the
    // near-miss that motivated this had a dead session's finished-and-committed work still
    // being advertised as the next thing to do. Only meaningful alongside the write instant
    // (the render compares the two), and strictly best-effort: a cold wake must never be
    // dropped or delayed for a staleness HINT.
    let lastTurnAtMs: number | null = null;
    if (noteUpdatedAtMs != null) {
      try {
        // WI-6860: go through the injectable seam (defaults to the real
        // getLoopStatus) instead of calling the direct import — the direct call
        // was unmockable and opened a real Postgres connection in unit tests.
        const st = await (deps.getLoopStatusFn ?? getLoopStatus)(d.subscriberId);
        // WI-6951: `lastRealTurnAt` (session_turn_journal only), NOT `lastTurnAt` — and
        // deliberately with NO `?? st.lastTurnAt` fallback, which would reintroduce the bug
        // on exactly the sessions that trip it. lastTurnAt unions in the '■ session ended'
        // lifecycle marker, which is a session DEATH; a cold reset kills its predecessor, so
        // that marker lands after the final loop:checkpoint and this check reported the kill
        // instant as "you completed a turn at …". Live on this very path (su-7854d874 fire
        // #12): note written 05:29:48Z, real last turn 05:30:24Z (36s later, inside the
        // floor), session-end marker 06:00:23Z — the successor was told it had 31m of
        // un-checkpointed work and spent its opening turn recovering work that never existed.
        // A null here correctly yields NO banner: absent a journal row we cannot show a turn
        // happened, and this is a HINT — silence beats a false alarm that trains readers to
        // skip the one case (a dead session's finished work still advertised) it exists for.
        lastTurnAtMs = st?.lastRealTurnAt ? new Date(st.lastRealTurnAt).getTime() : null;
        if (lastTurnAtMs != null && !Number.isFinite(lastTurnAtMs)) lastTurnAtMs = null;
      } catch (e) {
        console.warn('[wake-executor] cold last-turn read failed (staleness hint omitted):', e as Error);
      }
    }
    // EI-19984789589075138: only worth the extra query when the banner is actually about
    // to fire (postNoteMs would clear the floor) — mirrors renderColdWakeInjection's own
    // floor check so a routine cold wake (turn shortly after the note) never pays for it.
    let agentToolCallsSinceNote: number | null = null;
    if (
      noteUpdatedAtMs != null &&
      lastTurnAtMs != null &&
      lastTurnAtMs - noteUpdatedAtMs >= COLD_NOTE_POST_TURN_FLOOR_MS
    ) {
      try {
        agentToolCallsSinceNote = await (deps.countAgentToolCallsFn ?? countAgentToolCallsInWindow)(
          d.subscriberId,
          noteUpdatedAtMs,
          lastTurnAtMs,
        );
      } catch (e) {
        console.warn('[wake-executor] cold work-evidence read failed (banner unchanged):', e as Error);
      }
    }
    const snapshotMismatch =
      capturedCarryNoteMeta && cachedCarryNoteMeta
        ? carryNoteSnapshotMismatch(capturedCarryNoteMeta, cachedCarryNoteMeta)
        : null;
    let mixedSnapshotWarning: string | null = null;
    if (snapshotMismatch && capturedCarryNoteMeta && cachedCarryNoteMeta) {
      const deliveryMeta = capturedCarryNoteMeta;
      const coldMeta = cachedCarryNoteMeta;
      mixedSnapshotWarning = [
          `⚠⚠ UNTRUSTED MIXED CARRY-NOTE SNAPSHOT: the delivery-time re-check block and the cold reset ` +
            `were composed from different carry-note identities (${snapshotMismatch.fields.join(', ')} changed). ` +
            `Do NOT treat either note as authoritative until you reconcile loop:status / loop:checkpoint.`,
          `Delivery-time re-check snapshot (${formatCarryNoteSnapshotIdentity(snapshotMismatch.refreshed)}):`,
          deliveryMeta.readFailed
            ? '(read failed — body unavailable)'
            : (deliveryMeta.note ?? '(no carry-note)'),
          `Cold-injection snapshot (${formatCarryNoteSnapshotIdentity(snapshotMismatch.cached)}):`,
          coldMeta.readFailed
            ? '(read failed — body unavailable)'
            : (coldMeta.note ?? '(no carry-note)'),
        ].join('\n');
    }
    const renderedColdWake = renderColdWakeInjection(
      carryNoteForInjection,
      extras,
      coldFireCount,
      noteUpdatedAtMs ?? undefined,
      lastTurnAtMs ?? undefined,
      agentToolCallsSinceNote,
    );
    const coldText = await tagWakeText(
      d,
      mixedSnapshotWarning ? `${mixedSnapshotWarning}\n\n${renderedColdWake}` : renderedColdWake,
      deps.tagTurn ?? tagTurnForInjection,
    );
    // Codex's cold reset is host-mapped to a hard recycle, and the fresh Codex
    // child needs the carry in CODEX_HOME/AGENTS.md rather than only as its
    // opening prompt. The psu host's carry-respawn protocol is the existing
    // transport that persists that system addendum before spawning the child.
    // Keep Claude/OMP's reset/recycle envelope byte-compatible: they consume
    // the carry through their existing control-mode path.
    const codexColdRespawn =
      d.wakeHandle?.kind === 'adv-session' && d.wakeHandle.agent?.trim().toLowerCase() === 'codex';
    const coldTransportMode: Parameters<typeof injectIntoHost>[1]['mode'] =
      codexColdRespawn ? 'carry-respawn' : decision.mode;
    // WI-6862: book what we actually KNOW. injectIntoHost's bare boolean cannot tell a host ACK
    // from the optimistic bare-close fallback, and that fallback explicitly covers a host that
    // crashed or was killed mid-delivery after accepting the connection — precisely what a
    // provider usage-limit wall does to a respawn. So a cold context-reset that never re-execed
    // was booked status='delivered' and read back to whoever was diagnosing it as a clean
    // success (observed on WI-6852: a reset booked delivered at 02:58:02.883Z whose respawn hit
    // the wall at 02:58:07.310Z).
    //
    // The confirmation is only available from the REAL transport, so when a caller/test supplied
    // its own `injectPsuHost` stub we fall through to today's exact behavior rather than
    // inventing a confirmation we do not have — additive by construction, like the WI-6852
    // part-(a) watermark.
    const confirming =
      deps.injectPsuHostWithConfirmation ?? (deps.injectPsuHost ? null : injectIntoHostWithConfirmation);
    // EI-19311270129974785: same delivery-id dedup rationale as injectWarm above —
    // the cold reset/recycle path goes through the identical gated pipeline and
    // is exposed to the identical ack-loss-then-retry duplicate.
    const injectMsg: Parameters<typeof injectIntoHost>[1] = {
      mode: coldTransportMode,
      data: coldText,
      ...(codexColdRespawn ? { systemPromptAddendum: coldText } : {}),
      fireNumber: coldFireCount,
      routineId,
      ownerId: d.subscriberId,
      deliveryId: String(d.id),
    };
    let ok: boolean;
    let confirmation: InjectConfirmation | null = null;
    let confirmationReason: string | null | undefined;
    if (confirming) {
      const r = await confirming(sock, injectMsg);
      ok = r.ok;
      confirmation = r.confirmation;
      confirmationReason = r.reason;
    } else {
      ok = await injectPsuHost(sock, injectMsg);
    }
    if (ok) {
      if (confirmationReason === 'accepted' || confirmationReason === 'pending-delivery-id') {
        return {
          kind: 'park',
          reason: `psu-host ${confirmationReason}: delivery accepted before turn-start proof; retry remains durable`,
          hostCommitPending: true,
        };
      }
      // A re-exec the host never confirmed is reported as such instead of as a clean success.
      const unconfirmed = confirmation === 'assumed-close';
      const channel: WakeChannel =
        coldTransportMode === 'recycle' || coldTransportMode === 'carry-respawn'
          ? unconfirmed
            ? 'psu-socket-recycle-unconfirmed'
            : 'psu-socket-recycle'
          : unconfirmed
            ? 'psu-socket-reset-unconfirmed'
            : 'psu-socket-reset';
      return { kind: 'delivered', channel };
    }
    // WI-10005134: a live host that DEFERRED the cold inject is not a miss —
    // re-injecting warm would only hit the same deferral.
    const coldDeferral = parkOnHostDeferral(confirmation, confirmationReason);
    if (coldDeferral) return coldDeferral;
    // Cold inject missed → warm in place rather than drop the wake. Deliberately
    // use the boolean injector here: the confirmation transport just failed, so
    // retrying that same seam would repeat the miss instead of exercising the
    // established fail-soft warm fallback.
    return injectWarm(false);
  }
  return injectWarm();
}

/**
 * Re-verify the interactive host after a failed socket write before parking the
 * delivery. A bg-host/desktop freeze can leave the discovery record and socket
 * path present while the first connect attempt races a host restart or a
 * transiently wedged socket. Re-reading discovery is cheap and, importantly,
 * can pick up a host that rebound the socket under the same owner. The delivery
 * remains durable and parked if the bounded second attempt also misses, so the
 * normal parked-row recheck still provides the later retry.
 */
async function injectPsuHostWakeWithReverify(
  d: DeliveryWork,
  warmText: EnrolledWakeText,
  findPsuHost: (ownerId: string) => PsuInjectHostView | null,
  injectPsuHost: typeof injectIntoHost,
  deps: ExecuteWakeDeps,
  capturedCarryNoteMeta: DeliveryCarryNoteMeta | null = null,
  accountRoute: WakeAccountRoute | null = null,
): Promise<WakeOutcome | null> {
  let host = findPsuHost(d.subscriberId);
  for (let attempt = 0; host && attempt < 2; attempt += 1) {
    const outcome = await injectPsuHostWake(
      d,
      host,
      warmText,
      injectPsuHost,
      deps,
      capturedCarryNoteMeta,
      accountRoute,
    );
    if (outcome) return outcome;
    // Re-read the owner-scoped discovery record after a miss. Do not reuse the
    // first host object: a live psu host may have rebound its control socket.
    host = findPsuHost(d.subscriberId);
  }
  return null;
}

/**
 * An explicitly cold loop wake has a context-boundary invariant: if its live
 * psu host is unavailable, do not fall through to `resume-headless`, because
 * that command rehydrates the predecessor transcript. Keep the check scoped
 * to the same three cold preconditions as the host-inject path (harness marker,
 * master gate, and a non-empty carry-note); disabled or unanchored cold wakes
 * retain the legacy warm resume fallback.
 */
async function coldWakeRequiresPsuHost(d: DeliveryWork, deps: ExecuteWakeDeps): Promise<boolean> {
  const marker = readLoopDeliveryMarker(d.payload);
  if (!marker?.harness || marker.carry !== 'cold') return false;

  let coldEnabled = false;
  try {
    coldEnabled = await (deps.coldAutoEnabled ?? (async () => false))();
  } catch {
    return false;
  }
  if (!coldEnabled) return false;

  let carryNote: string | null = null;
  try {
    const ref = {
      harness: marker.harness,
      ownerId: d.subscriberId,
      workspaceId: d.workspaceId,
    };
    if (deps.getLoopCarryNoteFn) {
      carryNote = await deps.getLoopCarryNoteFn(ref);
    } else {
      carryNote = (await (deps.getLoopCarryNoteWithMetaFn ?? defaultGetLoopCarryNoteWithMeta)(ref)).note;
    }
  } catch {
    return false;
  }

  // NOTE (EI-21572316039386007): deliberately NOT passing activeInteractiveExchange.
  // This predicate exists for the case where the live psu host is UNAVAILABLE — and the
  // human-presence signal is read off that very host view (lastInputAt), so in the only
  // situation this function is consulted, it would resolve fail-soft false and change
  // nothing. Reaching for a host here to answer "is a human typing" would be asking the
  // object whose absence is the precondition. The inject path above holds the real guard.
  return decideColdWake({ payload: marker, coldEnabled, carryNote }).cold;
}

/** Prefer the newest valid carry-note version while tolerating a transient/null read. */
function newestDeliveryCarryNoteMeta(
  current: DeliveryCarryNoteMeta,
  candidate: DeliveryCarryNoteMeta | null | undefined,
): DeliveryCarryNoteMeta {
  if (!candidate || typeof candidate !== 'object') return current;
  if (candidate.note === null && current.note !== null) return current;
  if (current.note === null && candidate.note !== null) return candidate;
  const currentTs = typeof current.updatedAtMs === 'number' && Number.isFinite(current.updatedAtMs)
    ? current.updatedAtMs
    : Number.NEGATIVE_INFINITY;
  const candidateTs = typeof candidate.updatedAtMs === 'number' && Number.isFinite(candidate.updatedAtMs)
    ? candidate.updatedAtMs
    : Number.NEGATIVE_INFINITY;
  return candidateTs >= currentTs ? candidate : current;
}

/** Execute one wake delivery attempt. Never throws — every failure is an outcome. */
export async function executeWake(d: DeliveryWork, deps: ExecuteWakeDeps = {}): Promise<WakeOutcome> {
  const getSession = deps.getSession ?? getAdvSession;
  const findPty = deps.findPty ?? findPtyByPid;
  const write = deps.write ?? writePty;
  const spawnManaged = deps.spawnManagedPty ?? spawnPty;
  const kill = deps.kill ?? killPty;
  const presence = deps.presence ?? getPresence;
  const getSessionLifecycle = deps.getSessionLifecycle ?? getSessionBriefLifecycle;
  const readLockGrantOwnership = deps.readLockGrantOwnership ?? readCurrentLockGrantOwnership;
  const lockGrantOwnershipLookupTimeoutMs =
    deps.lockGrantOwnershipLookupTimeoutMs ?? LOCK_GRANT_OWNERSHIP_LOOKUP_TIMEOUT_MS;
  const getCurrentWorkItem = deps.getCurrentWorkItem ?? getWorkItem;
  const fleetClaimReleasedLookupTimeoutMs =
    deps.fleetClaimReleasedLookupTimeoutMs ?? FLEET_CLAIM_RELEASED_LOOKUP_TIMEOUT_MS;
  const claimableLookupTimeoutMs = deps.claimableLookupTimeoutMs ?? CLAIMABLE_LOOKUP_TIMEOUT_MS;
  const resolveMemberLiveness = deps.resolveMemberLiveness ?? resolveSessionStates;
  const fleetMemberDeadLookupTimeoutMs =
    deps.fleetMemberDeadLookupTimeoutMs ?? FLEET_MEMBER_DEAD_LOOKUP_TIMEOUT_MS;
  const getCurrentContextPressure =
    deps.getCurrentContextPressure ??
    (async (agentId: string) => (await fetchContextPressure([agentId])).get(agentId) ?? null);
  const fleetContextCriticalLookupTimeoutMs =
    deps.fleetContextCriticalLookupTimeoutMs ?? FLEET_CONTEXT_CRITICAL_LOOKUP_TIMEOUT_MS;
  const getCurrentContextEpoch =
    deps.getCurrentContextEpoch ??
    (async (agentId: string) => {
      try {
        const [{ currentSessionEpoch }, { getOrgPg }] = await Promise.all([
          import('../../memory/session-epoch-ledger'),
          import('@papercusp/db-org'),
        ]);
        const epoch = await currentSessionEpoch(getOrgPg().sql, agentId);
        // currentSessionEpoch is deliberately fail-soft and returns 0 when its
        // ledger is unavailable. Treat that value as unknown here so a failed
        // read can never suppress a legitimate positive-generation wake.
        return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
      } catch {
        return null;
      }
    });
  const alive = deps.alive ?? pidAlive;
  const isLoopArmed =
    deps.isLoopArmed ?? (async (ownerId: string) => Boolean((await getLoopStatus(ownerId).catch(() => null))?.active));
  const forceResume = deps.forceResume ?? ((pid: number) => defaultForceResume(pid, alive));
  const isHeadlessResumeTurn = deps.isHeadlessResumeTurn ?? defaultIsHeadlessResumeTurn;
  const accountHeadlessResumeTurn = deps.accountHeadlessResumeTurn ?? defaultAccountHeadlessResumeTurn;
  const claimResume = deps.claimResume ?? claimAdvSessionResume;
  const findPsuHost = deps.findPsuHost ?? findLiveHost;
  const injectPsuHost = deps.injectPsuHost ?? injectIntoHost;
  const fireHiveWake = deps.fireHiveWake ?? defaultFireHiveWake;
  const sendCoordMessage = deps.sendCoordMessage ?? sendMessage;
  const tagTurn = deps.tagTurn ?? tagTurnForInjection;
  // EI-20460364238376772: the delivery-time carry-note read is the authority for
  // this whole wake. Rehydration runs immediately before psu-host injection, but
  // a second independent read can observe an older replica/pinned row and replace
  // the newer checkpoint in the cold reset payload. Share one promise for the
  // delivery-scoped reference so every path consumes the same snapshot.
  const readCarryNoteWithMeta = deps.getLoopCarryNoteWithMetaFn ?? defaultGetLoopCarryNoteWithMeta;
  const deliveryCarryNoteReads = new Map<string, ReturnType<typeof defaultGetLoopCarryNoteWithMeta>>();
  const getDeliveryCarryNoteWithMeta: typeof defaultGetLoopCarryNoteWithMeta = (ref) => {
    const key = JSON.stringify([ref.workspaceId ?? null, ref.harness, ref.ownerId]);
    const cached = deliveryCarryNoteReads.get(key);
    if (cached) return cached;
    const pending = Promise.resolve().then(() => readCarryNoteWithMeta(ref));
    deliveryCarryNoteReads.set(key, pending);
    return pending;
  };
  // A carry-note can be written after the first snapshot is taken but before the
  // wake reaches its actual injection/resume boundary. Refresh once there, then
  // retain the newest timestamped version so a lagging replica cannot replace it.
  const refreshDeliveryCarryNoteWithMeta: typeof defaultGetLoopCarryNoteWithMeta = async (ref) => {
    const key = JSON.stringify([ref.workspaceId ?? null, ref.harness, ref.ownerId]);
    const current = await getDeliveryCarryNoteWithMeta(ref);
    try {
      const observed = await readCarryNoteWithMeta(ref);
      const newest = newestDeliveryCarryNoteMeta(current, observed);
      deliveryCarryNoteReads.set(key, Promise.resolve(newest));
      return newest;
    } catch {
      return current;
    }
  };
  const deliveryDeps: ExecuteWakeDeps = {
    ...deps,
    getLoopCarryNoteWithMetaFn: getDeliveryCarryNoteWithMeta,
    refreshLoopCarryNoteWithMetaFn: refreshDeliveryCarryNoteWithMeta,
  };
  let capturedCarryNoteMeta: DeliveryCarryNoteMeta | null = null;
  const rehydrateForDelivery = (delivery: DeliveryWork, baseText: string): Promise<string> =>
    rehydrateLoopWakeText(delivery, baseText, {
      ...deliveryDeps,
      captureLoopCarryNoteMeta: (meta) => {
        capturedCarryNoteMeta = meta;
      },
    });
  const collectSessionFiles = deps.collectSessionFiles ?? defaultCollectSessionFiles;
  const rematerializeSession = deps.rematerializeSession ?? defaultRematerializeSession;
  const findArchivedSessionIdForAdv = deps.findArchivedSessionIdForAdv ?? defaultFindArchivedSessionIdForAdv;
  const ensureCodexHomeForWake = deps.ensureCodexHomeForWake ?? defaultEnsureCodexHomeForWake;
  const quarantineToolReferenceSession =
    deps.quarantineToolReferenceSession ?? quarantineRepeatedClaudeToolReferenceFailures;
  const recoverToolReferenceDeath =
    deps.recoverToolReferenceDeath ??
    (async (ownerId: string, opts: { workspaceId: string }): Promise<ToolReferenceDeathRecovery> => {
      // Dynamic: the watchdog module is heavy and imports this subsystem back.
      const { recoverToolReferenceDeathForOwner } = await import('../../system-health/compaction-compliance-watchdog');
      return recoverToolReferenceDeathForOwner(ownerId, opts);
    });
  const rematerializeTimeoutMs = deps.rematerializeTimeoutMs ?? REMATERIALIZE_TIMEOUT_MS;
  let claudeResumeTranscriptPath: string | null = null;
  const refreshClaudeResumeTranscript = async (
    ownerId: string | null | undefined,
    sessionId: string | null | undefined,
  ) => {
    if (!ownerId || !sessionId) return null;
    try {
      const files = await collectSessionFiles({
        sourceKind: 'claude',
        sessionId,
        sessionRoot: sessionClaudeConfigDir(ownerId),
      });
      const transcript = files.find((file) => file.rel.startsWith('projects/') && file.rel.endsWith(`${sessionId}.jsonl`));
      if (!transcript) return null;
      claudeResumeTranscriptPath = transcript.abs;
      return analyzeClaudeResumeTranscriptFile(transcript.abs);
    } catch {
      return null;
    }
  };

  try {
    // EI-203843: this is deliberately the first delivery decision. A queued
    // wake can outlive the stand-down cue by minutes (especially on a cold
    // carry respawn), so every handle-less/plan-run/pty/resume path must share
    // this terminal gate before it can inject, spawn, or resume anything.
    const lifecycle = await getSessionLifecycle(d.subscriberId).catch(() => null);
    const released = lifecycle?.released;
    if (released) {
      return {
        kind: 'drop',
        reason:
          `session ${d.subscriberId} is released from fleet ${released.fleet} ` +
          `(marked ${released.at} by ${released.by}) — end now; queued wake suppressed`,
      };
    }

    // A wake may wait in the delivery queue after its emit-time admission. Re-read
    // the authoritative mode before any continuation/injection/resume branch so a
    // later manual pause moves the wake into the same owner-review queue as a
    // send that arrived while already paused.
    const wakeModeRead = await withBoundedTimeout(
      () => (deps.resolveWakeModeFn ?? resolveWakeMode)(d.subscriberId),
      {
        fallback: 'auto' as const,
        timeoutMs: deps.wakeModeDeliveryLookupTimeoutMs ?? WAKE_MODE_DELIVERY_LOOKUP_TIMEOUT_MS,
        label: 'wake-executor:delivery-mode',
      },
    ).catch(() => ({ value: 'auto' as const }));
    if (wakeModeRead.value === 'manual') {
      const [
        {
          isLoopWakeSource,
          isOwnerGuiWakeSource,
          isDeliveryLadderWakeSource,
          isEscalationSlaRerouteWakeSource,
          MANUAL_WAKE_QUEUE_RELEASE_SOURCE_PREFIX,
          inboxWakeKey,
        },
        { isOwnerVerifiedRelay, readRelayProvenance },
      ] = await Promise.all([
        import('../../agent-tools/coordination/inbox-wake'),
        import('../../agent-tools/coordination/relay-provenance'),
      ]);
      const source = d.source ?? undefined;
      const payloadRecord =
        d.payload !== null && typeof d.payload === 'object' && !Array.isArray(d.payload)
          ? (d.payload as Record<string, unknown>)
          : null;
      const recordOf = (value: unknown): Record<string, unknown> | null =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const ownerVerifiedRelayPayload = (payload: unknown): boolean =>
        isOwnerVerifiedRelay(readRelayProvenance(recordOf(payload)));
      // Relay authority is carried only on the addressed coord inbox-wake. The
      // event pump wraps coalesced rows under `events[]`; require every component
      // to be an owner-verified inbox relay so one approved message cannot
      // authorize an unrelated sibling in the same coalesced turn. Ambiguous
      // legacy/latest-only envelopes stay in the owner-review queue.
      const ownerVerifiedInboxRelay =
        d.eventKey === inboxWakeKey(d.subscriberId) &&
        (payloadRecord?.coalesced === true
          ? Array.isArray(payloadRecord.events) &&
            payloadRecord.events.length > 0 &&
            payloadRecord.events.every((value) => {
              const component = recordOf(value);
              return component?.event === d.eventKey && ownerVerifiedRelayPayload(component.payload);
            })
          : ownerVerifiedRelayPayload(payloadRecord));
      const bypassManualGate =
        isLoopWakeSource(source) ||
        isOwnerGuiWakeSource(source) ||
        isDeliveryLadderWakeSource(source) ||
        isEscalationSlaRerouteWakeSource(source) ||
        (source ?? '').startsWith(MANUAL_WAKE_QUEUE_RELEASE_SOURCE_PREFIX) ||
        ownerVerifiedInboxRelay;
      if (!bypassManualGate) {
        await (deps.stageManualWakeFn ?? stagePendingWake)({
          ownerId: d.subscriberId,
          summary: d.summary ?? undefined,
          payload: d.payload,
          source: d.source ?? undefined,
          workspaceId: d.workspaceId,
        });
        return {
          kind: 'drop',
          reason: 'effective wake mode is manual at delivery time; queued wake staged for owner review',
        };
      }
    }

    // EI-24119981583160918: an auto-armed blocked-item await can fire before
    // its target settles, leaving a delivery queued after the one-shot itself
    // is no longer cancellable. Revalidate the stamped lifecycle binding before
    // any wake side effect so a terminal target does not spend a full turn.
    const blockedBoundFreshness = await revalidateBlockedBoundDelivery(
      d,
      getCurrentWorkItem,
      claimableLookupTimeoutMs,
    );
    d = blockedBoundFreshness.delivery;
    if (blockedBoundFreshness.staleOnly) {
      return {
        kind: 'drop',
        reason:
          `blocked-item-holder wake is stale because bound work-item(s) ` +
          `${blockedBoundFreshness.staleIds.join(', ')} are terminal`,
      };
    }

    // EI-22449230917085417: the lock-grant bridge fires once and queues a
    // durable delivery, but the owner can finish its edit and release the lock
    // before the pump reaches that row. Only a positive, successful ownership
    // read is authoritative here; an unknown read must not swallow a real grant.
    const lockGrantCheck = await currentLockGrantIsStale(
      d,
      readLockGrantOwnership,
      lockGrantOwnershipLookupTimeoutMs,
    );
    if (lockGrantCheck.stale && lockGrantCheck.lockId) {
      const staleDelivery = {
        ...d,
        summary:
          `⚠ STALE — lock ${lockGrantCheck.lockId} is no longer held by ${d.subscriberId}; ` +
          `do NOT act on this delayed grant. Original now-RETRACTED assertion: ${d.summary}`,
      };
      return degradeToInboxOrDrop(
        staleDelivery,
        `lock grant ${lockGrantCheck.lockId} is STALE and RETRACTED at delivery time; ownership is no longer present`,
        sendCoordMessage,
      );
    }

    // EI-21555327100993502: `fleet:claim-released:<slug>` is a snapshot of an
    // item returning to the pool. It is allowed to arrive late, after another
    // worker has already claimed that same item. Re-check immediately before
    // any injection/resume side effect and use the durable inbox as an
    // informational fallback when the event is no longer actionable. The
    // helper fails open on every uncertain read, preserving the normal wake.
    const currentReleasedItem = await currentFleetClaimReleasedItem(
      d,
      getCurrentWorkItem,
      fleetClaimReleasedLookupTimeoutMs,
    );
    if (currentReleasedItem && typeof currentReleasedItem.assignee === 'string' && currentReleasedItem.assignee.trim()) {
      const staleDelivery = {
        ...d,
        summary:
          `${d.summary} (delivery-time check: ${currentReleasedItem.id} is already claimed by ` +
          `${currentReleasedItem.assignee}; wake downgraded to inbox)`,
      };
      return degradeToInboxOrDrop(
        staleDelivery,
        `work item ${currentReleasedItem.id} is already claimed by ${currentReleasedItem.assignee}`,
        sendCoordMessage,
      );
    }

    // EI-21901188813309549: `fleet:member-dead:<slug>` asserts a present-tense
    // DEAD transition captured once at emit time. That emit-time check does not
    // re-run on a later retry of a parked delivery (or on any other path that
    // re-delivers this same payload), so a member that recovers — or a
    // transiently-misread observation — keeps re-waking the leader with a claim
    // that is no longer true. Re-check the SAME shared liveness oracle right
    // before injection; a confirmed non-'ended' current state downgrades the
    // wake instead of re-asserting a stale death. Fail-open on every uncertain
    // read, exactly like the claim-released check above.
    //
    // EI-22068041747784942: the downgrade message used to APPEND the correction
    // after the ORIGINAL "member X is DEAD" assertion (`${d.summary} (delivery-time
    // check: ...)`), so a reader/agent skimming only the leading clause could still
    // come away believing the member is dead — exactly the misread that risks a
    // leader "destructively recovering" (relaunching/reclaiming) a still-live
    // holder, even though the wake-executor itself never resumes/PTY-injects on a
    // confirmed-stale member-dead delivery (see the tests above this block).
    // Lead with the CURRENT, CORRECTED truth instead, and fold the original claim
    // in as an explicitly-labeled RETRACTED quote rather than a fresh assertion —
    // so the first thing anyone reads is "this is stale, do not act on it".
    const memberDeadCheck = await currentFleetMemberDeadIsStale(
      d,
      resolveMemberLiveness,
      fleetMemberDeadLookupTimeoutMs,
    );
    if (memberDeadCheck.stale) {
      const parsedMemberDead = parseFleetMemberDeadPayload(d.payload);
      const staleAgentId = parsedMemberDead?.agentId ?? 'unknown';
      const staleDelivery = {
        ...d,
        summary:
          `⚠ STALE — fleet member ${staleAgentId} is currently '${memberDeadCheck.currentState}', ` +
          `not 'ended' (recovered since this wake was queued). Do NOT treat this as a live death ` +
          `signal or act on it (no relaunch/reclaim/release). Original now-RETRACTED assertion: ${d.summary}`,
      };
      return degradeToInboxOrDrop(
        staleDelivery,
        `fleet member ${staleAgentId} is currently '${memberDeadCheck.currentState}', not 'ended' — this member-dead wake is STALE and RETRACTED, do not act on it`,
        sendCoordMessage,
      );
    }

    // EI-220670: context-critical is a fire-time pressure/generation snapshot.
    // Revalidate it immediately before any wake side effect. Confirmed recovery
    // or a newer context generation is downgraded to the durable inbox; missing,
    // malformed, timed-out, or failed reads preserve the normal wake (fail-open).
    const contextCriticalCheck = await currentFleetContextCriticalIsStale(
      d,
      getCurrentContextPressure,
      getCurrentContextEpoch,
      fleetContextCriticalLookupTimeoutMs,
    );
    if (contextCriticalCheck.stale) {
      const parsedContextCritical = parseFleetContextCriticalPayload(d.payload);
      const staleAgentId = parsedContextCritical?.agentId ?? 'unknown';
      const staleReasons = [
        contextCriticalCheck.currentPressure !== null && contextCriticalCheck.currentPressure !== 'critical'
          ? `currently '${contextCriticalCheck.currentPressure}', not 'critical'`
          : null,
        parsedContextCritical?.contextEpoch != null && contextCriticalCheck.currentEpoch !== null
          ? `context generation ${contextCriticalCheck.currentEpoch} superseded emitted generation ${parsedContextCritical.contextEpoch}`
          : null,
      ].filter((reason): reason is string => reason !== null);
      const detail = staleReasons.join('; ');
      const staleDelivery = {
        ...d,
        summary:
          `⚠ STALE — fleet member ${staleAgentId} context-critical wake is no longer current (${detail}). ` +
          `Do NOT treat it as a live compaction signal or act on it. Original now-RETRACTED assertion: ${d.summary}`,
      };
      return degradeToInboxOrDrop(
        staleDelivery,
        `fleet member ${staleAgentId} context-critical wake is STALE and RETRACTED — ${detail}; do not act on it`,
        sendCoordMessage,
      );
    }

    // EI-21584263523911583: the canonical claimable payload is a fire-time snapshot.
    // Revalidate every claimable component immediately before any wake side effect so
    // a requeued/open payload cannot revive a member for an item that is now terminal,
    // claimed, or parked. Coalesced unions retain unrelated live components; only the
    // confirmed-stale claimable entries are removed.
    const claimableFreshness = await revalidateClaimableDelivery(d, getCurrentWorkItem, claimableLookupTimeoutMs);
    d = claimableFreshness.delivery;
    if (claimableFreshness.staleOnly) {
      return degradeToInboxOrDrop(
        d,
        `work-item:claimable delivery revalidated stale item(s): ${claimableFreshness.staleIds.join(', ')}`,
        sendCoordMessage,
      );
    }

    // EI-21157954408185498: a loop fire can already be queued when loop:end or
    // a re-arm advances the loop lifecycle. The text rehydration below still
    // annotates such a fire, but annotation is insufficient: every delivery
    // channel would otherwise replay the old imperative and recreate awaits.
    // Drop only on a confirmed ended/re-armed status; a status-read failure is
    // fail-open so a transient PG issue cannot strand an otherwise valid wake.
    // EI-21393930883750326: the drop verdict is composition-aware — it holds
    // only for a PURELY-loop attempt. A coalesced union that also carries a
    // non-loop component (a one-shot await-event / timeout fire) is DELIVERED,
    // with the stale loop imperative neutralized by the rehydration banner,
    // because suppressing it wholesale silently strands the parked waiter.
    const loopLifecycle = await readLoopDeliverySupersession(d, deps.getLoopStatusFn ?? getLoopStatus);
    d = loopLifecycle.delivery;
    const loopSupersession = loopLifecycle.supersession;
    if (loopSupersession) {
      const lifecycleReason =
        loopSupersession.kind === 'ended'
          ? 'the loop is ended or has no current active row'
          : loopSupersession.kind === 're-armed'
            ? 'the loop was re-armed after this delivery was created'
            : `the wake harness lineage ${loopSupersession.markerHarness} does not match the current active loop ` +
              `harness ${loopSupersession.currentHarness}`;
      if (loopSupersession.kind === 'lineage-mismatch') {
        // EI-21567207447038868: the lineage guard protects the CURRENT loop
        // from stale loop state, but the delivery may be the sole result of a
        // one-shot await (for example claim:released:<id>). A bare drop consumes
        // that delivery attempt without telling the subscriber its event fired,
        // silently stranding an await with no timeout. Preserve the no-resume /
        // no-injection safety decision while routing the event and exact
        // withholding reason through the durable inbox fallback.
        return degradeToInboxOrDrop(
          d,
          `${lifecycleReason}; loop injection/resume was withheld`,
          sendCoordMessage,
        );
      }
      return {
        kind: 'drop',
        reason:
          `queued loop delivery #${d.id} suppressed: ${lifecycleReason}; ` +
          `no injection, resume, or plan continuation was performed`,
      };
    }

    // Ambient-push delivery rail (ambient-semantic-push P-003) — DEFAULT-OFF behind
    // PAPERCUSP_AMBIENT_CURSOR. Best-effort: prepare + record the teaser block that
    // rides THIS wake's injection (capped by applyInjectionDoor below — the injection
    // door tally). The env check is BEFORE the dynamic import so the off-path loads no
    // ambient code, and the whole thing is fail-soft — an ambient fault never blocks a
    // wake. Skipped for a deps-overridden test harness that opts out.
    const ambientFlag = process.env.PAPERCUSP_AMBIENT_CURSOR;
    if ((ambientFlag === '1' || ambientFlag === 'true') && deps.prepareAmbientPushBlock !== null) {
      try {
        const prepare =
          deps.prepareAmbientPushBlock ?? (await import('../../ambient-push-delivery')).prepareAmbientPushBlock;
        const block = await prepare({ ownerId: d.subscriberId });
        if (block) d.ambientPushBlock = block;
      } catch {
        /* ambient delivery must never break a wake */
      }
    }

    /**
     * P-022 / D-007 — fold the subscribed cell's DELIVERY-TIME reading into this wake.
     *
     * Here, and not at the fire site, is the whole point: `payload.observed` is a
     * fire-time snapshot and the fire→delivery gap is where it goes stale (a parked
     * session boots, a cold carry respawns, a busy session drains its queue first).
     * Same fail-soft contract as the ambient block above — the helper is TOTAL and
     * budget-bounded, so a slow or broken resolver costs this wake nothing.
     */
    try {
      const fold = await prepareCellWakeFold({ eventKey: d.eventKey, workspaceId: d.workspaceId });
      if (fold) d.cellWakeFoldBlock = fold;
    } catch {
      /* a fold must never break a wake */
    }

    const handle = d.wakeHandle;
    if (!handle) {
      // Registered without a resumable session (warned at registration). BUT a
      // live psu-pty host socket can still wake it in place — it injects into the
      // live session by ownerId and needs no resumable handle (EI-152: handle-less
      // always-armed inbox-wakes were parking even with a live socket available,
      // because the socket inject below sat under this early-return).
      const rehydratedText = await rehydrateForDelivery(d, wakeTurnText(d));
      const outcome = await injectPsuHostWakeWithReverify(
        d,
        await tagWakeText(d, applyInjectionDoor(d, rehydratedText), tagTurn),
        findPsuHost,
        injectPsuHost,
        deliveryDeps,
        capturedCarryNoteMeta,
        null,
      );
      if (outcome) return outcome;
      // No injectable socket: presence fresh → park (a one-time inbox nudge
      // reaches it, engine.ts); gone/stale → degrade straight to a durable
      // coord inbox delivery instead of dropping outright (P-001).
      const p = await presence(d.subscriberId).catch(() => null);
      if (p && !p.stale && !p.revoked) return { kind: 'park', reason: 'no wake handle; presence live — inbox only' };
      return degradeToInboxOrDrop(d, 'no wake handle and presence gone/stale — dead waiter', sendCoordMessage);
    }

    if (handle.kind === 'plan-run') {
      // Woken via the plans:resume path — fire the continuation turn with the
      // wake reason as the prompt. Lazy import keeps the engine free of a
      // static plans-tool dependency.
      const resumePlanRun = deps.resumePlanRun ?? (await import('./plan-run-wake')).resumePlanRunForWake;
      const planRunText = await tagWakeText(
        d,
        applyInjectionDoor(d, await rehydrateForDelivery(d, wakeTurnText(d))),
        tagTurn,
      );
      const r = await resumePlanRun({ runId: handle.runId, wakeText: planRunText });
      if (r.ok) return { kind: 'delivered', channel: 'plan-run-resume' };
      return { kind: 'error', error: r.error };
    }

    // ── adv-session handle ───────────────────────────────────────────────
    const fresh = await getSession(handle.advSessionId).catch(() => null);
    const sessionAgent = fresh?.agent ?? handle.agent;
    const sessionOwner = fresh?.coordOwnerId ?? d.subscriberId;
    const sessionId = fresh?.sessionId ?? handle.sessionId;
    const claudeTranscriptAnalysis = sessionAgent === 'claude'
      ? await refreshClaudeResumeTranscript(sessionOwner, sessionId)
      : null;
    const priorPoison = lifecycle?.poisoned;
    if (
      priorPoison && priorPoison.advSessionId === handle.advSessionId &&
      (!fresh || priorPoison.startedAt === fresh.startedAt)
    ) {
      return {
        kind: 'drop',
        reason: `Claude session incarnation ${handle.advSessionId} is quarantined: ${priorPoison.reason}`,
      };
    }
    // The await/delivery plane is intentionally pinned to DEFAULT_COORD_WORKSPACE
    // (WI-3575), so d.workspaceId is the coordination workspace, not necessarily
    // the agent's tenant. A process-exit resume must re-export the persisted
    // adv-session workspace or a loop wake can silently relaunch the agent in
    // `default` even while its session row and coord identity remain correctly
    // scoped to another workspace.
    const sessionDelivery = fresh?.workspaceId ? { ...d, workspaceId: fresh.workspaceId } : d;
    const pid = fresh?.pid ?? handle.pid;
    const ended = fresh?.endedAt != null;
    const pidKnown = pid != null && pid > 0;
    // Liveness: a recorded pid is authoritative; with NO pid recorded (hook-
    // bootstrapped sessions), FRESH presence is the alive-evidence — resuming
    // a session whose process is actually still open would run a concurrent
    // second client on the same session file. When in doubt, park (the parked
    // row converts to a resume once presence goes stale or the row ends).
    let isAlive: boolean;
    if (ended) {
      isAlive = false;
    } else if (pidKnown) {
      isAlive = alive(pid);
    } else {
      const p = await presence(d.subscriberId).catch(() => null);
      isAlive = Boolean(p && !p.stale && !p.revoked);
    }

    // A live interactive transcript has no detached-child exit callback. Check
    // the saved assistant-turn streak before injecting another wake. A dead
    // Claude session also needs the reconciled detector before Channel 2 resumes
    // it, even when this local transcript scan could not find its file.
    //
    // WI-10003466 (su-7dc2cf9d, 2026-09-27): RECOVER FIRST. A transient MCP
    // disconnect makes the client drop its papercusp-su tools, and every later
    // request replays a saved `tool_reference` the provider now rejects — the
    // session cannot take a turn on its own, but it is NOT unrecoverable: a fresh
    // successor (new transcript + new MCP connection) under the same coord id is
    // exactly what the compaction watchdog's forced carry-respawn produces for the
    // sibling "Prompt is too long" death. Quarantining here ENDED a healthy
    // release-drive session 15 minutes after a 20-second transport blip, pre-empting
    // every heal path. So: a queued (or already-pending) recovery parks this wake
    // for the successor; `not-dead` means the RECONCILED live transcript is healthy
    // (this row names a dead predecessor's) and the wake proceeds; only
    // `unrecoverable` (no live carry-respawn-capable host) falls through to the
    // quarantine below.
    let reconciledTranscriptHealthy = false;
    if (
      sessionAgent === 'claude' &&
      (!isAlive || Boolean(claudeTranscriptAnalysis?.needsFreshContext && claudeResumeTranscriptPath))
    ) {
      const recovery = await recoverToolReferenceDeath(sessionOwner, {
        workspaceId: fresh?.workspaceId ?? sessionDelivery.workspaceId,
      }).catch((): ToolReferenceDeathRecovery => 'unrecoverable');
      if (recovery === 'queued' || recovery === 'in-grace') {
        const rejectionStreak = claudeTranscriptAnalysis?.trailingMissingToolReferenceTurns;
        const rejectionDetail = rejectionStreak != null
          ? `${rejectionStreak} consecutive rejected turns: ${claudeTranscriptAnalysis?.lastMissingToolReferenceName ?? 'unknown tool'}`
          : 'confirmed by the reconciled transcript detector';
        return {
          kind: 'park',
          reason:
            `Claude session replays an unavailable tool reference (${rejectionDetail}); ` +
            `carry-respawn onto fresh context ${recovery === 'queued' ? 'queued' : 'already pending'} — ` +
            `this wake re-delivers to the successor`,
        };
      }
      reconciledTranscriptHealthy = recovery === 'not-dead';
    }
    if (
      !reconciledTranscriptHealthy &&
      isAlive && sessionAgent === 'claude' && claudeTranscriptAnalysis?.poisoned && claudeResumeTranscriptPath
    ) {
      const poisonContext: ResumeTurnContext = {
        advSessionId: handle.advSessionId,
        ownerId: sessionOwner,
        sessionId,
        startedAt: fresh?.startedAt ?? null,
        workspaceId: fresh?.workspaceId ?? sessionDelivery.workspaceId,
        agent: 'claude',
        transcriptPath: claudeResumeTranscriptPath,
      };
      const quarantine = await quarantineToolReferenceSession(
        poisonContext,
        claudeTranscriptAnalysis.lastMissingToolReferenceEvidence ?? 'unavailable Papercusp tool reference',
      );
      if (quarantine.poisoned) {
        const reason = `Claude session quarantined after ${quarantine.turns} consecutive unavailable tool-reference turns`;
        const poisonedContext = { ...poisonContext, poisoned: true, poisonReason: reason };
        await notifyPoisonedResumeSession(
          sessionDelivery,
          poisonedContext,
          claudeTranscriptAnalysis.lastMissingToolReferenceEvidence ?? 'unavailable Papercusp tool reference',
          sendCoordMessage,
        );
        return { kind: 'drop', reason };
      }
    }

    const text = await tagWakeText(
      sessionDelivery,
      applyInjectionDoor(
        sessionDelivery,
        await rehydrateForDelivery(sessionDelivery, wakeTurnText(sessionDelivery)),
      ),
      tagTurn,
    );

    // Channel 1b (turn-lifecycle-control Phase 3, P-014): a live INTERACTIVE psu
    // session hosts its pty + control socket in the psu PROCESS (D-006), so our
    // findPty can't see it and the pid logic below would PARK it (or worse,
    // resume a concurrent second client). A live psu-pty host is the
    // authoritative "alive + injectable" signal — self-validating (host pid alive
    // + socket present) — so inject the wake turn in place; on any miss fall
    // through to the normal channels.
    const liveAccountRoute = wakeAccountRouteFromArgv(fresh?.launchArgv, d.subscriberId);
    const outcome = await injectPsuHostWakeWithReverify(
      sessionDelivery,
      text,
      findPsuHost,
      injectPsuHost,
      deliveryDeps,
      capturedCarryNoteMeta,
      liveAccountRoute,
    );
    if (outcome) return outcome;

    if (isAlive && pidKnown) {
      // Channel 1: one of our managed ptys? (pid match — /adv-spawned sessions).
      // Owner-scoped (EI-151): a recorded pid the OS recycled to a DIFFERENT
      // agent's live managed pty must NOT match — injecting here would deliver
      // THIS subscriber's wake turn into the unrelated agent's session. The
      // finder rejects a pty tagged with a foreign owner; an untagged pty
      // (shell pane / legacy) still matches.
      const pty = findPty(pid, d.subscriberId);
      if (pty) {
        // Submit as TWO writes: the text, then the Enter (CR) as a SEPARATE
        // keystroke after a settle. A one-shot text+CR burst is swallowed by the
        // claude TUI's paste detector (CR → literal newline, turn never submits).
        // Mirror of psu-pty-host.mjs controlWrites (different process + pty owner,
        // so the code can't be shared — kept in lockstep via the shared env var).
        const okWrite = write(pty.id, Buffer.from(text, 'utf8'), pty.accessScope);
        if (okWrite) {
          setTimeout(() => {
            try {
              write(pty.id, Buffer.from('\r', 'utf8'), pty.accessScope);
            } catch {
              /* pty may have closed between the text write and the CR */
            }
          }, TURN_SUBMIT_CR_DELAY_MS).unref?.();
          return { kind: 'delivered', channel: 'pty-inject' };
        }
      }
      // WI-10002854: the recorded pid can be a headless turn that an earlier wake
      // started for this same session and that is still running. It will finish
      // and exit by itself. Forcing it (the WI-666 SIGINT below) would kill a turn
      // in progress. A second resume would put two processes on one session. So
      // park, and deliver once the turn has exited.
      const liveResumeId =
        handle.agent === 'omp' ? (fresh?.ompThreadId ?? handle.ompThreadId ?? null) : (fresh?.sessionId ?? handle.sessionId ?? null);
      if (isHeadlessResumeTurn(pid, liveResumeId)) {
        return {
          kind: 'park',
          reason: `headless resume turn pid ${pid} is still running for this session; parked until it exits`,
        };
      }
      // WI-666: a warm engine-loop owner is explicitly unattended and its
      // native session is resumable. If its process is alive but no longer
      // injectable (the detached-terminal / curl dead zone), end this turn
      // with a bounded SIGINT and continue through the normal resume leg once
      // the process exits. Ordinary interactive sessions stay parked: without
      // the active loop marker, forcing a live terminal would be unsafe.
      const resumable = Boolean(
        (handle.agent === 'claude' && (fresh?.sessionId ?? handle.sessionId)) ||
        (handle.agent === 'omp' && (fresh?.ompThreadId ?? handle.ompThreadId)) ||
        (handle.agent === 'codex' && (fresh?.sessionId ?? handle.sessionId)),
      );
      const loopArmed = resumable
        ? await withWakeTimeout(isLoopArmed(d.subscriberId), `loop status/${d.subscriberId}`, 1_000)
        : false;
      if (loopArmed === true) {
        const exited = await forceResume(pid).catch(() => false);
        if (exited) {
          isAlive = false;
        } else {
          return {
            kind: 'park',
            reason: `loop owner pid ${pid} stayed alive after bounded force-resume; parked safely for a later retry`,
          };
        }
      }
      if (!isAlive) {
        // The bounded force leg ended the old turn; continue to Channel 2
        // below instead of attempting a keystroke against a dead process.
      } else {
        // Channel 3: alive in a terminal we don't own, OR the live managed pty at
        // this pid belongs to a different agent (recycled pid, EI-151) — either
        // way not an injectable pty for THIS subscriber → park (+ inbox nudge).
        return {
          kind: 'park',
          reason: `session pid ${pid} alive but not an injectable managed pty for this subscriber`,
        };
      }
    }
    if (isAlive) {
      // No pid recorded but presence is fresh — the session is (very likely)
      // still open somewhere we can't see. Never concurrent-resume it; park.
      return {
        kind: 'park',
        reason: 'no recorded pid but presence is fresh — parking to avoid a concurrent resume of a live session',
      };
    }

    // WI-10005134: every channel below STARTS A NEW PROCESS for this session
    // (cold successor, hive fresh wake, fresh-context fork, backend re-home,
    // resume-headless). The recorded pid above can be stale while the session
    // is still alive: a psu host carry-respawns its CLI child under a new pid.
    // A live, identity-verified psu host is the authoritative "this session is
    // running" signal, so if the host ladder above did not take the wake, park.
    // A parked delivery is retried; a second process on one session is not
    // recoverable (measured 2026-10-01: three wakes for su-9dfd3ffc went
    // resume-headless while its host was live and deferring them).
    if (findPsuHost(d.subscriberId)) {
      return {
        kind: 'park',
        reason:
          'live psu host owns this session but did not take the wake inject; parked instead of starting a second process (WI-10005134)',
      };
    }

    // A cold wake cannot safely use Channel 2: `resume-headless` restores the
    // predecessor transcript, defeating the fresh-context contract. The host
    // ladder has already had its bounded attempts above; park until a host is
    // available rather than silently reopening the old context. This is only
    // active for an eligible explicit-cold wake; warm/disabled/unanchored wakes
    // preserve the normal resume fallback below.
    const coldWakeNeedsHost = await coldWakeRequiresPsuHost(sessionDelivery, deliveryDeps);
    // EI-24797049094820185: a detached Claude turn has no managed host to
    // carry-respawn. After its process exits, replaying the rejected transcript
    // just produces the same API 400. Reuse the identity-preserving successor
    // path below, even for warm/event wakes, without changing its carry policy.
    const rejectedTranscriptNeedsSuccessor = sessionAgent === 'claude' &&
      !reconciledTranscriptHealthy && Boolean(claudeTranscriptAnalysis?.needsFreshContext);
    if (coldWakeNeedsHost || rejectedTranscriptNeedsSuccessor) {
      // The former P-013 inbox fallback discarded the cold marker. Its second
      // delivery therefore resumed the old Codex UUID and kept the critical
      // context. Use the existing identity-preserving successor launch instead.
      const launchSuccessor = deps.launchColdFreshSuccessor ?? (async (input: {
        subscriberId: string; workspaceId: string; harness: string | null;
        wakeText: string; deliveryId: number; carry?: 'cold';
      }) => {
        const { default: launchTool } = await import('../../agent-tools/capability/launch-agent');
        const result = await launchTool.handler({
          successor: { agentId: input.subscriberId },
          brief: input.wakeText,
          harness: input.harness ?? undefined,
          headless: true,
          carry: input.carry,
          idempotencyKey: `cold-wake:${input.deliveryId}`,
        } as never, {
          workspaceId: input.workspaceId,
          harnessSlug: input.harness,
          role: 'su',
        } as never);
        const launch = (result as { data?: { launch?: { tasks?: Array<{ ownerId?: string }> } }; isError?: boolean }).data?.launch;
        return !('isError' in result && result.isError) && !!launch?.tasks?.some((task) => task.ownerId === input.subscriberId);
      });
      const successorStarted = await launchSuccessor({
        subscriberId: d.subscriberId,
        workspaceId: fresh?.workspaceId ?? sessionDelivery.workspaceId,
        harness: fresh?.harnessSlug ?? readLoopDeliveryMarker(d.payload)?.harness ?? null,
        wakeText: text,
        deliveryId: d.id,
        ...(coldWakeNeedsHost ? { carry: 'cold' as const } : {}),
      }).catch((error) => {
        console.warn(`[wake-executor] cold fresh successor failed for ${d.subscriberId}: ${String(error)}`);
        return false;
      });
      if (successorStarted) return { kind: 'delivered', channel: 'cold-fresh-successor' };
      if (rejectedTranscriptNeedsSuccessor && !coldWakeNeedsHost) {
        return {
          kind: 'park',
          reason: 'Claude transcript repeatedly references an unavailable tool; fresh successor failed — parked without replaying the rejected transcript',
        };
      }
      // No inbox-wake watcher (or the fan failed): nothing else can carry this fire,
      // so the limbo guard below still streaks it toward pause + escalation.
      // EI-21431587306904888: for an ENDED session no injectable host ever
      // reappears on its own, so an unbounded park here is a black hole — the
      // loop burns fires forever and the owner's lane strands silently (the
      // ended-but-resumable limbo window). Track the streak of DISTINCT
      // consecutive undeliverable cold fires and, at the threshold, pause the
      // loop + escalate loudly (owner policy: pause+escalate, NOT auto-respawn).
      // Fail-soft: any tracking failure parks exactly as before.
      const trackColdPark = deps.recordColdNoHostPark ?? recordColdNoHostParkAndMaybeEscalate;
      const parkMarker = readLoopDeliveryMarker(d.payload);
      const verdict = await trackColdPark({
        routineId: parkMarker?.routineId ?? null,
        wakeCount: parkMarker?.wakeCount ?? null,
        subscriberId: d.subscriberId,
      }).catch(() => null);
      if (verdict?.action === 'escalated') {
        return {
          kind: 'park',
          reason:
            `eligible cold loop wake has no injectable psu host — ${verdict.streak} distinct consecutive ` +
            'undeliverable cold fires: loop AUTO-PAUSED + escalated instead of parking indefinitely ' +
            '(cold no-host limbo guard, EI-21431587306904888)',
        };
      }
      if (verdict?.action === 'already-paused') {
        return {
          kind: 'park',
          reason:
            'eligible cold loop wake has no injectable psu host — loop already auto-paused (cold no-host limbo guard); parked',
        };
      }
      return {
        kind: 'park',
        reason:
          'eligible cold loop wake has no injectable psu host — parked without resume to preserve the fresh-context boundary',
      };
    }

    // Fresh-per-wake cutover for the Hive Queen (queen-brief-cache-assembly
    // B-01 / P-012): a hive-operator session is NEVER resumed. Its ended-session
    // wake (an inbox-wake `coord:send {wake:true}`, or an events:await it
    // registered) routes through the SAME fresh hive-launch path its scheduled
    // wakes use, carrying the wake text as the kickoff — so the Queen opens fresh
    // and re-derives from durable world-state (D-009) instead of carrying a stale
    // transcript. On a fire failure we PARK (never resume): the always-armed
    // time/watchdog wake re-surveys, so the no-resume invariant holds absolutely.
    const hiveInstallSlug = hiveInstallSlugFromLabel(fresh?.label ?? null);
    if (hiveInstallSlug) {
      const fired = await fireHiveWake({ installSlug: hiveInstallSlug, kickoff: text }).catch(() => false);
      if (fired) return { kind: 'delivered', channel: 'hive-fresh-wake' };
      return {
        kind: 'park',
        reason: 'hive operator: fresh-wake fire failed; next time/watchdog wake will re-survey (never resumed)',
      };
    }

    // bee-context-efficiency P-005 (D-018/D-021): fresh-context warm-inject. We only
    // reach here for an EXITED process (a live session PARKs above, D-005 — within-task
    // is never forked). If this wake is a Queen warm-inject of a NEW work-item AND the
    // CUP_FRESH_CONTEXT_WARM_INJECT flag is on, the legacy `--resume` below would reload
    // the bee's grown transcript (~138K/turn dead-weight carry, D-011). Instead route to
    // a FRESH spawn for that work-item (fresh session + full preamble + the hydration
    // tail: dossier P-008 + the work-item CHECKPOINT P-011 = the continuity, D-002). The
    // marker payload is stamped by place_batch ONLY when the flag is on, so flag-off is
    // byte-identical to today (the carry-seam oracle). Fail-soft: false ⇒ legacy resume.
    const freshTarget = freshContextWarmInjectTarget(sessionDelivery);
    if (freshTarget) {
      const forked = await runFreshContextWarmInject(sessionDelivery, freshTarget, deps.freshContext, (m) =>
        console.log(`[wake-executor:fresh-context] ${m}`),
      );
      if (forked) return { kind: 'delivered', channel: 'fresh-context-warm-inject' };
      // else fall through to the legacy resume below (fail-soft).
    }

    const resumeAgent = fresh?.agent ?? handle.agent;
    // P-013 part A (RSR-P-013-A): a dead Claude session whose persisted account is
    // WALLED is re-homed instead of resumed into the wall — onto the gateway auto route
    // when another Claude account has headroom, or onto Codex (a session port) when every
    // Claude account is walled. Decided BEFORE the claim below: the backend port is a psu
    // resume, and psu claims this same ended row itself — a pre-claimed row would make it
    // refuse. Bounded + fail-soft: a slow or unreadable pool resumes exactly as before.
    let rehome: WakeRehomeDecision | null = null;
    if (resumeAgent === 'claude') {
      const persistedRoute = wakeAccountRouteFromArgv(fresh?.launchArgv, d.subscriberId);
      rehome = await withWakeTimeout(
        (deps.resolveWakeRehome ?? defaultResolveWakeRehome)({
          workspaceId: sessionDelivery.workspaceId,
          route: persistedRoute,
        }),
        `wake re-home decision for ${d.subscriberId}`,
        2_000,
      );
      if (rehome && rehome.action !== 'keep') {
        console.log(`[wake-executor] P-013 re-home ${d.subscriberId}: ${rehome.action} — ${rehome.reason}`);
      }
      if (rehome?.action === 'rehome-backend') {
        const ported = await (deps.rehomeWakeOnBackend ?? defaultRehomeWakeOnBackend)({
          subscriberId: d.subscriberId,
          workspaceId: sessionDelivery.workspaceId,
          harnessSlug: fresh?.harnessSlug ?? readLoopDeliveryMarker(d.payload)?.harness ?? null,
          cwd: fresh?.cwd ?? handle.cwd ?? null,
          wakeText: appendCrashResumeAdvisory(text, {
            agent: resumeAgent,
            endedAtIso: typeof fresh?.endedAt === 'string' ? fresh.endedAt : null,
          }),
          backend: rehome.backend,
        }).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
        if (ported.ok) return { kind: 'delivered', channel: 'resume-rehome-backend' };
        // The port could not launch (no allowed codex model, unresolvable target, spawn
        // failure): fall through to the Claude resume, which keeps the existing wall path.
        console.warn(`[wake-executor] P-013 backend re-home for ${d.subscriberId} did not launch: ${ported.detail}`);
      }
    }

    // Channel 2: process gone → resume. The manual psu resume path claims the
    // same ended row before spawning; this atomic predicate makes exactly one
    // of the two competing resume writers proceed.
    // A claim that could not be EVALUATED is not a claim that was LOST: reporting
    // a datastore fault as a lost race sends the operator hunting a competing
    // resumer that never existed. Park either way (never risk a second writer),
    // but say which happened.
    let claimed: boolean;
    try {
      claimed = await claimResume(handle.advSessionId);
    } catch (err) {
      return {
        kind: 'park',
        reason:
          `resume claim for adv session #${handle.advSessionId} could not be evaluated ` +
          `(${err instanceof Error ? err.message : String(err)}); parked before Channel 2 spawn`,
      };
    }
    if (!claimed) {
      return {
        kind: 'park',
        reason: `resume claim for adv session #${handle.advSessionId} was won by another resumer; parked before Channel 2 spawn`,
      };
    }
    // `--account` is a launch-time choice and Claude does not retain launch
    // flags across `--resume`. Rebuild it from the persisted argv for Claude
    // wakes; the helper also emits the high-precedence settings overlay and
    // strips operator-only gateway state before the detached child starts.
    // P-013: a walled hard pin is re-homed onto the gateway auto route (decided above).
    const accountRoute =
      resumeAgent !== 'claude'
        ? null
        : rehome?.action === 'rehome-account'
          ? autoWakeAccountRoute(d.subscriberId)
          : wakeAccountRouteFromArgv(fresh?.launchArgv, d.subscriberId);
    // codex resumes from its per-session CODEX_HOME (keyed by the adv-session
    // id, exactly as bootstrap-su/psu minted it) and needs the conversation
    // UUID recovered from that home's rollout — codex carries no native id on
    // the row (turn-lifecycle-control P-009/P-010).
    let codexHome: string | null = null;
    let codexSessionId: string | null = null;
    if (resumeAgent === 'codex') {
      const home = codexHomeForAdvSession(handle.advSessionId);
      // Rematerialize-on-miss (session-db-archive-retire-dirs-2026-07-10
      // P-008): archive-at-death deletes a dead session's rollout + sqlite
      // once sha-verified in PG; a wake landing later pulls them back
      // byte-exactly before codex resumes. No-op when the home is intact or
      // nothing was ever archived.
      let sid: string | null = (fresh?.sessionId ?? handle.sessionId) || null;
      if (!existsSync(home) || !findCodexRolloutSessionId(home)) {
        // WI-3940: every PG call on this leg is time-bounded — a wedged
        // connection must degrade to the normal miss path, never stall the wake.
        if (!sid) {
          sid = await withWakeTimeout(
            findArchivedSessionIdForAdv(handle.advSessionId),
            `archived-session-id lookup for adv #${handle.advSessionId}`,
            rematerializeTimeoutMs,
          );
        }
        if (sid) {
          const r = await withWakeTimeout(
            rematerializeSession({ sourceKind: 'codex', sessionId: sid, targetRoot: home }),
            `rematerialize codex/${sid}`,
            rematerializeTimeoutMs,
          );
          if (r?.ok && r.written) {
            console.log(`[wake-executor] rematerialized codex/${sid}: ${r.written} file(s) → ${home}`);
          }
        }
      }
      if (existsSync(home)) {
        // Repair the existing home AFTER archive rematerialization has restored
        // the rollout, but BEFORE resolving its native UUID. The repair helper
        // never recreates/removes the home, so it cannot erase the exact archive
        // that the resume safety check below is about to select.
        await ensureCodexHomeForWake({
          advSessionId: handle.advSessionId,
          owner: fresh?.coordOwnerId ?? d.subscriberId,
          codexHome: home,
          headless: true,
          sessionRow: fresh,
        }).catch((err) => {
          console.warn(
            `[wake-executor] codex home repair seam failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        // The adv-session/handle id is only an archive lookup hint. It may be
        // stale, and using it here would let a missing/failed rematerialize
        // launch `codex exec resume` against a home with no matching rollout.
        // Re-resolve after the rematerialize attempt and resume only when the
        // home proves an exact native Codex session (rollout or history).
        const recoveredSessionId = findCodexRolloutSessionId(home);
        if (recoveredSessionId) {
          codexHome = home;
          codexSessionId = recoveredSessionId;
        }
      }
    }
    // omp keeps flat per-cwd transcripts under the shared sessions root — same
    // rematerialize-on-miss before the thread resume (P-008). Unlike Claude/Codex,
    // `omp -r` reports a permanent provider error when the transcript is still
    // absent, so never spawn it on an unverified thread (EI-21437954951892218).
    let ompTranscriptMissing = false;
    if (resumeAgent === 'omp') {
      const sid = fresh?.ompThreadId ?? handle.ompThreadId;
      if (sid) {
        try {
          const root = ompSessionsRoot();
          let have = await collectSessionFiles({ sourceKind: 'omp', sessionId: sid, sessionRoot: root });
          if (!have.length) {
            // WI-3940: time-bounded — see the codex leg.
            const r = await withWakeTimeout(
              rematerializeSession({ sourceKind: 'omp', sessionId: sid, targetRoot: root }),
              `rematerialize omp/${sid}`,
              rematerializeTimeoutMs,
            );
            if (r?.ok && r.written) console.log(`[wake-executor] rematerialized omp/${sid}: ${r.written} file(s)`);
            // The archive call is best-effort and may legitimately find no
            // archive. Re-read after it so a zero-file/failed restore cannot
            // become a doomed `omp -r` spawn that only fails asynchronously.
            have = await collectSessionFiles({ sourceKind: 'omp', sessionId: sid, sessionRoot: root });
          }
          ompTranscriptMissing = have.length === 0;
        } catch (e) {
          console.warn(`[wake-executor] omp rematerialize check failed: ${(e as Error)?.message ?? e}`);
          ompTranscriptMissing = true;
        }
      }
    }
    if (ompTranscriptMissing) {
      const p = await presence(d.subscriberId).catch(() => null);
      if (p && !p.stale && !p.revoked) {
        return {
          kind: 'park',
          reason: 'omp session transcript unavailable after archive recovery — presence is live; parked without resume',
        };
      }
      return degradeToInboxOrDrop(
        d,
        'omp session transcript unavailable after archive recovery — no safe resume',
        sendCoordMessage,
      );
    }
    // R4 (P-004 / WI-2140461, D-002): this is the process-exited rung — the wake
    // is about to RESUME a session whose process died, so the delivered turn
    // carries the crash-resume re-verify advisory (EI-16611 class). Appended
    // HERE, after channel selection, so every in-place inject above stays
    // byte-identical (D-002's channel-agnostic wakeTurnText contract).
    const resumeText = appendCrashResumeAdvisory(text, {
      agent: resumeAgent,
      endedAtIso: typeof fresh?.endedAt === 'string' ? fresh.endedAt : null,
    });
    const resume = resumeCommandFor(
      {
        agent: resumeAgent,
        sessionId: resumeAgent === 'codex' ? codexSessionId : (fresh?.sessionId ?? handle.sessionId),
        ompThreadId: fresh?.ompThreadId ?? handle.ompThreadId,
        coordOwnerId: fresh?.coordOwnerId ?? null,
      },
      resumeText,
      accountRoute,
    );
    const cwd = fresh?.cwd ?? handle.cwd;
    if (!resume || !cwd) {
      const p = await presence(d.subscriberId).catch(() => null);
      if (p && !p.stale && !p.revoked) {
        return {
          kind: 'park',
          reason: 'session ended but not safely resumable (no native session id / unsupported client) — inbox only',
        };
      }
      return degradeToInboxOrDrop(d, 'session ended, not resumable, presence gone — dead waiter', sendCoordMessage);
    }

    // A process-gone loop wake may arrive from an older adv-session row whose
    // best-effort launch_spec was never persisted. The loop fire's marker carries
    // the harness scope on current rows; fall back to the current loop routine for
    // older markers (or ordinary wakes) so the resumed CLI's ptool/MCP scope is not
    // left empty. Keep the DB read bounded and fail-soft: the persisted session
    // scope remains the preferred source, and a wake must never stall on bookkeeping.
    let resumeHarnessSlug = fresh?.harnessSlug ?? null;
    if (!resumeHarnessSlug) {
      const markerHarness = readLoopDeliveryMarker(d.payload)?.harness;
      resumeHarnessSlug = markerHarness ?? null;
      if (!resumeHarnessSlug) {
        const loopStatus = await withWakeTimeout(
          (deps.getLoopStatusFn ?? getLoopStatus)(d.subscriberId),
          `loop harness/${d.subscriberId}`,
          1_000,
        );
        resumeHarnessSlug = loopStatus?.harnessSlug ?? null;
      }
    }

    const env: Record<string, string> = {
      ...(accountRoute?.env ?? {}),
      PAPERCUSP_SID: d.subscriberId,
      // Scope the resumed agent's user-level MCP to the bee's workspace. omp's
      // ~/.omp/agent/mcp.json sends x-papercusp-workspace via
      // `!printf "${PAPERCUSP_WORKSPACE:-}"`, and claude's user-level MCP url
      // env-expands the same var into `&workspace=`. Without this export the
      // header/param are EMPTY, so the ONLY workspace signal is the
      // SID->adv-row lookup (workspaceForCoordOwner) — which is null for a fresh
      // or under-load bee -> the MCP session is scoped_superuser_workspace_unresolved
      // -> EVERY coord:* tool 404s ("Tool coord:orient not found"). The coord hook
      // still works (it resolves the workspace itself), which masked this break.
      // (Since mcp-outage-triage-2026-07-02 the clamp falls back to the box's
      // ACTIVE workspace instead of rejecting — a net, not a replacement: this
      // explicit export stays the correct primary carrier.)
      // Mirrors bootstrap-su's envelopeEnv + console-launcher (the fresh-launch
      // legs that already set this). The event delivery's workspace is the flat
      // coordination workspace; use the persisted session scope for the child.
      PAPERCUSP_WORKSPACE: sessionDelivery.workspaceId,
      ...(resumeHarnessSlug ? { PAPERCUSP_HARNESS_SLUG: resumeHarnessSlug } : {}),
      PAPERCUSP_WAKE_DELIVERY_ID: String(d.id),
      // MCP handshake headroom: under fleet load the operator's event loop can
      // stall past claude's default MCP connect timeout, and claude then marks
      // the server offline for the WHOLE resumed session (no retry) — a woken
      // Queen with no voice (Stage-A finding, 2026-06-07, load ~200).
      MCP_TIMEOUT: process.env.PAPERCUSP_WAKE_MCP_TIMEOUT_MS || '120000',
      // An autonomous wake turn IS an agent session, whoever the recipient:
      // arm the hook-level scheduler guard (native-scheduler-lockout P-010).
      PAPERCUSP_AGENT_SESSION: '1',
      // WI-3082: this whole codepath (Channel 2: "process gone → resume") is a
      // genuinely FRESH child process spawned specifically to deliver a
      // coord/events:await wake — invoke.ts reads this as PAPERCUSP_TURN_TRIGGER
      // and stamps it onto the run's agent_usage_samples row (source='jsonl').
      // Before this, only a bee/queen's FIRST spawn (bee/spawn.ts, place_batch.ts)
      // was labeled 'coord-wake'; every persistent long-running agent (queen,
      // overwatch, doc-steward, and a bee resumed after its process exited
      // rather than freshly spawned) resumes through exactly this path and had
      // NO PAPERCUSP_TURN_TRIGGER set at all — the single largest unattributed
      // jsonl-source slice the token-usage audit (P-002) found. `resumeCommandFor`
      // always fires FOR a wake (there is no other caller of this env block), so
      // 'coord-wake' is unconditionally correct here — no branching needed.
      PAPERCUSP_TURN_TRIGGER: 'coord-wake',
    };
    // Bug fix (found chasing a coord-wake papercusp-su MCP disconnect): this
    // env is inherited from the operator process, which some producers (e.g.
    // dbos/orchestrator-runner.ts) set to the full `.../api/mcp` endpoint
    // rather than a bare origin. claude's/omp's own `.mcp.json` templates
    // append `/api/mcp` themselves, so an inherited suffixed value doubles
    // into a 404ing `.../api/mcp/api/mcp` and the resumed session comes up
    // with zero papercusp-su tools. Normalize it down to a bare (proxy-routed)
    // origin before the child spawns.
    const normalizedOperatorUrl = resolveInheritedOperatorBaseUrl(process.env.PAPERCUSP_OPERATOR_URL);
    if (normalizedOperatorUrl) env.PAPERCUSP_OPERATOR_URL = normalizedOperatorUrl;
    // Tracked hive launches keep their per-session CLAUDE_CONFIG_DIR (transcript
    // + plugin isolation) at a conventional path — point the resumed claude at
    // it so `--resume <sessionId>` finds the session file (D-010 resume leg).
    const owner = fresh?.coordOwnerId ?? null;
    if (owner) {
      const cfgDir = sessionClaudeConfigDir(owner);
      // Rematerialize-on-miss (P-008): the transcript may have been archived+
      // deleted at death — restore it byte-exactly (sha-verified) so
      // `--resume <sessionId>` finds the session file. FS-only when the file
      // is already on disk; one PG read otherwise.
      const sid = fresh?.sessionId ?? handle.sessionId;
      if (resumeAgent === 'claude' && sid) {
        try {
          const have = await collectSessionFiles({ sourceKind: 'claude', sessionId: sid, sessionRoot: cfgDir });
          if (!have.length) {
            // WI-3940: time-bounded — see the codex leg.
            const r = await withWakeTimeout(
              rematerializeSession({ sourceKind: 'claude', sessionId: sid, targetRoot: cfgDir }),
              `rematerialize claude/${sid}`,
              rematerializeTimeoutMs,
            );
            if (r?.ok && r.written) {
              console.log(`[wake-executor] rematerialized claude/${sid}: ${r.written} file(s) → ${cfgDir}`);
            }
          }
        } catch (e) {
          console.warn(`[wake-executor] claude rematerialize check failed: ${(e as Error)?.message ?? e}`);
        }
        // EI-24890753013901545: the resumed headless process has its own tool surface, so
        // a NATIVE deferred tool the earlier process loaded (ExitPlanMode,
        // WaitForMcpServers…) can be absent and the provider 400s the first replayed
        // request — the seed below restores only Papercusp MCP names. This process holds
        // no live session (we are about to spawn the resume), so drop the native
        // references from the transcript first; they only pre-load a schema.
        try {
          const dropped = neutralizeResumeNativeToolReferences(join(cfgDir, 'projects'), sid);
          if (dropped.rewritten > 0) {
            console.log(
              `[wake-executor] dropped ${dropped.rewritten} native deferred tool reference(s) (${dropped.toolNames.join(', ')}) from claude/${sid} before resume`,
            );
          }
        } catch (e) {
          console.warn(`[wake-executor] native tool-reference neutralize failed: ${(e as Error)?.message ?? e}`);
        }
        const analysis = await refreshClaudeResumeTranscript(owner, sid);
        const inheritedToolSeed = process.env.PAPERCUSP_TOOLS;
        if (analysis?.toolReferences.length && inheritedToolSeed?.trim()) {
          env.PAPERCUSP_TOOLS = appendClaudeToolReferencesToSeed(inheritedToolSeed, analysis.toolReferences);
        }
      }
      if (existsSync(cfgDir)) env.CLAUDE_CONFIG_DIR = cfgDir;
    }
    // Fleet token (claude-credential-sync-2026-06-10 P-003): an autonomous wake
    // turn authenticates with the dedicated non-rotating setup-token when the
    // owner has minted one, so fleet refreshes never consume the interactive
    // OAuth family's single-use refresh token (the every-terminal-relogin
    // cascade). Mirrors the orchestrator spawn leg (invoke.ts). Absent token ⇒
    // unchanged (the session's config-dir credentials).
    if (resumeAgent === 'claude') {
      const fleetToken = readFleetClaudeToken();
      if (fleetToken) env.CLAUDE_CODE_OAUTH_TOKEN = fleetToken;
    }
    // codex finds the session's history + baked superuser MCP only inside its
    // per-session CODEX_HOME — point the resumed `codex exec resume` at it
    // (turn-lifecycle-control P-009).
    if (codexHome) env.CODEX_HOME = codexHome;

    // WI-10005900: clamp the effort the resumed claude would inherit from the
    // settings.json it will actually read. Read it with the CHILD's env (the
    // isolated CLAUDE_CONFIG_DIR set above), never the operator's own.
    if (resumeAgent === 'claude') {
      const childEnv = { ...sanitizeInheritedWakeEnv(process.env), ...env };
      resume.args = withClaudeResumeEffortClamp(
        resume.args,
        (deps.readClaudeLaunchSettings ?? readClaudeLaunchSettings)(childEnv),
      );
    }

    const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;

    // A non-PTY resume is HEADLESS one-turn (set in resumeCommandFor) — it must
    // run DETACHED with stdio:'ignore', NOT in a managed pty. In a pty claude's
    // stdin is a TTY, so `-p` waits for
    // interactive input instead of consuming the positional prompt and exiting —
    // the process hangs alive, never runs the turn, and "delivered:resume" is a
    // lie (Stage-B finding, 2026-06-07: every pty resume sat idle 2+ min; the
    // manual non-tty `-p` ran one turn and exited). codex `exec` and modern omp
    // `-r … -p` are likewise non-interactive single-turn. The pty path stays as
    // an explicit OMP fallback (promptViaPty), where a live TTY is the point.
    if (!resume.promptViaPty) {
      // P0a: forward the detached turn's eventual exit to the outcome handler (if any).
      // Bound to THIS delivery `d` so the handler can attribute a loop-sourced death to
      // its routine. The delivery is still 'delivered' the instant a PID lands — the
      // observation is asynchronous + additive, never on the delivery's hot path.
      // WI-10002854: the ledger row is assigned synchronously right after the spawn
      // returns. The child's 'close' can only fire on a later event-loop turn, so
      // this closure always sees it.
      let accounting: HeadlessResumeTurnAccounting | null = null;
      const resumeTurnContext: ResumeTurnContext = {
        advSessionId: handle.advSessionId,
        ownerId: fresh?.coordOwnerId ?? d.subscriberId,
        sessionId: fresh?.sessionId ?? handle.sessionId ?? null,
        startedAt: fresh?.startedAt ?? null,
        workspaceId: fresh?.workspaceId ?? sessionDelivery.workspaceId,
        agent: resumeAgent,
        transcriptPath: resumeAgent === 'claude' ? claudeResumeTranscriptPath : null,
      };
      const onExit = deps.onResumeTurnExit
        ? (exit: ResumeTurnExitRaw) => {
            accounting?.finish(exit);
            const observedExit = resumeAgent === 'codex' ? { ...exit, outputProtocol: 'codex-jsonl' as const } : exit;
            void (async () => {
              let context = resumeTurnContext;
              const errorText = [observedExit.stderrTail, observedExit.stdoutTail].filter(Boolean).join('\n');
              if (resumeAgent === 'claude' && isMissingClaudeToolReferenceError(errorText)) {
                try {
                  const quarantine = await quarantineToolReferenceSession(context, errorText);
                  if (quarantine.poisoned) {
                    const poisonReason =
                      `quarantined after ${quarantine.turns} consecutive unavailable Papercusp tool-reference turns`;
                    context = {
                      ...context,
                      poisoned: true,
                      poisonReason,
                    };
                    // The event engine owns terminal delivery settlement and its
                    // owner/fleet notice when it observes this callback. Keep the
                    // local notice for direct executor callers so one poisoned
                    // resume cannot notify the same audience twice.
                    if (!deps.onResumeTurnExit) {
                      await notifyPoisonedResumeSession(d, context, errorText, sendCoordMessage);
                    }
                  }
                } catch (error) {
                  console.warn(`[wake-executor] tool-reference poison detector failed: ${(error as Error)?.message ?? error}`);
                }
              }
              deps.onResumeTurnExit!(d, observedExit, context);
            })();
          }
        : undefined;
      const pid2 = spawnDetached(resume.bin, resume.args, { cwd, env }, onExit);
      if (!pid2) return { kind: 'error', error: 'headless resume spawn failed' };
      // With no exit observer the ledger row is not closed here. The reconciler
      // closes it once the process identity vanishes.
      try {
        accounting = accountHeadlessResumeTurn({
          pid: pid2,
          advSessionId: handle.advSessionId,
          sessionWorkspaceId: fresh?.workspaceId ?? null,
          deliveryWorkspaceId: sessionDelivery.workspaceId,
          coordOwnerId: owner ?? d.subscriberId,
          agent: resumeAgent,
          resumeId:
            resumeAgent === 'omp'
              ? (fresh?.ompThreadId ?? handle.ompThreadId ?? null)
              : (fresh?.sessionId ?? handle.sessionId ?? null),
          cwd,
          argv: ledgerSafeResumeArgv(resume.bin, resume.args, resumeText),
        });
        // Write the pid BEFORE reporting delivered. Otherwise the next wake reads
        // the dead predecessor's pid and resumes the session a second time.
        // Time-bounded: a stalled datastore must not wedge the delivery.
        await withWakeTimeout(accounting.pidRecorded, `record resume pid ${pid2}`, 2_000);
      } catch (err) {
        console.warn(
          `[wake-executor] resume-headless accounting failed for pid ${pid2}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { kind: 'delivered', channel: 'resume-headless' };
    }

    try {
      const accessScope: PtyAccessScope = {
        tenantId: sessionDelivery.workspaceId,
        workspaceId: sessionDelivery.workspaceId,
        harnessSlug: resumeHarnessSlug ?? 'system',
        hostId: localPtyHostId(),
        principalId: d.subscriberId,
      };
      const h = spawnManaged({
        accessScope,
        command: resume.bin,
        args: resume.args,
        cwd,
        env,
        cols: 120,
        rows: 36,
      });
      if (resume.promptViaPty) {
        const injected = await injectOmpWakeTurnWhenReady({ pty: h, wakeText: resumeText, write });
        if (!injected.ok) {
          try {
            kill(h.id, h.accessScope);
          } catch {
            /* best-effort cleanup of a non-ready resume pty */
          }
          const tail = injected.transcriptTail
            ? ` transcript tail: ${JSON.stringify(injected.transcriptTail.slice(-1000))}`
            : '';
          return { kind: 'error', error: `${injected.error}.${tail}` };
        }
      }
      return { kind: 'delivered', channel: 'resume' };
    } catch (err) {
      return { kind: 'error', error: `resume spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
