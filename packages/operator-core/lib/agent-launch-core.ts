/**
 * agent-launch-core — the ONE shared core for launching / resuming / forking
 * `psu` agent sessions from tools (agent-launch-resume-primitives-2026-07-12
 * P-001, D-001/D-002).
 *
 * `capability:terminal`, `capability:launch-agent` and `fleet:launch-on-plan`
 * consume these helpers instead of forking the spawn path:
 *   - the psu-command INJECTORS (fleet / launched-by / account) — targeted,
 *     idempotent rewrites of a raw command string, the capability:terminal
 *     arg-passing model the owner directed launch-agent to mimic;
 *   - the resume/fork RESOLVER (agent id OR native session id → the exact
 *     session to resume, with live-source detection so an in-place resume can
 *     never collide with a still-running CLI — WI-3882/D-007);
 *   - the post-resume KICKOFF INJECT (D-008): a resumed session boots idle and
 *     its presence rows are reaped, so roster-gated coord:wake cannot reach it —
 *     the first turn is delivered through the psu pty-host discovery socket.
 */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { mapAdvSessionRow, type AdvSessionRow, type AdvSessionEndedBy, type AdvSessionExpectedBinding } from './adv-sessions';
import { findLiveHost, injectIntoHost, type PsuPtyHost } from './events/await/psu-pty-discovery';
import { fetchSelfWake } from './agent-tools/coordination/presence-selfwake';
import {
  composeLaunchModelSpec,
  flagValueFromArgv,
  MIN_COMPACTION_LIMIT_TOKENS,
  modelSpecFromArgv,
  MODEL_EFFORT_LEVELS,
  normalizeModelSpec,
} from './agent-config-constants';
import { resolveCodexModel, resolveCodexModelSelection } from './model-context-budget.mjs';
import { isSuAgent, SU_AGENTS } from './su-agents';

export type CodexModelSource = 'explicit' | 'inherited' | 'configured-default';

/** Match `psu` as a command token — start of line, or after whitespace / a
 *  shell separator — followed by whitespace. Shared by every injector. */
const PSU_TOKEN = /(^|[\s&;|(])psu(\s)/;

/**
 * Is this terminal command actually an AGENT LAUNCH wearing a command's clothes?
 * (P-004 — the wrong-door guard.)
 *
 * WHY THE DOOR MATTERS, and why this is not pedantry: `capability:terminal` is the
 * arbitrary-COMMAND door and hardcodes `preferProcessPerWindow: true`, which
 * resolves to xterm. `capability:launch-agent` uses `preferProcessPerWindow:
 * isResume`, so a fresh launch gets the owner's normal emulator. Both doors share
 * ONE spawn path — the divergence is emulator POLICY, not mechanism — but a
 * launch through the wrong door lands in a different window manager, skips the
 * backend preflight (P-002) and the started-verification (P-003), and is exactly
 * how the owner's two failed omp launches happened.
 *
 * DELIBERATELY NARROW. `psu --help`, `psu --version`, `psu-sentinel`, and any
 * `psu` mention inside a longer word are NOT launches and must keep working — a
 * guard that over-refuses teaches agents to route around it, which is worse than
 * no guard. The positive test is a `psu` COMMAND TOKEN (the same boundary rule
 * every injector uses) that is not one of the informational flags.
 */
export function classifyAgentLaunchCommand(command: string): {
  isAgentLaunch: boolean;
  mode: 'fresh' | 'resume' | null;
} {
  if (!PSU_TOKEN.test(command ?? '')) return { isAgentLaunch: false, mode: null };
  // Informational invocations print and exit — no agent, no window to supervise.
  if (/(^|\s)--(help|version)(\s|$|=)/.test(command)) return { isAgentLaunch: false, mode: null };
  const resume = /(^|\s)--(resume|fork)(=|\s|$)/.test(command);
  return { isAgentLaunch: true, mode: resume ? 'resume' : 'fresh' };
}

/**
 * named-su-agent-fleets / EI-5835: when the caller passes an explicit `fleet`, a
 * `psu …` launch inside a terminal command should JOIN that fleet — not merely
 * inherit its colour. The `fleet` arg alone is COLOUR-ONLY (it tints the window);
 * fleet MEMBERSHIP comes from psu's own `--fleet=<slug>` flag. Agents repeatedly
 * set `fleet` and forget `--fleet`, so members spawn with `fleetSlug:null` AND miss
 * the launcher's fleet auto-kickoff (they park). Auto-inject `--fleet=<slug>` into a
 * psu command that lacks it so colour and membership can't diverge. Non-psu commands,
 * and commands already carrying `--fleet`, are left untouched.
 */
export function injectFleetArg(
  command: string,
  fleetSlug: string | null,
): { command: string; injected: boolean } {
  if (!fleetSlug) return { command, injected: false };
  if (/(^|\s)--fleet(=|\s|$)/.test(command)) return { command, injected: false };
  if (!PSU_TOKEN.test(command)) return { command, injected: false };
  return { command: command.replace(PSU_TOKEN, `$1psu --fleet=${fleetSlug}$2`), injected: true };
}

/**
 * solo-launch-provenance (the EI-5835 pattern, applied to WHO-launched-you): a `psu …`
 * launch spawned from a tool should carry `--launched-by=<caller ownerId>` so
 * bootstrap-su can bake the provenance into the launched session (system prompt +
 * PAPERCUSP_LAUNCHED_BY + an owner-scoped standing fact). Without it a solo-launched
 * agent has NO way to answer "who launched / supervises you" — su-8ab32510
 * (2026-07-03) described its launcher as "an observer who doesn't assign or
 * supervise my work". Commands already carrying the flag, and non-psu commands,
 * are left untouched. The ownerId is injected into a shell string, so only
 * identity-shaped values are accepted.
 */
export function injectLaunchedByArg(
  command: string,
  launcherOwnerId: string | null,
): { command: string; injected: boolean } {
  if (!launcherOwnerId || !/^[A-Za-z0-9._:-]{1,120}$/.test(launcherOwnerId)) {
    return { command, injected: false };
  }
  if (/(^|\s)--launched-by(=|\s|$)/.test(command)) return { command, injected: false };
  if (!PSU_TOKEN.test(command)) return { command, injected: false };
  return {
    command: command.replace(PSU_TOKEN, `$1psu --launched-by=${launcherOwnerId}$2`),
    injected: true,
  };
}

/**
 * Account pinning for SCRIPTED launches (P-012, owner-hit 2026-07-12): a psu
 * launch/resume with no `--account` prompts an INTERACTIVE account picker
 * (chooseResumeAccount), which blocks a tool-spawned session until a human
 * answers it. Inject `--account=default` (or the caller's explicit account —
 * `default` | `auto` | a pool account id, the account-routing-3-options
 * grammar) into any psu command that lacks one. Value-guarded: an account id
 * lands in a shell string, so only identity-shaped values are accepted.
 */
export function injectAccountArg(
  command: string,
  account: string | null = 'default',
): { command: string; injected: boolean } {
  if (!account || !/^[A-Za-z0-9._:-]{1,120}$/.test(account)) return { command, injected: false };
  if (/(^|\s)--account(=|\s|$)/.test(command)) return { command, injected: false };
  if (!PSU_TOKEN.test(command)) return { command, injected: false };
  return { command: command.replace(PSU_TOKEN, `$1psu --account=${account}$2`), injected: true };
}

/**
 * Launch-time mode overlay carried across a scripted spawn boundary.
 *
 * Keep this payload
 * deliberately small and closed: a caller may propagate the leader's durable
 * mode row + standing instructions, but it must never smuggle arbitrary mode
 * prose or an unbounded value into a shell command / bootstrap body.
 */
export type LaunchModeId = 'drain' | 'grade' | 'test';

export const LAUNCH_MODE_SUBJECT_MAX_CHARS = 200;
export const LAUNCH_MODE_INSTRUCTIONS_MAX_CHARS = 500;

export interface LaunchMode {
  mode: LaunchModeId;
  subject: string | null;
  instructions: string | null;
  ownerDirected: boolean;
}

function boundedLaunchModeText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, maxChars);
  return text || null;
}

/** Normalize an untrusted launch-mode value before it reaches argv or JSON. */
export function normalizeLaunchMode(value: unknown): LaunchMode | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.mode !== 'drain' && input.mode !== 'grade' && input.mode !== 'test') return null;
  return {
    mode: input.mode,
    subject: boundedLaunchModeText(input.subject, LAUNCH_MODE_SUBJECT_MAX_CHARS),
    instructions: boundedLaunchModeText(input.instructions, LAUNCH_MODE_INSTRUCTIONS_MAX_CHARS),
    ownerDirected: input.ownerDirected === true,
  };
}

/**
 * Resolve the launch overlay from the caller's durable mode row and standing
 * fact. The inputs are intentionally structural so this shared core stays
 * client-safe; callers read `agent_modes` / `mode-instructions:drain` once and
 * hand the bounded result to every launch composer.
 */
export function resolveLaunchMode(opts: {
  modeRows?: ReadonlyArray<{
    mode?: unknown;
    subject?: unknown;
    ownerDirected?: unknown;
  }>;
  instructionsFact?: unknown;
}): LaunchMode | null {
  const drain = opts.modeRows?.find((row) => row?.mode === 'drain');
  if (!drain) return null;
  return normalizeLaunchMode({
    mode: 'drain',
    subject: drain.subject,
    instructions: opts.instructionsFact,
    ownerDirected: drain.ownerDirected,
  });
}

/** A resume/fork target fully resolved to the exact session to act on. */
export interface ResumeTarget {
  /**
   * The native CLI session uuid, when the backend recorded one.
   *
   * Tracked Codex rows can predate native-id registration; in that case this is
   * null and {@link resumeId} carries the tracked adv_sessions row id instead.
   */
  sessionId: string | null;
  /** OMP's native thread/session handle; OMP rows do not use sessionId. */
  ompThreadId: string | null;
  /**
   * The selector accepted by `psu --resume`: the native session id when known,
   * otherwise the tracked adv_sessions row id for a Codex session.
   */
  resumeId: string;
  /** The session's coord identity — the pty-host discovery key + the identity an
   *  in-place resume re-attaches. */
  ownerId: string | null;
  agent: string | null;
  cwd: string | null;
  /** The model spec recorded in the source session's launch argv, when present. */
  model: string | null;
  /** The Codex model-source provenance recorded in launch argv, when present. */
  modelSource: CodexModelSource | null;
  /** ⚠ Only an end time when {@link endedBy} is `'self'`. Otherwise a sweeper stamped it on
   *  NOTICING the process was gone, so it cannot answer "when did this session end". */
  endedAt: string | null;
  /** Who wrote {@link endedAt} (migration 735). `null` = legacy row, provenance UNKNOWN —
   *  which is not the same as a clean self-reported exit. */
  endedBy: AdvSessionEndedBy | null;
  /** A live pty host currently serves this identity — an in-place resume would
   *  collide (WI-3882/WI-3455); the caller must fork instead (D-007). */
  live: boolean;
  advSessionId: number;
  /** The persisted incarnation, which may differ from an exact transcript pin. */
  binding: AdvSessionExpectedBinding | null;
}

export type ResolveResumeError =
  | { ok: false; error: 'not_found'; detail: string }
  | { ok: false; error: 'no_native_session_id'; detail: string };

export type ResolveResumeResult = ({ ok: true } & ResumeTarget) | ResolveResumeError;

/** Read the model settings that a resume must carry from the durable launch argv. */
function resumeModelMetadata(launchArgv: unknown): Pick<ResumeTarget, 'model' | 'modelSource'> {
  const source = flagValueFromArgv(launchArgv, 'model-source');
  return {
    model: modelSpecFromArgv(launchArgv),
    modelSource:
      source === 'explicit' || source === 'inherited' || source === 'configured-default'
        ? source
        : null,
  };
}

/**
 * Pick the native transcript id a resume command must receive.
 *
 * `requestedSessionId` is an EXACT native UUID contract. The resolver may use
 * `session_turns` to recover that rollout's logical owner and then read the
 * owner's `adv_sessions` row for cwd/agent/liveness metadata, but that owner row
 * can legitimately carry an OLDER root UUID. Substituting the row UUID silently
 * rewinds the conversation — the 2026-08-20 restoration incident did exactly
 * that for two Codex sessions. The explicitly requested UUID therefore always
 * wins; only an owner/agent-id lookup uses the row's recorded native UUID.
 */
export function resolvedNativeSessionId(
  requestedSessionId: string | null | undefined,
  recordedSessionId: string | null | undefined,
): string | null {
  return requestedSessionId?.trim() || recordedSessionId?.trim() || null;
}

/**
 * The minimum measured quiet period before an agent-launched headless host may
 * be treated as a recoverable husk. Keep this deliberately longer than a normal
 * wake interval: a quiet loop-armed worker is still a live identity, and only a
 * host with explicit agent provenance is eligible for replacement.
 */
export const STALE_HEADLESS_AGENT_HOST_IDLE_MS = 30 * 60_000;

/**
 * Is a discovered host safe to replace during an ordinary exact resume?
 *
 * A process-alive host is normally a live source and must be forked. The one
 * narrow recovery exception is an explicitly headless host launched by another
 * agent whose pty activity is measured and has been idle for the recovery
 * threshold. Missing provenance, missing activity, interactive hosts, and
 * recent hosts all fail closed to the normal live-source fork behavior.
 * Pure and injectable so the launch guard can be regression-tested without a
 * real pty host or wall-clock timing.
 */
export function isStaleHeadlessAgentHost(
  host: Pick<PsuPtyHost, 'bridgeTty' | 'launchedBy' | 'lastActivityAt' | 'lastInputAt' | 'lastOutputAt'> | null | undefined,
  {
    now = Date.now(),
    idleThresholdMs = STALE_HEADLESS_AGENT_HOST_IDLE_MS,
  }: { now?: number; idleThresholdMs?: number } = {},
): boolean {
  if (host?.bridgeTty !== false || !String(host?.launchedBy ?? '').trim()) return false;
  const activitySamples = [host.lastActivityAt, host.lastOutputAt, host.lastInputAt]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const threshold = Number(idleThresholdMs);
  if (!activitySamples.length || !Number.isFinite(threshold) || threshold <= 0) return false;
  const lastActivityAt = Math.max(...activitySamples);
  return Number.isFinite(now) && now >= lastActivityAt && now - lastActivityAt >= threshold;
}

/**
 * Resume/fork RESOLVER (P-004, D-004): given an AGENT id (`su-…`) or a native
 * CLI session uuid, resolve the most-recent matching `adv_sessions` row so a
 * caller never hunts a transcript uuid by hand — and detect a still-LIVE
 * source (via the pty-host discovery dir) so the caller forks instead of
 * colliding in place (D-007).
 */
export async function resolveResumeTarget(ref: {
  agentId?: string | null;
  sessionId?: string | null;
}): Promise<ResolveResumeResult> {
  const agentId = ref.agentId?.trim() || null;
  const sessionId = ref.sessionId?.trim() || null;
  if (!agentId && !sessionId) {
    return { ok: false, error: 'not_found', detail: 'pass resume.agentId or resume.sessionId' };
  }
  const { sql } = getOrgPg();
  // Exact-pin by native session id wins; otherwise start with the newest row for
  // the requested agent id. A carry-respawn can rotate the coord owner while
  // retaining the transcript's native session id, so agent-id lookup must follow
  // that candidate session through the latest session_turns.owner and prefer the
  // current adv_sessions row. Without that bridge, a stale historical owner is
  // handed to the reviver even though its live successor is already running.
  // An agentId may be a PREFIX (the short `su-b0fbf` handle agents actually say
  // out loud) — match by prefix, newest first. adv_sessions is deliberately NOT
  // workspace-scoped here: coord_owner_id and session_id are globally unique
  // (see advSessionsByCoordOwner's note), so a workspace predicate could only
  // drop valid rows.
  //
  // An exact native-session pin is its OWN candidate, and must NOT be looked up
  // through adv_sessions first (WI-555403). A carry-respawn REWRITES the owner's
  // adv_sessions row in place — same row id, new session_id + started_at (see
  // reanchorAdvSessionNativeId in adv-sessions.ts) — so every EARLIER session in
  // a respawn chain has no adv_sessions row at all. Seeding `candidate` from
  // adv_sessions therefore left indexed_owner NULL for exactly those sessions,
  // the final predicate degenerated to `coord_owner_id = NULL`, and an earlier
  // transcript resolved as not_found even though session_turns still holds it
  // under the same owner. Taking the pin directly lets indexed_owner bridge it
  // back to the owner's CURRENT row; resolvedNativeSessionId below still returns
  // the requested uuid, so the pin is never replaced by that row's newer one.
  const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0] & { binding_started_at: string }>>`
    WITH candidate AS (
      ${
        sessionId
          ? sql`SELECT ${sessionId}::text AS candidate_session_id`
          : sql`SELECT s.session_id AS candidate_session_id
                  FROM harness_shared.adv_sessions s
                 WHERE s.coord_owner_id LIKE ${agentId + '%'}
                 ORDER BY s.started_at DESC
                 LIMIT 1`
      }
    ),
    indexed_owner AS (
      SELECT t.owner
        FROM harness_shared.session_turns t
       WHERE t.session_id = (SELECT candidate_session_id FROM candidate)
         AND t.owner IS NOT NULL
       ORDER BY t.ingested_at DESC
       LIMIT 1
    )
    SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
           window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code,
           ended_by, launch_argv, started_at::text AS binding_started_at
      FROM harness_shared.adv_sessions
     WHERE ${
       sessionId
         ? sql`session_id = ${sessionId}
                 OR coord_owner_id = (SELECT owner FROM indexed_owner)`
         : sql`coord_owner_id LIKE ${agentId + '%'}
                 OR coord_owner_id = (SELECT owner FROM indexed_owner)`
     }
     ORDER BY ${
       sessionId
         ? sql`(session_id = ${sessionId}) DESC,`
         : sql`(coord_owner_id = (SELECT owner FROM indexed_owner)) DESC,`
     } started_at DESC
     LIMIT 1
  `;
  if (!rows.length) {
    return {
      ok: false,
      error: 'not_found',
      detail: sessionId
        ? `no adv_sessions row records native session ${sessionId}, and session_turns holds no owner ` +
          'for it either — check the uuid (sessions:list)'
        : `no adv_sessions row for agent ${agentId} — check the id (coord:presence / sessions:list)`,
    };
  }
  const row: AdvSessionRow = mapAdvSessionRow(rows[0]);
  const nativeSessionId = resolvedNativeSessionId(sessionId, row.sessionId);
  const modelMetadata = resumeModelMetadata(row.launchArgv);
  // The psu launcher already supports tracked Codex rows with no native UUID:
  // `psu --resume=<adv row id>` resolves the row, restores its isolated
  // CODEX_HOME, and runs `codex resume --last`. Other backends need a native
  // transcript handle, so preserve their fail-closed error.
  if (!nativeSessionId && row.agent !== 'codex') {
    return {
      ok: false,
      error: 'no_native_session_id',
      detail:
        `adv session #${row.id} (${row.coordOwnerId ?? 'no coord id'}, agent ${row.agent ?? '?'}) carries no ` +
        'native session uuid — it predates native-id tracking or is an omp thread; resume it by hand ' +
        '(`psu --resume` picker) instead.',
    };
  }
  const host: PsuPtyHost | null = row.coordOwnerId ? findLiveHost(row.coordOwnerId) : null;
  return {
    ok: true,
    // Exact native UUID pins are never replaced by the logical owner's older
    // adv_sessions.session_id. session_turns supplies owner METADATA only.
    sessionId: nativeSessionId,
    ompThreadId: row.ompThreadId,
    resumeId: nativeSessionId ?? String(row.id),
    ownerId: row.coordOwnerId,
    agent: row.agent,
    cwd: row.cwd,
    ...modelMetadata,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
    live: host != null,
    advSessionId: row.id,
    binding: row.coordOwnerId && rows[0].binding_started_at ? {
      coordOwnerId: row.coordOwnerId,
      sessionId: row.sessionId,
      startedAt: rows[0].binding_started_at,
    } : null,
  };
}

/**
 * Compose the scripted `psu` command for launch-agent (P-003/P-005). Always
 * `--no-picker` (a tool launch must never block on an interactive picker) and
 * always account-pinned (P-012). The fleet / launched-by flags are left to the
 * injectors so launch-agent and capability:terminal share one code path.
 */
export function buildAgentLaunchCommand(opts: {
  mode: 'fresh' | 'resume' | 'fork';
  sessionId?: string | null;
  /** Tracked selector used when a native session id is unavailable. */
  resumeId?: string | null;
  agent?: string | null;
  /**
   * The backend to resume ONTO, when it differs from the recorded session's own
   * (R-12, consult-expert-routing-2026-09-22 / D-005). RESUME + FORK ONLY.
   *
   * `agent` and `targetAgent` are deliberately two fields, because on a resume
   * they answer two different questions and the callers rely on the split:
   * `agent` is the backend the session WAS recorded under (launch-agent and
   * revive-responder both pass it that way, to reach the recorded backend's
   * model policy), while `targetAgent` is the backend this launch should run
   * on. Equal values are an ordinary same-backend resume; different values are
   * a conversion, and psu ports the session across.
   *
   * Unset is not "same backend" — it is "say nothing", which is what the core
   * did for every caller before R-12 and is still right for a resume that has
   * no opinion.
   */
  targetAgent?: string | null;
  plan?: string | null;
  harness?: string | null;
  account?: string | null;
  model?: string | null;
  modelSource?: CodexModelSource | null;
  /** psu reasoning effort — composed onto the model spec via {@link composeModelSpec}
   *  (psu has no standalone --effort flag), so it REQUIRES a `model` to attach to. */
  effort?: string | null;
  workspace?: string | null;
  headless?: boolean;
  /** psu --carry: persist warm/cold recovery behavior on a fresh fleet member. */
  carry?: 'warm' | 'cold' | null;
  /** psu --context-size: the growable trimmed startup seed, or the explicit
   *  'steward' intermediate (core + steward verb families, WI-2140338). */
  contextSize?: 'trimmed' | 'steward' | null;
  /** psu --compaction-limit: seed the session's soft compaction limit (tokens) at launch. */
  compactionLimit?: number | null;
  /** psu --role for the launched agent. */
  role?: string | null;
  /** Repeatable psu --stack launch-time identity bindings (`slot:id`). */
  stack?: readonly string[] | null;
  /** psu --feature id the agent should pick up. */
  feature?: string | null;
  /** psu --profile launch profile name. */
  profile?: string | null;
  /** psu --brain: launch in brain mode. */
  brain?: boolean;
  /** psu --allow-subagents: opt the session back in to its own subagent-launch tool. */
  allowSubagents?: boolean;
  /** psu --add-dir (repeatable): extra directories added to the agent's workspace. */
  addDir?: string[] | null;
  /** psu --launch-context: path to a brief/markdown file injected as the launch context. */
  launchContext?: string | null;
  /** Exact GOAL subject bootstrap must attest before the first agent turn. */
  goalBootstrapSubject?: string | null;
  /** Durable launch-mode overlay inherited from the launching session. */
  launchMode?: LaunchMode | null;
  /**
   * psu --owner-id: PRE-PIN the launched session's coord identity instead of
   * letting bootstrap-su mint one (WI-5002/EI-13277 exist for exactly this
   * "state a spawner keys pre-spawn" case).
   *
   * The caller needs this whenever it must write a row ABOUT the new agent
   * before the agent exists — `goals:start` stamps `agent_modes` (mode 'goal',
   * subject = the goal id) for this id before it spawns, so the session's very
   * first orient already knows which goal it owns. Without a pre-pin that write
   * is a race against the agent's own boot, and losing it produces the exact
   * failure already filed as EI-20015592992797890: a goal and an agent with
   * nothing joining them.
   *
   * ALLOWED ON A LAUNCH THAT MINTS AN IDENTITY — fresh, fork, and a
   * CONVERSION; refused on a same-backend resume.
   *
   * The rule is about which launches already HAVE an identity, not about the
   * mode name. A same-backend resume re-attaches the recorded session's own
   * coord id (psu's resumeEnvFor), so pinning a different one there would split
   * the session away from its own history — the pin's purpose inverted, and the
   * reason this option was fresh-only before. A FORK and a cross-backend
   * CONVERSION are the opposite case: psu deliberately mints a NEW identity for
   * both (a fork must run alongside the still-live original without colliding on
   * its locks/presence/inbox-wake; a conversion is a new session on the other
   * backend), so there is an identity to pin and nothing to split.
   *
   * consult-expert-routing-2026-09-22 P-003 needs exactly that: the consult row
   * names its responder BEFORE the answering session boots, so `consult:reply`
   * has a participant gate for that session's first turn to pass. Without the
   * pin the answering identity is minted inside the child process and is
   * unknowable to the writer of the row (the fork case) — which is the same
   * "state a spawner keys pre-spawn" problem, one launch mode over.
   */
  ownerId?: string | null;
  extraArgs?: string[] | null;
  platform?: NodeJS.Platform;
}): string {
  // Identity-shaped values land inside a terminal greeting one-liner and are
  // VALIDATED rather than quoted: an identity that falls outside the allowed
  // grammar is a bug (or an injection) we want to hear about loudly. Free-form
  // option values, including extra args, use quoteLaunchValue so each remains
  // exactly one shell/argv value.
  const safe = (label: string, v: string): string => {
    if (!/^[A-Za-z0-9._:=@/,+-]+$/.test(v)) {
      throw new Error(`buildAgentLaunchCommand: refusing ${label} with shell metacharacters: ${JSON.stringify(v)}`);
    }
    return v;
  };
  // R-12: resolve the conversion target before composing anything, so an
  // impossible request is refused here rather than emitted as a command psu
  // will reject at boot (the same rule the fresh-launch --agent default below
  // exists to enforce: the core must never compose an unlaunchable command).
  const targetAgent = opts.targetAgent?.trim() || null;
  if (targetAgent) {
    if (opts.mode === 'fresh') {
      throw new Error(
        'buildAgentLaunchCommand: targetAgent is a resume/fork conversion target; a fresh launch names its backend with `agent`',
      );
    }
    if (!isSuAgent(targetAgent)) {
      throw new Error(
        `buildAgentLaunchCommand: targetAgent must be one of ${SU_AGENTS.join('|')} (got ${targetAgent})`,
      );
    }
    // psu: "--fork is a native same-backend operation and cannot be combined
    // with a session port". A fork branches one backend's own transcript; there
    // is nothing to branch on the other side of a conversion.
    if (opts.mode === 'fork' && opts.agent?.trim() && opts.agent.trim() !== targetAgent) {
      throw new Error(
        `buildAgentLaunchCommand: --fork is a native same-backend operation and cannot convert ${opts.agent.trim()} → ${targetAgent}; use mode 'resume' to port the session`,
      );
    }
  }
  const parts = [
    'psu',
    '--no-picker',
    // P-012: never leave the account to an interactive picker in a scripted launch.
    // Omission is the explicit product default: the system/CLI credential. Gateway
    // auto-routing requires the caller to say `auto` on every platform.
    `--account=${safe('account', opts.account?.trim() || defaultLaunchAccount(opts.platform))}`,
  ];
  if (opts.mode === 'resume' || opts.mode === 'fork') {
    const requestedResumeId = opts.resumeId?.trim() || opts.sessionId?.trim() || null;
    if (!requestedResumeId) {
      throw new Error(`buildAgentLaunchCommand: mode ${opts.mode} requires sessionId or resumeId`);
    }
    const resumeLabel = opts.resumeId?.trim() ? 'resumeId' : 'sessionId';
    parts.push(`--resume=${safe(resumeLabel, requestedResumeId)}`);
    if (opts.mode === 'fork') parts.push('--fork');
    // Pre-pinned coord identity on the launches that MINT one (see the option's
    // doc). Refuse it on a same-backend resume rather than dropping it: a caller
    // that pinned an identity is about to write a row naming it, and silently
    // resuming under the RECORDED id instead produces a row pointing at a
    // session that will never answer to it.
    if (opts.ownerId) {
      const isConversionLaunch = Boolean(targetAgent && targetAgent !== opts.agent?.trim());
      if (opts.mode !== 'fork' && !isConversionLaunch) {
        throw new Error(
          'buildAgentLaunchCommand: ownerId pre-pins a NEWLY minted identity — valid on a fork or a ' +
            'cross-backend conversion, but a same-backend resume re-attaches its recorded coord id and ' +
            'must not be re-pinned',
        );
      }
      parts.push(`--owner-id=${safe('ownerId', opts.ownerId)}`);
    }
    // R-12: name the TARGET backend explicitly. Omitting it (the pre-R-12
    // behaviour) is NOT a neutral default for a conversion — psu's parseArgs
    // then back-fills the backend from `cloudModelBackendHint(model)`, which is
    // null for an OMP target, an unrecognized model id, and a conversion with
    // no model at all; resolveResumeTarget falls through to the SOURCE backend
    // and the conversion silently becomes a same-backend resume. Measured: 3 of
    // 4 cross-backend requests degraded that way, none of them loudly.
    if (targetAgent) parts.push(`--agent=${safe('targetAgent', targetAgent)}`);
  } else {
    // psu REQUIRES --agent on a FRESH launch — an omitted one is not "psu's default",
    // it is a hard boot error (`--agent must be one of claude|omp|codex (got null)`) that
    // leaves the terminal sitting on a dead prompt. Default it here, in the core, so no
    // caller can compose an unlaunchable command. (A resume/fork carries the agent kind
    // in its recorded session, so it must NOT be passed there.)
    parts.push(`--agent=${safe('agent', opts.agent?.trim() || 'claude')}`);
    // Pre-pinned coord identity, in the same slot `/api/adv/launch-su` emits it
    // (after --agent, before --harness) so a GUI launch and a tool launch stay
    // argv-comparable. FRESH ONLY — see the option's doc for why a resume must
    // never carry one.
    if (opts.ownerId) parts.push(`--owner-id=${safe('ownerId', opts.ownerId)}`);
    if (opts.harness) parts.push(`--harness=${safe('harness', opts.harness)}`);
    if (opts.plan) parts.push(`--plan=${safe('plan', opts.plan)}`);
  }
  // --headless keeps the managed-pty host ON despite non-TTY stdio, so the session
  // stays injectable (wakes AND the resume kickoff both ride that pty). Without it a
  // windowless member parks forever after one turn.
  if (opts.headless) parts.push('--headless');
  if (opts.carry) parts.push(`--carry=${opts.carry}`);
  // Effort rides the MODEL SPEC — psu has no --effort flag (D-001), so join them here.
  // Free-form-safe: a spec like `opus[1m]:high` carries `[]` outside the identity set,
  // so quote (matching memberLaunchCommand) rather than reject it via safe().
  const composedModelSpec = composeModelSpec(opts.model ?? undefined, opts.effort ?? undefined);
  // A fresh managed Codex launch must never rely on the CLI/cache default. This
  // composer is always --no-picker, so naming the backend alone is not authority
  // to synthesize the platform default; callers must supply a model or explicitly
  // pass modelSource='configured-default'. The resolver also rejects Spark before
  // a terminal opens.
  // The backend this launch will actually RUN on: on a conversion that is the
  // target, not the recorded source. Codex's "never rely on the CLI/cache
  // default" policy belongs to whichever backend boots, so a claude → codex
  // port must carry --model-source exactly as a native codex resume does.
  const effectiveAgent = targetAgent ?? opts.agent?.trim() ?? null;
  // A CONVERSION to Codex has no recorded Codex session behind it, so it stands
  // exactly where a fresh Codex launch stands: there is nothing to inherit, and
  // naming the backend alone is not authority to synthesize the platform
  // default. Putting it on the same footing makes the core refuse a model-less
  // codex conversion with the policy resolver's own actionable message, instead
  // of composing a command psu throws on at parse time — which is what this
  // path did while the conversion was still silently degrading to the source
  // backend, so nobody had ever reached it.
  const isConversion = Boolean(targetAgent && targetAgent !== opts.agent?.trim());
  const codexSelection =
    effectiveAgent === 'codex' &&
    (opts.mode === 'fresh' ||
      isConversion ||
      Boolean(composedModelSpec) ||
      opts.modelSource === 'configured-default')
    ? resolveCodexModelSelection(composedModelSpec, {
        source: opts.modelSource ?? 'explicit',
      })
    : null;
  const modelSpec = codexSelection?.model ?? composedModelSpec;
  if (modelSpec) parts.push(`--model=${quoteLaunchValue(modelSpec)}`);
  if (codexSelection) parts.push(`--model-source=${codexSelection.source}`);
  if (opts.workspace) parts.push(`--workspace=${safe('workspace', opts.workspace)}`);
  if (opts.contextSize) parts.push(`--context-size=${opts.contextSize}`);
  if (opts.compactionLimit) parts.push(`--compaction-limit=${Math.floor(opts.compactionLimit)}`);
  if (opts.role) parts.push(`--role=${quoteLaunchValue(opts.role)}`);
  if (opts.mode === 'fresh') {
    for (const ref of opts.stack ?? []) if (ref) parts.push(`--stack=${quoteLaunchValue(ref)}`);
  }
  if (opts.feature) parts.push(`--feature=${quoteLaunchValue(opts.feature)}`);
  if (opts.profile) parts.push(`--profile=${quoteLaunchValue(opts.profile)}`);
  if (opts.brain) parts.push('--brain');
  if (opts.allowSubagents) parts.push('--allow-subagents');
  for (const dir of opts.addDir ?? []) if (dir) parts.push(`--add-dir=${quoteLaunchValue(dir)}`);
  if (opts.launchContext) parts.push(`--launch-context=${quoteLaunchValue(opts.launchContext)}`);
  if (opts.goalBootstrapSubject) parts.push(`--goal-bootstrap-subject=${quoteLaunchValue(opts.goalBootstrapSubject)}`);
  if (opts.launchMode) {
    const launchMode = normalizeLaunchMode(opts.launchMode);
    if (launchMode) {
      parts.push(`--mode=${launchMode.mode}`);
      if (launchMode.subject) parts.push(`--mode-subject=${quoteLaunchValue(launchMode.subject)}`);
      if (launchMode.instructions) parts.push(`--mode-instructions=${quoteLaunchValue(launchMode.instructions)}`);
      if (launchMode.ownerDirected) parts.push('--mode-owner-directed');
    }
  }
  // Extra args are an escape hatch for psu flags whose first-class options have
  // not reached this tool yet. They may carry structured values (for example the
  // JSON offender list used by content-fixer), so shell-quote each whole arg
  // rather than rejecting braces/quotes as if they were command syntax.
  for (const a of opts.extraArgs ?? []) if (a) parts.push(quoteLaunchValue(a));
  return parts.join(' ');
}

/**
 * The account a scripted launch uses when the caller names none. The default is
 * always the system/CLI credential; platform credential mechanics must make that
 * route work rather than silently changing the user's routing choice.
 */
export function defaultLaunchAccount(_platform: NodeJS.Platform = process.platform): string {
  return 'default';
}

/** An OMP model id served only by the Papercusp inference gateway. */
export const OMP_GATEWAY_MODEL_RE = /^papercusp-gateway\//i;

/**
 * The account for a launch whose caller named NONE, given the backend and the
 * model it will actually run (WI-10004158, plan pui-chat-first-ux-2026-09-28
 * D-011). An OMP `papercusp-gateway/*` model runs only on the gateway, and the
 * default account refuses it (psu-launcher resolveOmpSessionModel), so an
 * omitted account follows that model to `auto` instead of to a certain refusal.
 * Stock `omp` with the same config uses the gateway too.
 *
 * The model is resolved with the engine's own precedence
 * (su-session-rpc-engine): the `PAPERCUSP_OMP_MODEL_SELECTOR` override, then the
 * requested model, then the OMP native default (`modelRoles.default`). Only an
 * OMITTED account is decided here; an explicit account, `default` included, is
 * never rewritten by the caller.
 */
export function defaultLaunchAccountFor(opts: {
  agent: string;
  model?: string | null;
  ompSelector?: string | null;
  ompNativeDefault?: () => string | null;
}): string {
  if (opts.agent === 'omp') {
    const effective = String(opts.ompSelector || opts.model || opts.ompNativeDefault?.() || '').trim();
    if (OMP_GATEWAY_MODEL_RE.test(effective)) return 'auto';
  }
  return defaultLaunchAccount();
}

export interface MemberLaunchOpts {
  fleetSlug: string;
  agent: string;
  harness: string;
  /** psu --plan the member self-pulls on. OPTIONAL (P-003): a pure claim-spec fleet
   *  launches with no plan — members pull via their claim spec, so `--plan` is omitted. */
  plan?: string;
  headless?: boolean;
  /**
   * psu --carry: persist the member's warm/cold carry choice in launch_argv so
   * fresh-launch attestation can compare the requested and actual session.
   */
  carry?: 'warm' | 'cold';
  /**
   * psu --owner-id: PRE-PIN this launch's coord identity instead of letting
   * bootstrap-su mint one. Same flag, same semantics and same FRESH-LAUNCH-ONLY
   * rule as buildAgentLaunchCommand's `ownerId` — see that option's doc for why a
   * resume/fork must never carry one (this composer only ever builds fresh
   * launches, so there is no resume case to guard here).
   *
   * goal-mode-hardening P-009 (NOT the leader-compaction-reseed P-009 that other
   * comments in fleet_registry/launch-on-plan.ts refer to): `leader:'spawn'` must
   * write the fleet row naming its leader BEFORE that leader exists, which is
   * exactly the "state a spawner keys pre-spawn" case the flag was added for.
   * Without it the fleet would have to be created under the CALLER and leadership
   * relayed after boot, leaving a window — permanent if the spawn never boots — in
   * which the registry says the caller leads a fleet it asked not to lead.
   */
  ownerId?: string;
  account?: string;
  workspace?: string;
  role?: string;
  /** Repeatable psu --stack launch-time identity bindings (`slot:id`). */
  stack?: readonly string[];
  model?: string;
  modelSource?: CodexModelSource;
  /** psu --effort: reasoning effort (low|medium|high|xhigh|max) when not baked into the model spec. */
  effort?: string;
  feature?: string;
  launchContext?: string;
  /** Durable launch-mode overlay inherited from the launching session. */
  launchMode?: LaunchMode | null;
  profile?: string;
  contextSize?: 'trimmed' | 'steward';
  /** psu --compaction-limit: seed the session's soft compaction limit (tokens) at launch
   *  (per-member-declarative-launch-specs P-005) — removes the brief-instruction workaround. */
  compactionLimit?: number;
  brain?: boolean;
  addDir?: string[];
  allowSubagents?: boolean;
  seat?: string;
  extraArgs?: string[];
}

/**
 * A DECLARATIVE per-member launch spec (per-member-declarative-launch-specs
 * P-001, owner directive 2026-07-19: "make the arg a declarative spec where the
 * caller can specify the per member settings in the spec").
 *
 * Each field, when set, OVERRIDES the fleet-wide launch default for THAT member;
 * an unset field falls through to the fleet default, then the system/model-tier
 * default (D-001 precedence: member > fleet > system). The launch tools compose
 * one {@link MemberLaunchOpts} per member by folding its MemberSpec over the
 * shared fleet base (see {@link foldMemberSpec}), so N members can each run a
 * distinct model / effort / account / carry / context size / compaction limit /
 * role / brief / claim lane — generalizing today's brief-only
 * `perMemberLaunchContext` to ALL settings.
 *
 * `carry` shapes the member baseline + loop:arm and is also emitted as a psu
 * flag so launch_argv can attest it. `claimKinds` is not a psu flag; it seeds
 * the per-member claim spec and is threaded by the launch tool.
 */
export interface MemberSpec {
  model?: string;
  effort?: string;
  account?: string;
  carry?: 'warm' | 'cold';
  contextSize?: 'trimmed' | 'steward';
  compactionLimit?: number;
  role?: string;
  /** Launch-time identity bindings. Replaces the fleet-wide stack for this member when set. */
  stack?: string[];
  agent?: string;
  /** Path to a brief file injected as this member's launch context (distinct per member). */
  launchContext?: string;
  /** Inline brief TEXT for this member — composed to a launch-context file by the tool when set. */
  brief?: string;
  /** Per-member claim-lane restriction — seeds this member's claim spec (bee-level, overrides the fleet spec). */
  claimKinds?: Array<'feature' | 'chunk' | 'bug' | 'change' | 'task'>;
  headless?: boolean;
  addDir?: string[];
  allowSubagents?: boolean;
  brain?: boolean;
  feature?: string;
  profile?: string;
  display?: string;
  extraArgs?: string[];
}

/**
 * The wire (zod) shape of {@link MemberSpec} — the ONE shared schema both launch
 * doors accept for `members: MemberSpec[]` (per-member-declarative-launch-specs
 * P-002: `fleet:launch-on-plan` AND `capability:launch-agent`). Kept beside the
 * `MemberSpec` type so the two never drift. Every field is optional and OVERRIDES
 * the fleet-wide arg of the same name for THAT member only; an unset field falls
 * through (member > fleet > system, D-001). `.strict()` so an unknown field is a
 * loud error, not a silent drop.
 *
 * `carry` and `claimKinds` need the fleet baseline / claim-spec machinery only
 * `fleet:launch-on-plan` builds — `capability:launch-agent` accepts them (schema
 * parity) but surfaces a warning rather than honoring them silently.
 */
export const memberSpecSchema = z
  .object({
    model: z.string().optional().describe("psu --model: this member's model spec, overriding the fleet `model`."),
    effort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
      .optional()
      .describe(
        "Reasoning effort for this member. Composed onto the model spec (`<model>:<effort>`) — psu has no separate --effort flag — so it REQUIRES a model (this member's or the fleet's).",
      ),
    account: z.string().optional().describe("psu --account: this member's account routing (<pool-id>|auto|default)."),
    carry: z.enum(['warm', 'cold']).optional().describe("This member's warm/cold auto-mode carry."),
    contextSize: z.literal('trimmed').optional().describe("psu --context-size for this member (growable trimmed seed)."),
    compactionLimit: z
      .number()
      .int()
      .min(MIN_COMPACTION_LIMIT_TOKENS)
      .optional()
      .describe(
        `psu --compaction-limit: this member's soft compaction limit in TOKENS (>= ${MIN_COMPACTION_LIMIT_TOKENS}). Clamped down to the fleet-role ceiling at seed time — it can lower a member's limit, never raise it past its cap.`,
      ),
    role: z
      .string()
      .optional()
      .describe(
        "psu --role: a registered persona id resolved against the target harness (the valid ids are harness-specific). Discover exact ids first with roles:list { harnessSlug: \"<target>\" } and read roles[].id; roles:known lists built-in ids. This is not a lane/job label; put lane direction in this member's `brief` or the shared `label`.",
      ),
    stack: z
      .array(z.string().min(1))
      .max(40)
      .optional()
      .describe("Repeatable psu --stack `slot:id` bindings for this member. Replaces the fleet-wide `stack` when set."),
    agent: z.string().optional().describe("psu --agent (claude|omp|codex) for this member."),
    launchContext: z.string().optional().describe("psu --launch-context: this member's own brief FILE path."),
    brief: z
      .string()
      .optional()
      .describe(
        "Inline brief TEXT for this member — becomes its own first turn / composed launch context. Use instead of `launchContext` when you have the text, not a file. Takes precedence over this member's `perMemberLaunchContext` entry.",
      ),
    claimKinds: z
      .array(z.enum(['feature', 'chunk', 'bug', 'change', 'task']))
      .min(1)
      .max(5)
      .optional()
      .describe("Per-member claim lane — seeds THIS member's claim spec, overriding the fleet-level `claimKinds`."),
    headless: z.boolean().optional().describe('Launch this member headless (no window).'),
    addDir: z.array(z.string()).optional().describe("psu --add-dir entries for this member."),
    allowSubagents: z.boolean().optional().describe('psu --allow-subagents for this member.'),
    brain: z.boolean().optional().describe('psu --brain for this member.'),
    feature: z.string().optional().describe('psu --feature for this member.'),
    profile: z.string().optional().describe('psu --profile for this member.'),
    display: z.string().optional().describe("Open this member's terminal on this X display."),
    extraArgs: z.array(z.string()).optional().describe("Extra verbatim psu args for this member."),
  })
  .strict();

/**
 * The fleet-wide launch defaults a per-member {@link MemberSpec} folds over
 * (P-002). Only the command-shaping fields live here; identity fields
 * (fleetSlug / harness / plan) are supplied by the launch tool per member.
 */
export type FleetMemberDefaults = Omit<MemberLaunchOpts, 'fleetSlug' | 'harness' | 'plan'> & {
  carry?: 'warm' | 'cold';
  claimKinds?: Array<'feature' | 'chunk' | 'bug' | 'change' | 'task'>;
};

/**
 * Fold a per-member {@link MemberSpec} over the fleet-wide defaults (P-002,
 * D-001 precedence: member field wins; an UNSET member field is a fallthrough,
 * never a zeroing override). Returns the per-member launch config plus the
 * non-command fields (`carry`, `claimKinds`) the tool threads separately.
 */
export function foldMemberSpec(
  base: FleetMemberDefaults,
  spec: MemberSpec | undefined,
): FleetMemberDefaults {
  if (!spec) return { ...base };
  const pick = <T>(memberVal: T | undefined, baseVal: T | undefined): T | undefined =>
    memberVal !== undefined ? memberVal : baseVal;
  return {
    ...base,
    // `agent` is the one REQUIRED field on the base — `pick` widens to
    // `string | undefined`, so narrow it back: an unset member agent inherits the
    // fleet's, it never clears it.
    agent: spec.agent ?? base.agent,
    model: pick(spec.model, base.model),
    modelSource: spec.model !== undefined ? 'explicit' : base.modelSource,
    effort: pick(spec.effort, base.effort),
    account: pick(spec.account, base.account),
    carry: pick(spec.carry, base.carry),
    contextSize: pick(spec.contextSize, base.contextSize),
    compactionLimit: pick(spec.compactionLimit, base.compactionLimit),
    role: pick(spec.role, base.role),
    stack: pick(spec.stack, base.stack),
    launchContext: pick(spec.launchContext, base.launchContext),
    claimKinds: pick(spec.claimKinds, base.claimKinds),
    headless: pick(spec.headless, base.headless),
    addDir: pick(spec.addDir, base.addDir),
    allowSubagents: pick(spec.allowSubagents, base.allowSubagents),
    brain: pick(spec.brain, base.brain),
    feature: pick(spec.feature, base.feature),
    profile: pick(spec.profile, base.profile),
    extraArgs: pick(spec.extraArgs, base.extraArgs),
  };
}

/**
 * Compose the psu `--model` value from a model id + an optional separate effort
 * (per-member-declarative-launch-specs D-001). A `MemberSpec` names `model` and
 * `effort` independently — the wire form psu understands is the single suffixed
 * spec, so they are joined HERE.
 *
 * WI-6321: the IMPLEMENTATION now lives in the client-safe `agent-config-constants`
 * so the GUI launcher shares it rather than carrying a third copy that dropped
 * effort silently. This wrapper survives only to keep the `memberLaunchCommand:`
 * prefix on the error (fleet-launch callers match on it) and the local name.
 */
export function composeModelSpec(model?: string, effort?: string): string | undefined {
  try {
    return composeLaunchModelSpec(model, effort);
  } catch (e) {
    throw new Error(`memberLaunchCommand: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Shell-quote free-form values that are embedded in the scripted psu command. */
function quoteLaunchValue(value: string): string {
  return /^[A-Za-z0-9_.:=/+@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compose the scripted psu launch for a fleet member. The command's base
 * identity values are validated as identifiers, while paths, role/profile,
 * launch context, and escape-hatch args retain the fleet launcher's
 * shell-quoting behavior. This keeps the fleet path on the shared launch core
 * without weakening its injection boundary or breaking paths with spaces.
 */
export function memberLaunchCommand(opts: MemberLaunchOpts): string {
  const identifier = (label: string, value: string): string => {
    if (!/^[A-Za-z0-9._:=@/,+-]+$/.test(value)) {
      throw new Error(`memberLaunchCommand: refusing ${label} with shell metacharacters: ${JSON.stringify(value)}`);
    }
    return value;
  };
  const parts = [
    'psu',
    '--no-picker',
    `--fleet=${identifier('fleet', opts.fleetSlug)}`,
    `--agent=${identifier('agent', opts.agent)}`,
    // Pre-pinned coord identity, emitted in the SAME slot buildAgentLaunchCommand
    // uses (after --agent, before --harness) so the two composers stay
    // argv-comparable — the property that lets a GUI launch and a tool launch be
    // diffed against each other when one of them misbehaves.
    ...(opts.ownerId ? [`--owner-id=${identifier('ownerId', opts.ownerId)}`] : []),
    `--harness=${identifier('harness', opts.harness)}`,
  ];
  // P-003: `plan` is optional — a pure claim-spec fleet (launched without a plan)
  // omits `--plan`; its members self-pull via the fleet claim spec, not a plan lane.
  if (opts.plan) parts.push(`--plan=${identifier('plan', opts.plan)}`);
  if (opts.headless) parts.push('--headless');
  if (opts.carry) parts.push(`--carry=${opts.carry}`);
  if (opts.account) parts.push(`--account=${quoteLaunchValue(opts.account)}`);
  if (opts.workspace) parts.push(`--workspace=${quoteLaunchValue(opts.workspace)}`);
  if (opts.role) parts.push(`--role=${quoteLaunchValue(opts.role)}`);
  for (const ref of opts.stack ?? []) if (ref) parts.push(`--stack=${quoteLaunchValue(ref)}`);
  // Effort rides the MODEL SPEC, not a flag of its own: psu has no `--effort`
  // (D-001) — an unrecognized flag is WARNED AND DROPPED by parseArgs, so a
  // separate `--effort=` emission is a silent no-op. psu's modelArgsFor splits a
  // `<model>:<effort>` tail per backend (claude → `--model X --effort Y`; codex →
  // `-c model_reasoning_effort`; omp verbatim), so composing it here is the ONE
  // form every backend honors.
  const composedModelSpec = composeModelSpec(opts.model, opts.effort);
  // Fleet member commands are scripted --no-picker launches. A backend name is
  // not model authority: only a supplied model or an explicit configured-default
  // source may resolve absence.
  const codexSelection = opts.agent === 'codex'
    ? resolveCodexModelSelection(composedModelSpec, {
        source: opts.modelSource ?? 'explicit',
      })
    : null;
  const modelSpec = codexSelection?.model ?? composedModelSpec;
  if (modelSpec) parts.push(`--model=${quoteLaunchValue(modelSpec)}`);
  if (codexSelection) parts.push(`--model-source=${codexSelection.source}`);
  // P-005 (landed): psu parses `--compaction-limit` and re-emits it onto
  // adv_sessions.launch_argv; the compaction watchdog's seeding pass reads it back
  // and applies it ahead of the tier/model default, clamped to the fleet-role
  // ceiling. Emitting it here is what makes MemberSpec.compactionLimit real.
  if (opts.compactionLimit) parts.push(`--compaction-limit=${Math.floor(opts.compactionLimit)}`);
  if (opts.feature) parts.push(`--feature=${quoteLaunchValue(opts.feature)}`);
  if (opts.launchContext) parts.push(`--launch-context=${quoteLaunchValue(opts.launchContext)}`);
  if (opts.profile) parts.push(`--profile=${quoteLaunchValue(opts.profile)}`);
  if (opts.contextSize) parts.push(`--context-size=${opts.contextSize}`);
  if (opts.brain) parts.push('--brain');
  if (opts.allowSubagents) parts.push('--allow-subagents');
  if (opts.seat) parts.push(`--seat=${quoteLaunchValue(opts.seat)}`);
  for (const dir of opts.addDir ?? []) if (dir) parts.push(`--add-dir=${quoteLaunchValue(dir)}`);
  if (opts.launchMode) {
    const launchMode = normalizeLaunchMode(opts.launchMode);
    if (launchMode) {
      parts.push(`--mode=${launchMode.mode}`);
      if (launchMode.subject) parts.push(`--mode-subject=${quoteLaunchValue(launchMode.subject)}`);
      if (launchMode.instructions) parts.push(`--mode-instructions=${quoteLaunchValue(launchMode.instructions)}`);
      if (launchMode.ownerDirected) parts.push('--mode-owner-directed');
    }
  }
  for (const arg of opts.extraArgs ?? []) if (arg) parts.push(quoteLaunchValue(arg));
  return parts.join(' ');
}

/**
 * The universal MEMBER OPERATING BASELINE rules, composed onto EVERY member's
 * launch context ahead of any per-fleet brief. Encodes the drain-discipline
 * lessons learned watching real fleets run: check-already-fixed before building,
 * flag to the leader (not just the broadcast stream), don't re-claim a
 * ping-ponging item, and always ship completion evidence. Single source so the
 * member's full text and the leader's echo (headlines) can never drift.
 */
export const MEMBER_BASELINE_RULES: ReadonlyArray<{ head: string; body: string }> = [
  {
    head: 'Already-fixed check FIRST',
    body: "Before building, spend ~2 min checking code/tests, `git log`, and sibling work-items for an existing fix. If it shipped, close as already-fixed WITH that evidence; do not rebuild it.",
  },
  {
    // EI-8318: members were completing exactly ONE item per external wake, then ending
    // their turn with no armed self-wake — the leader became a manual clock, capping
    // fleet throughput at its re-wake cadence instead of draining continuously.
    // EI-8393: kept tight — this rule is the single biggest driver of the P-013
    // prompt-bloat budget; trim further before adding anything to it.
    head: 'STAY ALIVE across turns — loop:arm at spawn, not park',
    body: 'No human is at your keyboard: FIRST call `loop:arm { intervalSec, goal }`. Each wake, `scheduler:get_next` → work to terminal (`work_items:complete`) → repeat. Call `loop:end { acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true }` only when no claimable work remains or you are blocked; otherwise ending without the loop parks you until a leader wake (EI-8318).',
  },
  {
    head: 'Flag to your LEADER; keep status in your FLEET, not the whole hive',
    body: 'Send blockers, systemic findings, and "nothing left to claim" to the leader (`wakeOnReply:true`) — broadcast is easy to miss. A finding >1 paragraph goes on the item, not chat; `coord:read {msg_id}` gets its full text. In-fleet: bare to:["*"] auto-scopes `@fleet:<slug>`; `allHive:true` only for system-wide news.',
  },
  {
    head: 'Do not re-claim a ping-ponging item',
    body: 'Releasing an item bumps its `updated_at`, so it can re-surface at the top of next `scheduler:get_next` pull and loop on it. If an item reappears right after you release it, sink it (work_items:set_priority) or set it `blocked` with a reason — do not re-claim.',
  },
  {
    head: 'Completion evidence is mandatory',
    body: '`work_items:complete` needs `{id,state,assumptions: "none",completion:{summary,testsRun,testResult,verifiedHow,filesChanged}}`; fact keys may replace `"none"`. Successful bug/capability-gap closes also need `completion.rootCauseVerification:{hypothesis,alternativeHypothesis,distinguishingTest,testResult,testProcedure,predictedObservations:{hypothesis:"<H1>",alternativeHypothesis:"<H2>"},actualObservation,evidenceRefs}`. The typed predictions must differ; `distinguishingTest` requires no prose template.',
  },
  {
    head: '"Not available" means DEFERRED, not missing',
    body: 'InputValidationError/"not available" means load the tool (ToolSearch/tools:find) and continue; never report it missing.',
  },
  {
    head: 'Edit only the staging tree; git-sync owns commit + push',
    body: 'Never git add/commit/push. If a file lock blocks an edit, pivot rather than route around it.',
  },
  {
    head: 'A hive pause is a Mug-loop signal, not a self-drain order',
    body: "`pauseNewWork` / `maxBees` / a pot-steering fact you SEE in orient governs the autonomous mug-cup loop — do NOT stop your claimed work on it. Wind down only on a graceful-drain cue ADDRESSED to you (check its authority+scope stamp: `hive-queen(<hive>)→hive-wide` is the Mug; a `fleet-leader(<other>)→fleet-members` cue is a DIFFERENT fleet's business — ignore it) or an explicit `fleet:*`/owner action. Unsure? Ask your leader, never self-drain on an observed pause.",
  },
  {
    // su-loop-capability-parity P-011: the bee turn-end reflection ritual + the overwatch
    // integrity clause, ported to fleet members (bee.base.md / the overwatch prompt).
    head: 'Turn-end reflection + reporting integrity',
    body: "End each turn with ONE bounded reflection: file an observation (`improvements:capture lane:\"observation\"`) ONLY if the turn surfaced something a FUTURE agent benefits from — a routine turn records NOTHING (a sensor reading, never a fix or self-grade). Never fabricate a signal: a truthful `blocked` beats a fabricated all-clear — never report a state you weren't in, a send you didn't make, or a reading you didn't take.",
  },
  {
    // su-loop-capability-parity P-012: the bee checkpoint protocol (bee.base.md §"End of
    // turn — checkpoint"), ported to fleet members. Store + injection seam already exist.
    head: 'Carry-note checkpoint at every boundary',
    body: 'Write `work_items:checkpoint { id, checkpoint }` at task completion, before going idle at a task boundary, and on graceful-evict — so your successor resumes mid-thread instead of cold. Content = what you accomplished / what is left / the key insight / a gotcha for your successor; concrete facts, not self-evaluation; a compact digest, never a transcript. Replace-on-write (blank to clear).',
  },
];

/** Render the full member-facing baseline markdown (the numbered rules with a
 *  short header). Pure + exported for tests.
 *  P-004 carry (owner directive 2026-07-10, orthogonal to headless): every member
 *  gets an explicit `carry` on its loop:arm instruction. `carry:'warm'` is the
 *  fleet default and is explicit because loop:arm has a different context-sensitive
 *  default for an unattended headless caller. `carry:'cold'` rewrites the rule to
 *  arm a COLD loop (each wake a fresh context) and promotes the carry-note checkpoint
 *  from "at every boundary" to LOAD-BEARING — a cold wake reconstructs ONLY from the
 *  last checkpoint. This keeps the fleet's warm/cold launch knob authoritative and
 *  prevents a headless member from silently overriding the fleet default. */
export function renderMemberBaseline(opts: {
  fleetSlug: string;
  /** OPTIONAL (P-003): a pure claim-spec fleet has no plan — the baseline then points
   *  at the fleet's claim lane instead of a named plan. */
  plan?: string | null;
  count: number;
  carry?: 'warm' | 'cold';
}): string {
  const { fleetSlug, plan, count, carry = 'warm' } = opts;
  const cold = carry === 'cold';
  const rules = MEMBER_BASELINE_RULES.map((r, i) => {
    let body = r.body;
    if (r.head.startsWith('STAY ALIVE')) {
      const carryInstruction = `\`loop:arm { intervalSec, goal, carry: '${carry}' }\``;
      body = body.replace('`loop:arm { intervalSec, goal }`', carryInstruction);
      if (cold) {
        body +=
          ' — you are a COLD member: each wake starts a FRESH context, so nothing but your checkpoint carries across wakes';
      }
    }
    if (cold && r.head.startsWith('Carry-note checkpoint')) {
      body = `${body} COLD CARRY makes this LOAD-BEARING, not optional: your next wake reconstructs itself ONLY from this checkpoint — skip it and your successor-self wakes blind with no memory of what you did.`;
    }
    return `${i + 1}. **${r.head}.** ${body}`;
  }).join('\n');
  return [
    '# Fleet member — operating baseline',
    '',
    `You are one of ${count} parallel worker agent${count === 1 ? '' : 's'} in fleet \`${fleetSlug}\`, ${plan ? `working plan \`${plan}\`` : 'draining your fleet claim-lane backlog'}. The session that launched you is your LEADER — report notable completions and blockers to them.`,
    '',
    "Loop: **pull** with `scheduler:get_next { harness: '<your-harness>' }` (`heldPaths`; `states` only when filtering and only `open|failing`; never pass retired `todo` or floor/terminal states; `rigAvailable`; omit `specId`/`revision`; inspect `claimedUnder`; leader steers via `scheduler:set_claim_spec`; NOT `work_items:claim_next`; PICKUP is yours) → **read** with `work_items:get` → **act** → terminal evidence → repeat. Do NOT self-prioritize by scanning `work_items:list`.",
    '',
    '## Non-negotiables',
    rules,
  ].join('\n');
}

/** The GOAL holder's live allocation, carried to leaders and every member. */
export function renderGoalFleetAllocation(opts: {
  goalId: string;
  intendedParallelPlanFleets: number | null;
  fleetMemberTarget?: number;
}): string {
  return [
    '## GOAL parallel allocation',
    `Goal \`${opts.goalId}\`: intended concurrent plan fleets = ${opts.intendedParallelPlanFleets ?? 'undeclared'}${opts.fleetMemberTarget == null ? '' : `; this fleet member target = ${opts.fleetMemberTarget}`}.`,
    'The GOAL holder chooses this width from the live portfolio. Max agents and max per fleet are binding ceilings, not targets to fill. Independent plan lanes may run concurrently; ask the holder before changing this allocation.',
  ].join('\n');
}

/** Compose a member's launch context = the universal baseline + (optionally) the
 *  leader's per-fleet brief BELOW it (the brief wins on fleet-specifics). Pure +
 *  exported for tests. */
export function composeMemberLaunchContext(opts: {
  fleetSlug: string;
  /** OPTIONAL (P-003): absent for a pure claim-spec fleet. */
  plan?: string | null;
  count: number;
  carry?: 'warm' | 'cold';
  customBriefText?: string | null;
  goalAllocation?: { goalId: string; intendedParallelPlanFleets: number | null } | null;
}): string {
  const baseline = renderMemberBaseline(opts);
  const brief = opts.customBriefText?.trim();
  const composed = brief
    ? `${baseline}\n\n---\n\n# Fleet-specific brief (from your leader — wins on specifics)\n\n${brief}\n`
    : `${baseline}\n`;
  // This is deliberately appended AFTER the leader brief.  A custom kickoff may
  // steer the member's work, but it cannot turn a generic launch into proof of
  // evaluator independence.  Without this final section, a fleet leader could
  // label a member a "non-lineage independent reviewer" and spend a complete
  // grading pass before scorecards:emit finally rejected the member's lineage.
  const goalAllocation = opts.goalAllocation
    ? `\n---\n\n${renderGoalFleetAllocation({ ...opts.goalAllocation, fleetMemberTarget: opts.count })}\n`
    : '';
  return `${composed}${goalAllocation}\n---\n\n${IMMUTABLE_MEMBER_LAUNCH_LINEAGE_GUARD}\n`;
}

/**
 * Identity safety rail for every composed fleet-member context.
 *
 * `independent:true`, fleet membership, and a leader-written brief are launch
 * placement/configuration choices; none is evidence that the member is outside
 * the rubric author's spawn/rebind lineage.  Keep this after any custom brief
 * so the leader cannot accidentally override the routing rule with prose.
 */
export const IMMUTABLE_MEMBER_LAUNCH_LINEAGE_GUARD = [
  '# Immutable launch-lineage guard',
  '',
  'A launch mode, fleet membership, `independent:true`, or a leader-written brief does NOT make this session lineage-independent of its launcher. Never describe yourself as a "non-lineage independent reviewer/grader" solely because you were launched into a fleet.',
  'Before grading an acceptance rubric, run `scorecards:evaluate` as the read-only eligibility preflight. If it reports `grader_in_implementer_lineage` (or another disqualification), do not spend the grading pass or attempt `scorecards:emit`; route the grading request to an existing unrelated live session with `coord:dispatch` or explicit `assign_to`.',
].join('\n');

/** The window a completed launch result stays authoritative. Old rows are
 *  pruned on each call — the ledger answers "did THIS call already land", not
 *  "has anyone ever used this key", so a week is generous for a retry. */
const LAUNCH_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An empty summary is the durable in-progress sentinel. A normal launch records
 * a result or releases the row, but a process can die in the narrow window
 * between claiming and either action. Keep a recent sentinel fail-closed so an
 * ordinary client retry cannot open duplicate windows, then let one caller
 * atomically take it over after every bounded launch/verification window has
 * elapsed. Fifteen minutes is deliberately longer than the launch door's
 * spawn + readiness verification budget.
 */
export const AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS = 15 * 60 * 1000;

/**
 * An explicit `agentStarted: null` result means the launch verifier's bounded
 * window expired without enough evidence to call the launch healthy or dead.
 * Keep that receipt authoritative while a slow first turn can still reasonably
 * arrive, then let one retry reclaim it only when the receipt has no durable
 * task identity. A task/log identity makes the launch recoverable even when
 * bounded kickoff proof is absent; leasing over that receipt can duplicate a
 * still-live process. The JSON null check below is deliberately stricter than
 * "field missing": callers that could not run the verifier have no liveness
 * evidence and must remain deduped.
 */
export const AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS = 30 * 60 * 1000;

export interface AgentLaunchClaim {
  /** false ⇒ a prior call already launched under this key; do NOT launch again. */
  won: boolean;
  /** What that prior call reported (empty for a fresh claim). */
  priorSummary: Record<string, unknown> | null;
  priorLaunchedAt: number | null;
  priorLaunchedBy: string | null;
}

/**
 * Idempotency guard for agent launches (P-014, migration 586). A launch opens
 * REAL windows/processes, so a re-fired tool call (a client retry after a
 * timeout, a loop that fires twice) must not open a SECOND set — the 2026-07-03
 * "12 windows" incident class. The first caller for a key wins the row; a replay
 * loses the INSERT race and gets the original's summary back.
 *
 * No key ⇒ no guard (won: true) — the caller opted out, exactly like cup:spawn.
 */
export async function claimAgentLaunch(opts: {
  workspaceId: string;
  idempotencyKey: string | null | undefined;
  launchedBy?: string | null;
  now?: number;
}): Promise<AgentLaunchClaim> {
  const key = opts.idempotencyKey?.trim();
  if (!key) return { won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null };
  const now = opts.now ?? Date.now();
  const { sql } = getOrgPg();
  try {
    await sql`
      DELETE FROM harness_shared.agent_launch_idempotency
       WHERE launched_at < ${now - LAUNCH_CLAIM_TTL_MS}
    `;
    const won = await sql<Array<{ idempotency_key: string }>>`
      INSERT INTO harness_shared.agent_launch_idempotency AS existing
        (workspace_id, idempotency_key, launched_at, launched_by, summary)
      VALUES (${opts.workspaceId}, ${key}, ${now}, ${opts.launchedBy ?? null}, '{}'::jsonb)
      ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
         SET launched_at = EXCLUDED.launched_at,
             launched_by = EXCLUDED.launched_by,
             summary = '{}'::jsonb
       WHERE existing.launched_at < ${now - AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS}
         AND (
           existing.summary = '{}'::jsonb
           OR (
             existing.summary -> 'agentStarted' = 'null'::jsonb
             AND existing.launched_at < ${now - AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS}
             AND (
               jsonb_typeof(existing.summary -> 'tasks') IS DISTINCT FROM 'array'
               OR jsonb_array_length(existing.summary -> 'tasks') = 0
             )
           )
         )
      RETURNING idempotency_key
    `;
    if (won.length) return { won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null };
    const [prior] = await sql<
      Array<{ summary: Record<string, unknown>; launched_at: number; launched_by: string | null }>
    >`
      SELECT summary, launched_at, launched_by
        FROM harness_shared.agent_launch_idempotency
       WHERE workspace_id = ${opts.workspaceId} AND idempotency_key = ${key}
    `;
    return {
      won: false,
      priorSummary: prior?.summary ?? null,
      priorLaunchedAt: prior?.launched_at != null ? Number(prior.launched_at) : null,
      priorLaunchedBy: prior?.launched_by ?? null,
    };
  } catch (e) {
    // The guard is a safety net, not a gate: a ledger outage must not block a
    // launch the caller actually wants. Warn loudly and proceed unguarded.
    console.warn(`[agent-launch] idempotency claim failed (launching unguarded): ${(e as Error)?.message ?? e}`);
    return { won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null };
  }
}

/** Record what the winning launch actually did, so a later replay of the same key
 *  can report it instead of a bare "already launched". Best-effort. */
export async function recordAgentLaunchResult(opts: {
  workspaceId: string;
  idempotencyKey: string | null | undefined;
  summary: Record<string, unknown>;
}): Promise<void> {
  const key = opts.idempotencyKey?.trim();
  if (!key) return;
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.agent_launch_idempotency
         SET summary = ${JSON.stringify(opts.summary)}::text::jsonb
       WHERE workspace_id = ${opts.workspaceId} AND idempotency_key = ${key}
    `;
  } catch (e) {
    console.warn(`[agent-launch] idempotency result write failed: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Release a launch claim whose winning caller failed before it could record a
 * successful result. This is the rollback half of `claimAgentLaunch`: without
 * it, a validation/storage failure after the claim leaves an empty summary in
 * the ledger for seven days and every honest retry is misclassified as an
 * already-completed launch.
 *
 * A completed launch must never call this helper. Its claim is the durable
 * replay record that prevents a later client retry from opening another
 * window/process.
 */
export async function releaseAgentLaunchClaim(opts: {
  workspaceId: string;
  idempotencyKey: string | null | undefined;
}): Promise<boolean> {
  const key = opts.idempotencyKey?.trim();
  if (!key) return false;
  try {
    const { sql } = getOrgPg();
    const released = await sql<Array<{ idempotency_key: string }>>`
      DELETE FROM harness_shared.agent_launch_idempotency
       WHERE workspace_id = ${opts.workspaceId} AND idempotency_key = ${key}
      RETURNING idempotency_key
    `;
    return released.length > 0;
  } catch (e) {
    console.warn(`[agent-launch] idempotency claim release failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

/**
 * Post-resume kickoff delivery (P-011, D-008): a resumed session boots IDLE and
 * its presence rows were reaped at death, so roster-gated coord:wake / coord:send
 * reject it (`unknown_recipient`) — nothing coord-side can deliver the first
 * turn. Deliver it through the psu pty-host discovery socket instead
 * (`{v:1, mode:'turn', data}` — idle-gated wake-as-Enter): poll for the host's
 * discovery file (the resumed psu host writes it once the pty is up), then
 * inject. Loud result either way; live-proven on the desktop-release-0-0-8 legs
 * (2026-07-12).
 */
export async function injectKickoffAfterResume(
  ownerId: string,
  kickoff: string,
  {
    timeoutMs = 120_000,
    pollMs = 2_000,
    findHost = findLiveHost,
    inject = injectIntoHost,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    timeoutMs?: number;
    pollMs?: number;
    findHost?: typeof findLiveHost;
    inject?: typeof injectIntoHost;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ delivered: boolean; waitedMs: number; error?: string }> {
  const started = Date.now();
  for (;;) {
    const host = findHost(ownerId);
    if (host?.sock) {
      // EI-153 addressing: currently zero production callers, but this is the
      // closest shape-match in the tree to an observed cross-owner fan-out (a
      // for(;;) re-resolving the host every pollMs=2_000) and has repeatedly
      // read as the culprit during WI-2140968 triage. Addressing it removes the
      // trap AND the latent hole: without `ownerId` the host's misdelivery
      // guard abstains, so a stale/mis-resolved socket accepts the turn.
      const ok = await inject(host.sock, { mode: 'turn', data: kickoff, ownerId });
      return ok
        ? { delivered: true, waitedMs: Date.now() - started }
        : {
            delivered: false,
            waitedMs: Date.now() - started,
            error: `pty host found (pid ${host.pid}) but the socket write failed — inject manually or re-wake once the session registers presence`,
          };
    }
    if (Date.now() - started + pollMs > timeoutMs) {
      return {
        delivered: false,
        waitedMs: Date.now() - started,
        error:
          `no live pty host appeared for ${ownerId} within ${Math.round(timeoutMs / 1000)}s — the resume may have `
          + 'failed to boot (check the terminal window) or the session is headless (kickoff rides the command instead)',
      };
    }
    await sleep(pollMs);
  }
}

// ─── FRESH-launch verification (P-003 / D-004) ───────────────────────────────

/**
 * Tool names that are STATUSLINE / harness machinery, not the agent taking a turn.
 *
 * This list is the whole reason fresh-launch verification is possible. A DEAD
 * launch emits these too — the measured acceptance case (adv_session 14842) fired
 * `activity:report` at +3.6s and `coord:glance` at +3.7s and then never did
 * anything again, for the hour until the reaper closed it. Counting raw tool calls
 * therefore cannot separate a booted-and-working agent from a booted-and-dead one;
 * counting calls OUTSIDE this set can.
 */
export const LAUNCH_STATUSLINE_TOOLS: readonly string[] = ['activity:report', 'coord:glance'];

/** How long to watch a fresh launch before returning a verdict. */
export const FRESH_VERIFY_TIMEOUT_MS = 25_000;
/**
 * A session whose LAST signal of any kind is older than this, at the end of the
 * window, has gone silent. Measured basis: across 24h, a session that never made a
 * real call had its last statusline beat at a median of 4.9s after launch, while a
 * live session keeps beating for hours. 12s sits well clear of the dud median
 * without reaching into a live session's beat interval.
 */
export const FRESH_VERIFY_SILENCE_MS = 12_000;

export type FreshLaunchWorkerStageStatus = 'satisfied' | 'missing' | 'failed';

export type FreshLaunchWorkerFailureCode =
  | 'agent-call-missing'
  | 'durable-wake-missing'
  | 'scheduler-pull-missing'
  | 'scheduler-pull-failed'
  | 'disposition-missing';

export interface FreshLaunchWorkerFailure {
  stage: 'agentCall' | 'durableWake' | 'schedulerPull' | 'disposition';
  code: FreshLaunchWorkerFailureCode;
  detail: string;
}

/**
 * The four durable facts that make a freshly opened fleet member productive.
 *
 * This is deliberately separate from `agentStarted`: taking one real turn proves
 * the CLI reached the agent, but it does not prove the member installed a wake,
 * pulled its scheduler lane, or left an accountable claim/no-claim disposition.
 */
export interface FreshLaunchWorkerAttestation {
  version: 1;
  ownerId: string | null;
  ready: boolean;
  stages: {
    agentCall: {
      status: 'satisfied' | 'missing';
      successfulCalls: number;
    };
    durableWake: {
      status: 'satisfied' | 'missing';
      wakeSource: string | null;
    };
    schedulerPull: {
      status: FreshLaunchWorkerStageStatus;
      calls: number;
      successfulCalls: number;
    };
    disposition:
      | { status: 'satisfied'; kind: 'claimed'; workItemId: string }
      | { status: 'satisfied'; kind: 'no-claim'; reason: string }
      | { status: 'missing'; kind: 'missing' };
  };
  failures: FreshLaunchWorkerFailure[];
}

export interface FreshLaunchWorkerEvidence {
  ownerId: string | null;
  successfulCalls: number;
  wakeSource: unknown;
  schedulerCalls: number;
  successfulSchedulerCalls: number;
  schedulerDisposition: unknown;
  claimedWorkItemId: string | null;
}

/** Derive worker readiness only from durable writer-owned evidence. */
export function deriveFreshLaunchWorkerAttestation(
  evidence: FreshLaunchWorkerEvidence,
): FreshLaunchWorkerAttestation {
  const successfulCalls = Number.isFinite(evidence.successfulCalls)
    ? Math.max(0, Math.floor(evidence.successfulCalls))
    : 0;
  const schedulerCalls = Number.isFinite(evidence.schedulerCalls)
    ? Math.max(0, Math.floor(evidence.schedulerCalls))
    : 0;
  const successfulSchedulerCalls = Number.isFinite(evidence.successfulSchedulerCalls)
    ? Math.max(0, Math.floor(evidence.successfulSchedulerCalls))
    : 0;
  const wakeSource = typeof evidence.wakeSource === 'string' && evidence.wakeSource.trim()
    ? evidence.wakeSource.trim()
    : null;
  const durableWake = wakeSource === 'loop' || wakeSource === 'event';
  const claimedWorkItemId = evidence.claimedWorkItemId?.trim() || null;
  const rawDisposition = evidence.schedulerDisposition && typeof evidence.schedulerDisposition === 'object'
    ? evidence.schedulerDisposition as Record<string, unknown>
    : null;
  const noClaimReason = rawDisposition?.kind === 'no-claim' && typeof rawDisposition.reason === 'string'
    ? rawDisposition.reason.trim()
    : '';
  const disposition: FreshLaunchWorkerAttestation['stages']['disposition'] = claimedWorkItemId
    ? { status: 'satisfied', kind: 'claimed', workItemId: claimedWorkItemId }
    : noClaimReason
      ? { status: 'satisfied', kind: 'no-claim', reason: noClaimReason }
      : { status: 'missing', kind: 'missing' };
  const schedulerStatus: FreshLaunchWorkerStageStatus = successfulSchedulerCalls > 0
    ? 'satisfied'
    : schedulerCalls > 0
      ? 'failed'
      : 'missing';
  const failures: FreshLaunchWorkerFailure[] = [];

  if (successfulCalls === 0) {
    failures.push({
      stage: 'agentCall',
      code: 'agent-call-missing',
      detail: 'No successful agent-origin call outside launch statuslines was observed.',
    });
  }
  if (!durableWake) {
    failures.push({
      stage: 'durableWake',
      code: 'durable-wake-missing',
      detail: wakeSource
        ? `Wake source ${JSON.stringify(wakeSource)} is not a durable loop or exact event wait.`
        : 'No durable loop or exact event-wait wake source was observed.',
    });
  }
  if (schedulerStatus !== 'satisfied') {
    failures.push({
      stage: 'schedulerPull',
      code: schedulerStatus === 'failed' ? 'scheduler-pull-failed' : 'scheduler-pull-missing',
      detail: schedulerStatus === 'failed'
        ? `${schedulerCalls} scheduler:get_next call(s) were observed, but none completed successfully.`
        : 'No scheduler:get_next call was observed.',
    });
  }
  if (disposition.status !== 'satisfied') {
    failures.push({
      stage: 'disposition',
      code: 'disposition-missing',
      detail:
        'No current/terminal/historical claim and no structured scheduler no-claim diagnosis were observed.',
    });
  }

  return {
    version: 1,
    ownerId: evidence.ownerId,
    ready: failures.length === 0,
    stages: {
      agentCall: {
        status: successfulCalls > 0 ? 'satisfied' : 'missing',
        successfulCalls,
      },
      durableWake: {
        status: durableWake ? 'satisfied' : 'missing',
        wakeSource,
      },
      schedulerPull: {
        status: schedulerStatus,
        calls: schedulerCalls,
        successfulCalls: successfulSchedulerCalls,
      },
      disposition,
    },
    failures,
  };
}

/**
 * Small, aggregate launch receipt for callers that should not have to interpret
 * the full worker-attestation graph before reporting what actually happened.
 *
 * The detailed attestation remains the writer-owned evidence. This projection is
 * deliberately count-preserving: partial registration and mixed task dispositions
 * remain visible, while every opened process without a satisfied disposition is
 * counted as unknown rather than being collapsed into success or failure.
 */
export interface FreshLaunchEvidenceSummary {
  version: 1;
  processOpened: number;
  sessionRegistered: number | null;
  firstTurn: boolean | null;
  taskDisposition: {
    claimed: number;
    noClaim: number;
    unknown: number;
  };
}

export function deriveFreshLaunchEvidenceSummary(args: {
  opened: number;
  firstTurn: boolean | null;
  workerAttestations?: readonly (FreshLaunchWorkerAttestation | null | undefined)[] | null;
}): FreshLaunchEvidenceSummary {
  const opened = Number.isFinite(args.opened) ? Math.max(0, Math.floor(args.opened)) : 0;
  const seen = new Set<string>();
  const observed: FreshLaunchWorkerAttestation[] = [];
  for (const [index, attestation] of (args.workerAttestations ?? []).entries()) {
    if (!attestation) continue;
    const ownerId = attestation.ownerId?.trim();
    const key = ownerId ? `owner:${ownerId}` : `anonymous:${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observed.push(attestation);
  }
  const relevant = observed.slice(0, opened);
  const dispositions = relevant.map((attestation) => attestation.stages.disposition);
  const claimed = dispositions.filter(
    (item) => item.status === 'satisfied' && item.kind === 'claimed',
  ).length;
  const noClaim = dispositions.filter(
    (item) => item.status === 'satisfied' && item.kind === 'no-claim',
  ).length;

  return {
    version: 1,
    processOpened: opened,
    sessionRegistered: relevant.length > 0 ? relevant.length : null,
    firstTurn: opened > 0 ? args.firstTurn : null,
    taskDisposition: {
      claimed,
      noClaim,
      unknown: Math.max(0, opened - claimed - noClaim),
    },
  };
}

export function formatFreshLaunchEvidenceSummary(summary: FreshLaunchEvidenceSummary): string {
  const observed = (value: boolean | null): string => value == null ? 'unknown' : String(value);
  const registered = summary.sessionRegistered == null ? 'unknown' : String(summary.sessionRegistered);
  return (
    `Launch evidence (aggregate): processOpened=${summary.processOpened}; ` +
    `sessionRegistered=${registered}; firstTurn=${observed(summary.firstTurn)}; ` +
    `taskDisposition=claimed:${summary.taskDisposition.claimed},` +
    `noClaim:${summary.taskDisposition.noClaim},unknown:${summary.taskDisposition.unknown}. ` +
    'Process open alone is not proof that an agent is working.'
  );
}

export interface FreshLaunchSessionProbe {
  advSessionId: number;
  /** Native session id recorded for this launch, when bootstrap had one. */
  sessionId: string | null;
  ownerId: string | null;
  /** Successful, agent-chosen calls other than launch statuslines. */
  successfulCalls: number;
  /** ms since this session's most recent signal of ANY kind (null = never any). */
  msSinceLastSignal: number | null;
  /** A live coord_presence row exists for its owner. */
  hasPresence: boolean;
  /** Current host-observed usage-limit state. `null` means no live/new-enough
   *  PsuPtyHost reading exists, not that quota is healthy. */
  quotaBlocked: boolean | null;
  /** Start of the current host-observed quota episode, when available. */
  quotaBlockedSinceMs: number | null;
  /** Requested-vs-actual differences measured from the persisted launch spec. */
  attestationDiffs: FreshLaunchAttestationDiff[];
  /** Productive-worker evidence; independent from launch-config attestation. */
  workerAttestation: FreshLaunchWorkerAttestation;
}

export interface FreshLaunchAttestationDiff {
  field: string;
  requested: string | null;
  actual: string | null;
}

export interface FreshLaunchExpectedAttestation {
  ownerId: string;
  agent: string;
  workspaceId: string;
  harnessSlug: string | null;
  planSlug: string | null;
  model: string | null;
  modelSource: CodexModelSource | null;
  effort: string | null;
  account: string;
  carry: 'warm' | 'cold';
  visibility: 'visible' | 'headless';
  fleetSlug: string | null;
  fleetRole: string | null;
}

/** A recognized reasoning-effort suffix from the exact psu model spec. */
export function modelEffortFromSpec(spec: string | null): string | null {
  if (!spec) return null;
  const colon = spec.lastIndexOf(':');
  if (colon <= 0) return null;
  const suffix = spec.slice(colon + 1).toLowerCase();
  return (MODEL_EFFORT_LEVELS as readonly string[]).includes(suffix) ? suffix : null;
}

/**
 * Canonicalize the model value before comparing a requested launch with the
 * value recorded by psu after bootstrap. Claude appends its private `[1m]`
 * context-window marker to default 1M families, while Codex expands the
 * user-facing `sol`/`terra`/`luna` aliases to explicit GPT-5.6 model ids.
 * Keep the raw values in any reported diff, but compare through the same
 * normalizers the launchers use.
 */
export function normalizeLaunchAttestationModelSpec(
  spec: string | null,
  agent: string | null,
): string | null {
  if (spec == null) return null;
  if (agent === 'claude') return normalizeModelSpec(spec);
  if (agent === 'codex') return resolveCodexModel(spec);
  return spec;
}

/** Resolve the actual launch attestation from the durable adv_sessions ledger. */
export function launchAttestationFromLedger(
  launchSpecRaw: unknown,
  launchArgvRaw: unknown,
): Omit<FreshLaunchExpectedAttestation, 'ownerId'> {
  const spec = launchSpecRaw && typeof launchSpecRaw === 'object'
    ? launchSpecRaw as Record<string, unknown>
    : {};
  const fleet = spec.fleet && typeof spec.fleet === 'object'
    ? spec.fleet as Record<string, unknown>
    : {};
  const argv = Array.isArray(launchArgvRaw)
    ? launchArgvRaw.filter((item): item is string => typeof item === 'string')
    : [];
  const argValue = (name: string): string | null => {
    const prefix = `--${name}=`;
    return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? null;
  };
  const model = typeof spec.model === 'string' ? spec.model : argValue('model');
  const sourceRaw = typeof spec.modelSource === 'string' ? spec.modelSource : argValue('model-source');
  const modelSource = sourceRaw === 'explicit' || sourceRaw === 'inherited' || sourceRaw === 'configured-default'
    ? sourceRaw
    : null;
  return {
    agent: typeof spec.agent === 'string' ? spec.agent : null as never,
    workspaceId: typeof spec.workspaceId === 'string' ? spec.workspaceId : null as never,
    harnessSlug: typeof spec.harnessSlug === 'string' ? spec.harnessSlug : null,
    planSlug: typeof spec.planSlug === 'string' ? spec.planSlug : null,
    model,
    modelSource,
    effort: modelEffortFromSpec(argValue('model') ?? model),
    account: argValue('account') ?? 'default',
    carry: (argValue('carry') as 'warm' | 'cold' | null) ?? null as never,
    visibility: argv.includes('--headless') ? 'headless' : 'visible',
    fleetSlug: typeof fleet.slug === 'string' ? fleet.slug : null,
    fleetRole: typeof fleet.role === 'string' ? fleet.role : null,
  };
}

export interface FreshLaunchVerdict {
  /**
   * THREE-STATE, never a boolean — see D-004. `true` = observed real agent
   * activity. `false` = observed SILENCE (the 14842 shape) and reported loudly.
   * `null` = UNVERIFIED: still beating at the window's edge but no turn yet, which
   * is the HONEST answer for most healthy launches inside any bounded window.
   */
  agentStarted: boolean | null;
  /** Current all-four-stage snapshot; never substitutes for `agentStarted`. */
  workerReady: boolean;
  waitedMs: number;
  sessions: FreshLaunchSessionProbe[];
  /** Operator-facing sentence for the tool's own output. */
  note: string;
}

/** Cohort readiness is exact: every expected member must satisfy all four stages. */
export function freshLaunchWorkerReady(
  sessions: readonly FreshLaunchSessionProbe[],
  expected: number,
): boolean {
  return sessions.length >= expected && sessions.every((session) => session.workerAttestation.ready);
}

export interface FreshLaunchProcessEvidence {
  /** The launcher pid still resolves at verdict time. */
  pidAlive: boolean;
  /** The headless session log advanced during the verification window. */
  logGrowing: boolean;
}

/**
 * Did the agents this call just launched actually START?
 *
 * ⚠ WHY THIS IS NOT THE OBVIOUS "poll ~20s for the adv_sessions row" CHECK. Three
 * things were measured before writing it (D-004), and each killed a simpler design:
 *
 *  1. The ROW is not evidence. 14842 has a row, a coord_owner_id and a session_id,
 *     and never did anything.
 *  2. A coord_presence row is not a 20s signal — observed lag from launch ranged
 *     7s to 7371s, and presence rows are REAPED, so absence is ambiguous BOTH ways.
 *  3. A 20s boolean would be WRONG FOR MOST HEALTHY LAUNCHES: first real tool call
 *     was p50 31s, p90 417s. Returning `false` there would make this a false-alarm
 *     generator, which is itself a defect — the exact failure a verification check
 *     is supposed to prevent, with the sign flipped.
 *
 * So the positive signal is real activity (fast when it happens), and the NEGATIVE
 * signal is SILENCE — the boot beats stopped — which is precisely what distinguishes
 * the dud. Anything else is honestly reported as unverified.
 *
 * `probe` is injectable so this unit-tests without PG.
 */
export async function verifyFreshLaunchStarted(
  {
    workspaceId,
    launcherOwnerId,
    since,
    expected,
    expectedOwnerIds,
    expectedAttestations,
  }: {
    workspaceId: string;
    launcherOwnerId: string;
    since: number;
    expected: number;
    expectedOwnerIds?: string[];
    expectedAttestations?: FreshLaunchExpectedAttestation[];
  },
  {
    timeoutMs = FRESH_VERIFY_TIMEOUT_MS,
    pollMs = 2_000,
    silenceMs = FRESH_VERIFY_SILENCE_MS,
    probe = probeFreshLaunchSessions,
    probeProcessEvidence,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    timeoutMs?: number;
    pollMs?: number;
    silenceMs?: number;
    probe?: typeof probeFreshLaunchSessions;
    /**
     * Headless launches already know their pid + durable log. Consult those
     * signals before turning database silence into a death verdict: a live
     * process whose log is still advancing is visibly inside its first turn,
     * even if it has not made an agent-chosen tool call yet.
     */
    probeProcessEvidence?: () => FreshLaunchProcessEvidence[] | Promise<FreshLaunchProcessEvidence[]>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<FreshLaunchVerdict> {
  const begun = Date.now();
  let sessions: FreshLaunchSessionProbe[] = [];
  for (;;) {
    sessions = await probe({ workspaceId, launcherOwnerId, since, expectedOwnerIds, expectedAttestations });
    if (expectedOwnerIds?.length) {
      const wanted = new Set(expectedOwnerIds);
      sessions = sessions.filter((session) => session.ownerId != null && wanted.has(session.ownerId));
    }
    const mismatched = sessions.filter(
      (session) => session.successfulCalls > 0 && session.attestationDiffs.length > 0,
    );
    if (mismatched.length > 0) {
      const differences = mismatched.flatMap((session) =>
        session.attestationDiffs.map(
          (diff) => `${session.ownerId ?? session.advSessionId}.${diff.field}: requested=${JSON.stringify(diff.requested)} actual=${JSON.stringify(diff.actual)}`,
        ),
      );
      return {
        agentStarted: false,
        workerReady: freshLaunchWorkerReady(sessions, expected),
        waitedMs: Date.now() - begun,
        sessions,
        note: `✗ ATTESTATION MISMATCH — ${differences.join('; ')}. Stop this launch transaction; do not open a later wave.`,
      };
    }
    // A live PsuPtyHost has already observed the backend's usage-limit banner.
    // Presence and launch statuslines are therefore false-positive liveness:
    // the CLI is open, but it is explicitly deferring every turn. Only classify
    // a zero-call session this way — a session that already took a real turn
    // proved this launch started, even if it later became quota-blocked.
    const quotaBlocked = sessions.filter(
      (session) => session.successfulCalls === 0 && session.quotaBlocked === true,
    );
    if (quotaBlocked.length > 0) {
      const blocked = quotaBlocked.map((session) => {
        const id = session.ownerId ?? `adv-session-${session.advSessionId}`;
        return session.quotaBlockedSinceMs == null
          ? id
          : `${id} since ${new Date(session.quotaBlockedSinceMs).toISOString()}`;
      });
      return {
        agentStarted: false,
        workerReady: freshLaunchWorkerReady(sessions, expected),
        waitedMs: Date.now() - begun,
        sessions,
        note:
          `✗ QUOTA BLOCKED — ${quotaBlocked.length} freshly launched session` +
          `${quotaBlocked.length > 1 ? 's are' : ' is'} open, but its PsuPtyHost observed a ` +
          `usage-limit banner before any agent-chosen call. The hosted CLI is deferring every ` +
          `turn, so presence is not productive liveness and this launch must not be reported as ` +
          `started. Blocked: ${blocked.join(', ')}.`,
      };
    }
    // POSITIVE signal — return as soon as it lands, so a healthy launch pays
    // almost nothing and only a suspect one waits out the window.
    if (sessions.length >= expected && sessions.every((s) => s.successfulCalls > 0)) {
      return {
        agentStarted: true,
        workerReady: freshLaunchWorkerReady(sessions, expected),
        waitedMs: Date.now() - begun,
        sessions,
        note: `✓ ${sessions.length} agent${sessions.length > 1 ? 's' : ''} verified running (took a real turn).`,
      };
    }
    if (Date.now() - begun + pollMs > timeoutMs) break;
    await sleep(pollMs);
  }

  const waitedMs = Date.now() - begun;
  const secs = Math.round(waitedMs / 1000);

  if (sessions.length === 0) {
    // EI-20437060078324174: zero sessions at window expiry is NOT observed death —
    // it is the ABSENCE of observation, and the header's own measurement says
    // absence is ambiguous both ways. The measured false-negative registered 5.5s
    // after a 25s window and went straight on to claim work while this branch was
    // asserting "psu died" with three invented causes, sending the reader to debug
    // account/model config that was fine. Per this type's contract, `false` is
    // reserved for OBSERVED silence; an expired window is `null`.
    return {
      agentStarted: null,
      workerReady: false,
      waitedMs,
      sessions,
      note:
        `⏳ launch UNCONFIRMED — no session registered within ${secs}s. That is the verification ` +
        `window expiring, not an observed death: a member seeding a large launch context routinely ` +
        `registers after this window (measured: 30.5s against a 25s window, then went on to claim ` +
        `work — EI-20437060078324174), and a psu that died before reaching the operator looks ` +
        `identical from here. Do NOT relaunch on this note alone. Verify in ~1 min with ` +
        `coord:presence { owner } / work_items:observe; a real dud's terminal is left open on the ` +
        `failure by design.`,
    };
  }

  // NEGATIVE signal: booted, beat, then went silent. This is the 14842 shape.
  const silent = sessions.filter(
    (s) => s.successfulCalls === 0 && !s.hasPresence && s.msSinceLastSignal != null && s.msSinceLastSignal >= silenceMs,
  );
  if (silent.length > 0 && silent.length === sessions.length) {
    const processEvidence = await probeProcessEvidence?.() ?? [];
    const active = processEvidence.filter((item) => item.pidAlive && item.logGrowing);
    if (active.length > 0) {
      return {
        agentStarted: null,
        workerReady: freshLaunchWorkerReady(sessions, expected),
        waitedMs,
        sessions,
        note:
          `⏳ launch UNVERIFIED after ${secs}s — the session ledger went quiet before a first ` +
          `agent-chosen call, but ${active.length} headless process${active.length > 1 ? 'es are' : ' is'} ` +
          `still alive with a growing log. That is positive evidence the agent is still starting, not ` +
          `an observed death. Do NOT relaunch on this note alone; verify in ~1 min with ` +
          `coord:presence { owner } / work_items:observe.`,
      };
    }
    return {
      agentStarted: false,
      workerReady: freshLaunchWorkerReady(sessions, expected),
      waitedMs,
      sessions,
      note:
        `✗ AGENT DID NOT START — ${silent.length} session${silent.length > 1 ? 's' : ''} registered and ` +
        `emitted only the launch statusline calls, then went SILENT (no signal for ` +
        `${Math.round((silent[0].msSinceLastSignal ?? 0) / 1000)}s, no turn taken, no presence). ` +
        `That is a booted CLI that never reached its first turn — the "reports Launched, never ` +
        `actually starts" failure. Do NOT assume it is working: check the terminal window, then ` +
        `relaunch. Sessions: ${silent.map((s) => s.advSessionId).join(', ')}.`,
    };
  }

  // Honest third state. A healthy launch commonly lands here, so it must not read
  // as either success or failure.
  return {
    agentStarted: null,
    workerReady: freshLaunchWorkerReady(sessions, expected),
    waitedMs,
    sessions,
    note:
      `⏳ launch UNVERIFIED after ${secs}s — ${sessions.length} session${sessions.length > 1 ? 's' : ''} ` +
      `registered and ${sessions.length > 1 ? 'are' : 'is'} still signalling, but had not taken a first ` +
      `turn yet. That is NORMAL (first turn is p50 ~31s), not a failure. Confirm with coord:presence ` +
      `in a minute; if it is still idle then, it did not start.`,
  };
}

/**
 * The PG half of {@link verifyFreshLaunchStarted}: which sessions did THIS call
 * launch, and what has each one done?
 *
 * Correlation is `--launched-by=<caller>` in `launch_argv` (the injector puts it
 * on every psu command this door builds) plus `first_seen_at >= since`. That pairs
 * a row to the call that caused it without needing psu to hand an id back.
 */
export async function probeFreshLaunchSessions({
  workspaceId,
  launcherOwnerId,
  since,
  expectedOwnerIds,
  expectedAttestations,
}: {
  workspaceId: string;
  launcherOwnerId: string;
  since: number;
  expectedOwnerIds?: string[];
  expectedAttestations?: FreshLaunchExpectedAttestation[];
}): Promise<FreshLaunchSessionProbe[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: string | number;
        session_id: string | null;
        coord_owner_id: string | null;
        successful_calls: string | number;
        scheduler_calls: string | number;
        successful_scheduler_calls: string | number;
        ms_since_last_signal: string | number | null;
        has_presence: boolean;
        scheduler_disposition: unknown;
        claimed_work_item_id: string | null;
        launch_spec: unknown;
        launch_argv: unknown;
      }>
    >`
      SELECT s.id,
             s.session_id,
             s.coord_owner_id,
             COALESCE((SELECT count(*) FROM harness_shared.tool_invocations t
                        WHERE t.workspace_id = ${workspaceId}
                          AND t.coord_owner_id = s.coord_owner_id
                          AND t.status = 'ok'
                          AND t.call_origin = 'agent'
                          -- Owner IDs survive a same-owner successor launch. Never
                          -- credit the predecessor's calls to this new session.
                          AND t.invoked_at >= GREATEST(s.first_seen_at, to_timestamp(${since / 1000}))
                          AND NOT (t.tool_name = ANY (${LAUNCH_STATUSLINE_TOOLS as string[]}))), 0) AS successful_calls,
             COALESCE((SELECT count(*) FROM harness_shared.tool_invocations t
                        WHERE t.workspace_id = ${workspaceId}
                          AND t.coord_owner_id = s.coord_owner_id
                          AND t.tool_name = 'scheduler:get_next'
                          AND t.call_origin = 'agent'
                          AND t.invoked_at >= GREATEST(s.first_seen_at, to_timestamp(${since / 1000}))), 0) AS scheduler_calls,
             COALESCE((SELECT count(*) FROM harness_shared.tool_invocations t
                        WHERE t.workspace_id = ${workspaceId}
                          AND t.coord_owner_id = s.coord_owner_id
                          AND t.tool_name = 'scheduler:get_next'
                          AND t.call_origin = 'agent'
                          AND t.status = 'ok'
                          AND t.invoked_at >= GREATEST(s.first_seen_at, to_timestamp(${since / 1000}))), 0) AS successful_scheduler_calls,
             (SELECT EXTRACT(EPOCH FROM (now() - max(t.invoked_at))) * 1000
                FROM harness_shared.tool_invocations t
               WHERE t.workspace_id = ${workspaceId}
                 AND t.coord_owner_id = s.coord_owner_id
                 AND t.invoked_at >= GREATEST(s.first_seen_at, to_timestamp(${since / 1000}))) AS ms_since_last_signal,
             EXISTS (SELECT 1 FROM harness_shared.coord_presence p
                      WHERE p.workspace_id = ${workspaceId}
                        AND p.owner_id = s.coord_owner_id) AS has_presence,
             (SELECT t.metadata_json->'schedulerDisposition'
                FROM harness_shared.tool_invocations t
               WHERE t.workspace_id = ${workspaceId}
                 AND t.coord_owner_id = s.coord_owner_id
                 AND t.tool_name = 'scheduler:get_next'
                 AND t.call_origin = 'agent'
                 AND t.invoked_at >= GREATEST(s.first_seen_at, to_timestamp(${since / 1000}))
               ORDER BY t.invoked_at DESC
               LIMIT 1) AS scheduler_disposition,
             (SELECT wi.feature_id
                FROM harness_shared.work_items wi
               WHERE wi.workspace_id = ${workspaceId}
                 AND (
                   wi.taken_by = s.coord_owner_id
                   OR wi.terminal_owner = s.coord_owner_id
                   OR wi.worked_by_history @> jsonb_build_array(
                     jsonb_build_object('owner', s.coord_owner_id)
                   )
                 )
               LIMIT 1) AS claimed_work_item_id,
             s.launch_spec,
             s.launch_argv
        FROM harness_shared.adv_sessions s
       WHERE s.workspace_id = ${workspaceId}
         AND s.first_seen_at >= to_timestamp(${since / 1000})
         AND s.launch_argv::text LIKE ${`%--launched-by=${launcherOwnerId}%`}
       ORDER BY s.first_seen_at ASC
       LIMIT 50`;
    // session_briefs.control_state is a launch-time snapshot, not the live
    // wake contract. It can remain `none` after loop:arm has installed an
    // active loop (the EI-225344 false-pruning incident). Reuse the shared
    // self-wake oracle, which reads the authoritative routines/event_awaits
    // writers, for every owner in this probe cohort. If that oracle fails,
    // propagate the error to the caller's unverified/fail-closed path; never
    // turn an instrumentation failure into `selfWake:'none'` and prune a live
    // worker.
    const ownerIds = [...new Set(
      rows
        .map((row) => row.coord_owner_id)
        .filter((ownerId): ownerId is string => typeof ownerId === 'string' && ownerId.length > 0),
    )];
    const selfWakeByOwner = await fetchSelfWake(ownerIds);
    const wanted = expectedOwnerIds?.length ? new Set(expectedOwnerIds) : null;
    const expectedByOwner = new Map((expectedAttestations ?? []).map((item) => [item.ownerId, item]));
    return rows.filter((r) => !wanted || (r.coord_owner_id != null && wanted.has(r.coord_owner_id))).map((r) => {
      const expected = r.coord_owner_id ? expectedByOwner.get(r.coord_owner_id) : undefined;
      const actual = launchAttestationFromLedger(r.launch_spec, r.launch_argv);
      const attestationDiffs: FreshLaunchAttestationDiff[] = [];
      if (expected) {
        for (const field of [
          'agent', 'workspaceId', 'harnessSlug', 'planSlug', 'model', 'modelSource', 'effort',
          'account', 'carry', 'visibility', 'fleetSlug', 'fleetRole',
        ] as const) {
          const expectedValue =
            field === 'model'
              ? normalizeLaunchAttestationModelSpec(expected[field], expected.agent)
              : expected[field];
          const actualValue =
            field === 'model'
              ? normalizeLaunchAttestationModelSpec(actual[field], actual.agent)
              : actual[field];
          if (expectedValue !== actualValue) {
            attestationDiffs.push({ field, requested: expected[field], actual: actual[field] });
          }
        }
      }
      const successfulCalls = Number(r.successful_calls ?? 0);
      const wakeSource = r.coord_owner_id
        ? selfWakeByOwner.get(r.coord_owner_id)?.selfWake ?? null
        : null;
      const host = r.coord_owner_id ? findLiveHost(r.coord_owner_id) : null;
      const quotaBlocked =
        host && typeof host.quotaBlocked === 'boolean' ? host.quotaBlocked : null;
      const quotaBlockedSinceMs =
        host?.quotaBlockedSinceMs != null && Number.isFinite(Number(host.quotaBlockedSinceMs))
          ? Number(host.quotaBlockedSinceMs)
          : null;
      return {
        advSessionId: Number(r.id),
        sessionId: r.session_id ?? null,
        ownerId: r.coord_owner_id,
        successfulCalls,
        msSinceLastSignal: r.ms_since_last_signal == null ? null : Number(r.ms_since_last_signal),
        hasPresence: Boolean(r.has_presence),
        quotaBlocked,
        quotaBlockedSinceMs,
        attestationDiffs,
        workerAttestation: deriveFreshLaunchWorkerAttestation({
          ownerId: r.coord_owner_id,
          successfulCalls,
          wakeSource,
          schedulerCalls: Number(r.scheduler_calls ?? 0),
          successfulSchedulerCalls: Number(r.successful_scheduler_calls ?? 0),
          schedulerDisposition: r.scheduler_disposition,
          claimedWorkItemId: r.claimed_work_item_id,
        }),
      };
    });
  } catch (e) {
    // ⚠ THROW, never `return []`. An empty list means "nothing registered", which
    // this verifier reads as agentStarted:FALSE — so swallowing a DB fault here
    // would report a perfectly healthy launch as dead, on the strength of an error
    // in our own probe. That is the same manufacture-a-failure defect the whole
    // check exists to prevent. The caller turns a throw into `null` (unverified),
    // which is the only honest verdict when the instrument is broken.
    throw new Error(`fresh-launch probe failed: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Post-resume LIVENESS VERIFICATION (EI-11524): an in-place `psu --resume` can
 * spawn a clean terminal yet leave NO running agent — the transcript was archived
 * off-disk, or `claude --resume` located the wrong projects dir, so it found
 * nothing, started no process, and the window closed seconds later. That silent
 * no-op previously reported SUCCESS: a launch that opens a window but leaves no
 * live agent is the core EI-11524 defect.
 *
 * A resumed session re-attaches its ORIGINAL coord identity, so a live psu-pty
 * host appearing for that `ownerId` is proof the agent actually booted (the host
 * writes its discovery file once the pty is up, and findLiveHost self-validates:
 * pid alive + socket exists + psu-host identity). Absence at a bounded deadline,
 * however, is not proof of a no-op: EI-21476169071856015 recorded a healthy exact
 * Codex resume registering more than seven minutes after this 30s window. Match
 * the fresh-launch verifier's three-state contract: `true` = matching live host,
 * `false` = observed UUID mismatch, `null` = still unconfirmed at the deadline.
 *
 * Returns as SOON as a host appears — most healthy resumes wait only a few
 * seconds. A slow or failed resume pays the full timeout, after which the caller
 * must report the ambiguity without inventing either success or failure.
 * Injectable (findHost / sleep) so it unit-tests without a real host, mirroring
 * injectKickoffAfterResume. (A FORK mints a fresh identity we cannot poll by a
 * known ownerId, so verification is scoped to an in-place resume.)
 */
export async function verifyResumeStarted(
  ownerId: string,
  {
    expectedSessionId,
    timeoutMs = 30_000,
    pollMs = 1_000,
    findHost = findLiveHost,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    /** Exact native transcript UUID the new backend process must carry. */
    expectedSessionId?: string | null;
    timeoutMs?: number;
    pollMs?: number;
    findHost?: typeof findLiveHost;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{
  started: boolean | null;
  waitedMs: number;
  expectedSessionId: string | null;
  actualSessionId: string | null;
  mismatch: boolean;
}> {
  const begun = Date.now();
  for (;;) {
    const host = findHost(ownerId);
    if (host) {
      const expected = expectedSessionId?.trim() || null;
      const actual = nativeSessionIdFromHost(host);
      const mismatch = expected != null && actual !== expected;
      return {
        started: !mismatch,
        waitedMs: Date.now() - begun,
        expectedSessionId: expected,
        actualSessionId: actual,
        mismatch,
      };
    }
    if (Date.now() - begun + pollMs > timeoutMs) {
      return {
        started: null,
        waitedMs: Date.now() - begun,
        expectedSessionId: expectedSessionId?.trim() || null,
        actualSessionId: null,
        mismatch: false,
      };
    }
    await sleep(pollMs);
  }
}

/**
 * Extract the native transcript UUID from a live backend argv.
 *
 * Codex spells this `codex … resume <uuid>`; Claude/OMP use `--resume <uuid>`,
 * `--resume=<uuid>`, or `--resume-session=<uuid>`. Unknown/missing argv is null,
 * never treated as an implicit match.
 */
export function nativeSessionIdFromHost(
  host: Pick<PsuPtyHost, 'command' | 'args'> | null | undefined,
): string | null {
  const args = Array.isArray(host?.args) ? host.args.filter((v): v is string => typeof v === 'string') : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const flag of ['--resume=', '--resume-session=']) {
      if (arg.startsWith(flag) && arg.length > flag.length) return arg.slice(flag.length);
    }
    if ((arg === '--resume' || arg === '--resume-session') && args[i + 1]) return args[i + 1];
    if (arg === 'resume' && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  }
  return null;
}

export type RestoreVisibleWindowVerdict = 'alive' | 'dead' | 'unknown' | 'not-a-window';

/**
 * The destructive half of visible restoration is permitted only on a positive
 * DEAD-window witness. Unknown/not-a-window are not synonyms for dead, and an
 * alive window is the exact owner-visible session this guard exists to protect.
 */
export function restoreVisibleMayShutdown(verdict: RestoreVisibleWindowVerdict): boolean {
  return verdict === 'dead';
}

/** Wait until the old managed host has actually disappeared before exact-resume. */
export async function waitForPtyHostGone(
  ownerId: string,
  {
    timeoutMs = 10_000,
    pollMs = 100,
    findHost = findLiveHost,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    timeoutMs?: number;
    pollMs?: number;
    findHost?: typeof findLiveHost;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const begun = Date.now();
  for (;;) {
    if (!findHost(ownerId)) return true;
    if (Date.now() - begun + pollMs > timeoutMs) return false;
    await sleep(pollMs);
  }
}
