/**
 * Resume-turn outcome — observe + classify the EXIT of a detached headless resume
 * turn (loop-wake-rate-limit-robustness-2026-06-23 P0a).
 *
 * THE GAP THIS CLOSES (agent-insights/loop-wake-turn-deaths-recorded-as-delivered):
 * `executeWake`'s `resume-headless` channel runs `claude --resume <uuid> -p` DETACHED
 * with `stdio:'ignore'` and returns `{ kind:'delivered' }` the instant a PID is
 * assigned — on SPAWN success, not TURN success. A turn that 429s seconds-to-minutes
 * later dies into `/dev/null`: the in-process RateLimitGovernor never sees it (the
 * subprocess draws from Claude Code's OWN CLI transport bucket), and for a LOOP wake
 * the failure-streak circuit never opens, so the loop keeps firing empty wakes into a
 * rate-limited void. This module is the PURE half: given the eventual exit (code +
 * signal + bounded output tails captured by wake-executor), classify it into
 * survived-vs-died, reusing the shared turn-error taxonomy — NO ad-hoc 429 matching.
 *
 * The IMPURE halves live elsewhere (the layering keeps this file pure + unit-testable):
 *  - wake-executor.ts captures the tails + fires `onResumeTurnExit(d, raw)` on close.
 *  - harness/routines/loop-turn-outcome.ts is the registered handler that classifies
 *    a LOOP-sourced death via this function and feeds the autoloop circuit + 429-aware
 *    re-arm (P0b/P1a).
 */

import {
  classifySubprocessResult,
  parseUsageReset,
  type TurnError,
  type TurnProvider,
} from '@papercusp/papercusp-shared/agent';
import { classifyWedgeText } from '../../search/session-end-reason';
import { missingClaudeToolReferenceEvidence } from '../../claude-resume-tool-references.mjs';

/**
 * The raw exit observation of a detached `resume-headless` turn — the exit code +
 * signal + the BOUNDED stdout/stderr tails wake-executor captured from the subprocess.
 * Forwarded verbatim to `onResumeTurnExit`; classified by `classifyResumeTurnExit`.
 */
export interface ResumeTurnExitRaw {
  /** The subprocess exit code (null when killed by a signal). */
  exitCode: number | null;
  /** The killing signal name (null when it exited normally). */
  signal: NodeJS.Signals | string | null;
  /** The last N bytes of stdout (the CLIs print API errors — incl. 429 — to STDOUT). */
  stdoutTail: string;
  /** The last N bytes of stderr. */
  stderrTail: string;
  /**
   * Machine-readable stdout contract requested by the launcher. Codex resume
   * turns use JSONL so an exit-0 process is not trusted unless it emitted the
   * terminal `turn.completed` event.
   */
  outputProtocol?: 'codex-jsonl';
}

/** Identity and transcript evidence for the detached resume that just exited. */
export interface ResumeTurnContext {
  advSessionId: number;
  ownerId: string | null;
  sessionId: string | null;
  startedAt: string | null;
  workspaceId: string | null;
  agent: string | null;
  transcriptPath: string | null;
  /** Set by the executor when the transcript detector quarantined this incarnation. */
  poisoned?: boolean;
  poisonReason?: string;
}

/** Survived (the turn ran to completion) vs died (with the classified failure). */
export type ResumeTurnOutcome = { ok: true } | { ok: false; error: TurnError };

/**
 * A resume can be launched successfully and still point at a session that has already
 * been reaped (or whose transcript was never archived). The CLIs report that as
 * `Session "<id>" not found` (claude/omp), `No conversation found with session ID: <id>`
 * (claude -r — word order reversed, "found" precedes "session", so the first alternation
 * cannot match it; EI-21306279681556443: this shape re-armed as a retryable agent_crash
 * and only alerted via the chronic-backoff floor), `codex_rollout::list: state db returned
 * stale rollout path for thread <id>` (codex, rollout row present but file gone), or
 * `thread/resume failed: no rollout found for thread id <id>` (codex -32600, rollout
 * row itself gone — EI-21264970189305370: this shape re-armed as a retryable
 * agent_crash for 7 consecutive fires before the loop gave up). Retrying the same
 * native id can never recover any of them.
 * Keep this narrow so ordinary agent errors remain retryable crashes.
 */
const STALE_RESUME_TARGET_RE =
  /\bsession\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s+not found\b|\bno conversation found with session id\b|\bcodex_rollout::list:\s+state db returned stale rollout path for thread\b|\bno rollout found for thread\b/i;

export function isStaleResumeTargetMessage(message: string): boolean {
  return STALE_RESUME_TARGET_RE.test(message);
}

export function isStaleResumeTargetError(outcome: ResumeTurnOutcome): boolean {
  return !outcome.ok && outcome.error.class === 'permanent' && isStaleResumeTargetMessage(outcome.error.message);
}

function missingToolReferenceEvidence(stderr: string, stdout: string): string | null {
  for (const stream of [stderr, stdout]) {
    const evidence = missingClaudeToolReferenceEvidence(stream);
    if (evidence) return evidence;
  }
  return null;
}

export function isUnavailableToolReferenceError(outcome: ResumeTurnOutcome): boolean {
  return !outcome.ok && outcome.error.class === 'permanent' &&
    missingClaudeToolReferenceEvidence(outcome.error.message) !== null;
}

/**
 * Resume-only normalization: a missing native session is a permanent target failure, not
 * a retryable subprocess crash. The loop turn-outcome handler uses this distinction to
 * pause the owning loop instead of re-arming an impossible `--resume` forever.
 */
function classifyResumeSubprocessResult(
  input: Parameters<typeof classifySubprocessResult>[0],
  provider: TurnProvider,
  now: number,
): TurnError {
  const error = classifySubprocessResult(input, provider, now);
  if (!isStaleResumeTargetMessage(error.message)) return error;
  return { ...error, class: 'permanent', retryable: false, surfaceToUser: true };
}

/** Return the latest complete Codex terminal event from a bounded JSONL tail.
 * The first line may be partial because the collector keeps only the last N
 * bytes, so malformed/non-object lines are deliberately skipped. */
function latestCodexTerminalEvent(stdoutTail: string): 'turn.completed' | 'turn.failed' | null {
  const lines = stdoutTail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown };
      if (event.type === 'turn.completed' || event.type === 'turn.failed') return event.type;
    } catch {
      // A bounded tail can begin mid-event; later complete lines remain valid.
    }
  }
  return null;
}

/**
 * Classify a detached resume turn's exit into survived-vs-died (P0a).
 *
 * A clean exit (code 0, no signal) is USUALLY success — the `claude --resume … -p` turn
 * ran its one turn and exited, leaving the session updated for the next wake. We do NOT
 * route a clean exit through `classifySubprocessResult`: that helper reads
 * exit-0-with-no-captured-stdout as `empty_output` (a failure), but here we capture only
 * a bounded tail (not the transcript), so an EMPTY tail on a clean exit must be read as
 * success regardless.
 *
 * EI-13818: but a clean exit is NOT ALWAYS success. The claude-code CLI prints a provider
 * WEDGE — "You've hit your session limit · resets 5:40am", "…organization has disabled
 * Claude subscription access…" — as an ordinary ASSISTANT TURN and exits 0 once it has
 * displayed it: from the process's own perspective it ran cleanly. That is indistinguishable
 * from a normal turn to every exit-code-based check (the exact blind spot
 * `session-end-reason.ts` exists to close for LIVE-session classification: "the only way to
 * learn a session is WEDGED is to read its transcript"). Left unguarded this masked FOUR
 * consecutive dead loop wakes as `ok:true` (2 turns / 1 prompt / 0 tool calls each) — the
 * failure-streak circuit never opened, the 429-aware re-arm (P1a, below) never engaged, and a
 * 12-member fleet ran leaderless. So a clean exit is FIRST scanned for the same narrow,
 * high-precision wedge signature via `classifyWedgeText` (deliberately NOT the full
 * `classifySessionEnd` set — see its doc for why `model_error`/`context_limit` are excluded
 * from a BLIND scan) before being trusted as success.
 *
 * A non-zero / signalled exit is a DEATH — classify it with the shared subprocess
 * taxonomy. The claude/codex CLIs print API errors (rate limit / usage limit / overload
 * / auth) to STDOUT (not stderr — see turn-error.ts), so both tails are passed and the
 * classifier folds stdout into its scan on a failed exit. Legacy/Claude resumes
 * classify against `anthropic`; Codex JSONL resumes classify against `openai`.
 */
export function classifyResumeTurnExit(raw: ResumeTurnExitRaw, now: number = Date.now()): ResumeTurnOutcome {
  const provider = raw.outputProtocol === 'codex-jsonl' ? 'openai' : 'anthropic';
  const missingToolReference = missingToolReferenceEvidence(raw.stderrTail, raw.stdoutTail);
  if (missingToolReference) {
    // A resumed transcript can replay a tool_reference absent from the relaunched
    // client's surface. The provider rejects that request permanently, even if the
    // CLI exits cleanly; reusing the saved transcript cannot make the tool available.
    const classified = classifySubprocessResult(
      { exitCode: 1, signal: raw.signal ?? null, stderr: raw.stderrTail, stdout: raw.stdoutTail },
      provider,
      now,
    );
    if (classified.class === 'agent_crash') {
      return {
        ok: false,
        error: {
          ...classified,
          class: 'permanent',
          message: missingToolReference,
          retryable: false,
          surfaceToUser: true,
        },
      };
    }
  }
  if (raw.exitCode === 0 && !raw.signal) {
    if (raw.outputProtocol === 'codex-jsonl') {
      const terminal = latestCodexTerminalEvent(raw.stdoutTail);
      if (terminal !== 'turn.completed') {
        if (terminal === 'turn.failed') {
          const error = classifyResumeSubprocessResult(
            {
              // Codex may report a protocol-level failure even when its wrapper
              // exits zero. Force the failed-exit taxonomy so its JSONL error
              // text is classified (rate limit/auth/etc.) rather than trusted.
              exitCode: 1,
              signal: null,
              stderr: raw.stderrTail,
              stdout: raw.stdoutTail,
            },
            provider,
            now,
          );
          return { ok: false, error };
        }
        return {
          ok: false,
          error: {
            class: 'malformed_output',
            message: 'Codex resume exited 0 without the required turn.completed JSONL event',
            provider,
            retryable: true,
            surfaceToUser: false,
          },
        };
      }
    }
    const wedge = classifyWedgeText(raw.stdoutTail);
    if (wedge) {
      const reset = wedge.reason === 'usage_limit' ? parseUsageReset(wedge.evidence, now) : undefined;
      const error: TurnError = {
        class: wedge.reason === 'auth_wall' ? 'auth' : 'usage_limit',
        message: wedge.evidence,
        provider,
        retryable: false,
        surfaceToUser: true,
        // `resetPrecision` must travel with `resetAt` on this hand-built error, not just on the
        // classifier-built ones: this is the resume-headless channel that feeds
        // `computeDeathRearmMs`, so dropping it here would silently deny the long re-arm ceiling
        // to the exact path a walled loop dies on (EI-20544023385610622).
        ...(reset !== undefined ? { resetAt: reset.atMs, resetPrecision: reset.precision } : {}),
      };
      return { ok: false, error };
    }
    return { ok: true };
  }
  const error = classifyResumeSubprocessResult(
    {
      exitCode: raw.exitCode,
      signal: raw.signal ?? null,
      stderr: raw.stderrTail,
      stdout: raw.stdoutTail,
    },
    provider,
    now,
  );
  return { ok: false, error };
}

/** Is this a transient rate-limit / plan-cap death — the class that warrants a
 *  retry-after-aware loop re-arm (P1a) rather than the blind interval? */
export function isRateLimitDeath(outcome: ResumeTurnOutcome): boolean {
  return !outcome.ok && (outcome.error.class === 'rate_limited' || outcome.error.class === 'usage_limit');
}
