import { OUTER_ACTIVITY_ECHO_MARKER } from '@papercusp/orchestrator';

/**
 * invoke-outcome — the ONE rule for "did a spawned agent actually run a turn?"
 *
 * HTTP 200 from the /invoke route does NOT mean the agent ran. The fire holds the
 * connection for the whole run, so a launcher timeout, host interruption, or an
 * upstream gateway failure can return an ok-shaped response while the agent never
 * emitted a turn
 * (the ~3s/0-token wakes that were recorded `done` → silent placement/scorecard/
 * doc-heal stalls). Both spawn-fire paths must judge a fire the SAME way:
 *   - durable-spawn (dbos/durable-spawn.ts) — the orchestrator/queen/bee/worker path.
 *   - launch-blueprint (blueprint/launch-blueprint.ts) — event/cadence launches incl.
 *     the doc-steward, which previously recorded HTTP-200-no-turn as `done` (the
 *     silent-swallow that left drifted docs un-healed; docs-audit 2026-06-23 #1).
 *
 * Rule: inspect the invoke-result body ({ ok, agentOutput|stdout, exitCode, timedOut }).
 * The agent RAN iff `ok === true` AND the output is non-empty (blueprint roles ALWAYS
 * emit a decision line, so empty ⇒ no turn). An unparseable / non-result body ⇒ assume
 * it ran (the old `done` behavior) — NEVER flip a spawn to failed on uncertainty (this
 * is the most load-bearing path; a false `failed` would re-fire/alarm needlessly).
 */

/**
 * How a no-turn death is classified — drives the persisted error prefix AND the retry
 * policy (spawn-classification audit P-006/H13):
 *   - 'capacity_shed' — a CLEAN mid-turn exit-1 (empty stderr, no timeout) that
 *     COINCIDED with a wholesale-throttled gateway (the all-accounts 429 storm / no
 *     fresh account). A transient CAPACITY event → RETRYABLE, NOT a host bug. This is
 *     the GENUINE all-accounts throttle that never surfaces as a 429
 *     (agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5).
 *   - 'auth_error' — the child reached an LLM endpoint but credentials were rejected
 *     (invalid API key / 401). Terminal until account routing/config is fixed.
 *   - 'usage_limit' — the child reached a native account/session quota wall. Terminal
 *     for that account; routing should pick another usable account when available.
 *   - 'context_overflow' — the agent's PROMPT exceeded the model context window before it
 *     could produce a turn ("Prompt is too long" / context-length-exceeded). A
 *     LAUNCH-CONFIG / prompt-size bug (e.g. an unscoped MCP toolset on a small-context
 *     model — the B1 overwatch death), NOT a 429 / gateway stall / host loss. Terminal
 *     until the launch tool-scoping or prompt size is fixed; retrying or chasing gateway
 *     capacity will NOT help. Detected BEFORE the infra_loss fallthrough so it is never
 *     misattributed to a "gateway stall/429 storm" (B3 / autonomous-loop-hardening F1).
 *   - 'infra_loss' — a genuine launcher-host death / no-turn 0-token wake → terminal.
 *     The conservative default — chosen whenever the capacity-shed signals don't BOTH
 *     hold (never relabel on uncertainty).
 */
export type SpawnFailureClass =
  | 'infra_loss'
  | 'capacity_shed'
  | 'auth_error'
  | 'usage_limit'
  | 'context_overflow';

export interface InvokeOutcome {
  /** True iff the agent completed at least one turn (or the body is unreadable/
   *  non-result-shaped → assume ran, preserving the legacy `done`). */
  ran: boolean;
  /** When ran=false, a self-diagnosing detail for the persisted error_message +
   *  watchdog signal. Empty when ran=true. */
  detail: string;
  /** When ran=false, how the death is classified (see SpawnFailureClass). Undefined
   *  when ran=true. The caller prefixes the persisted error with this (`capacity_shed:`
   *  vs `infra_loss:`) and, for capacity_shed, RETRIES the fire instead of recording a
   *  terminal phantom host death. */
  failureClass?: SpawnFailureClass;
}

const RAW_STDOUT_DETAIL_LIMIT = 1000;

/**
 * EI-16502: strip the outer-process activity-heartbeat marker (invoke.ts
 * `echoActivityToOuterProcess`) out of a captured stderr/rawStdoutTail before
 * it is judged or persisted. That marker is echoed to the OUTER process's own
 * stderr purely to keep `last_output_at` fresh (WI-3302) — it carries no
 * diagnostic content. Left in, a burst-failed spawn whose child produced no
 * *other* output ends up with `stderr`/`rawStdoutTail` consisting ENTIRELY of
 * repeated marker lines: `classifyDiagnosticFailure` sees only noise (no real
 * cause is ever visible — the persisted error_message and the failed-spawn
 * watchdog signal fall through to a meaningless generic bucket), and — worse —
 * the capacity_shed fingerprint's `stderr === ''` check silently never fires
 * (a genuine mid-turn gateway-throttle shed misclassifies as the terminal
 * `infra_loss` instead of the retryable `capacity_shed`). Stripping restores
 * both: a real diagnostic elsewhere in the text is no longer crowded out, and
 * a truly-silent death reads as truly empty again.
 */
export function stripActivityHeartbeat(text: string): string {
  if (!text || !text.includes(OUTER_ACTIVITY_ECHO_MARKER)) return text;
  return text.split(OUTER_ACTIVITY_ECHO_MARKER).join('').trim();
}

function rawStdoutDetail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = stripActivityHeartbeat(value.trim());
  if (!trimmed) return '';
  const compact = trimmed.replace(/\s+/g, ' ');
  const tail =
    compact.length > RAW_STDOUT_DETAIL_LIMIT
      ? `${compact.slice(-RAW_STDOUT_DETAIL_LIMIT)} [rawStdoutTail truncated: ${compact.length} chars]`
      : compact;
  return `; rawStdoutTail=${JSON.stringify(tail)}`;
}

function diagnosticText(b: {
  agentOutput?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  rawStdoutTail?: unknown;
}): string {
  return [b.stderr, b.rawStdoutTail, b.agentOutput, b.stdout]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => stripActivityHeartbeat(v))
    .filter((v) => v.length > 0)
    .join('\n');
}

function classifyDiagnosticFailure(text: string): { failureClass: SpawnFailureClass; detail: string } | null {
  if (!text.trim()) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  const bounded = compact.slice(-RAW_STDOUT_DETAIL_LIMIT);
  // context_overflow FINGERPRINT — the prompt exceeded the model context window before a
  // turn could run ("Prompt is too long" / context-length-exceeded). Checked FIRST so an
  // unscoped-toolset / oversized-prompt death (B1 overwatch) is never misread as a
  // gateway stall / 429 storm (B3 / autonomous-loop-hardening F1). This is a LAUNCH-CONFIG
  // bug: fix the tool-scoping or prompt size — retrying or hunting gateway capacity won't help.
  if (
    /prompt is too long/i.test(compact) ||
    /input (?:length )?is too long/i.test(compact) ||
    /\bcontext[_ -]?length[_ -]?exceeded\b/i.test(compact) ||
    /maximum context length/i.test(compact) ||
    /input length and `?max_tokens`? exceed/i.test(compact) ||
    /exceeds? the (?:model'?s )?maximum (?:context|(?:number of )?(?:input )?tokens)/i.test(compact) ||
    /reduce the length of (?:the )?(?:messages|prompt|input)/i.test(compact)
  ) {
    return {
      failureClass: 'context_overflow',
      detail: ` the agent's prompt EXCEEDED the model context window before it produced a turn (context_overflow — a LAUNCH-CONFIG / prompt-size bug, NOT a 429 / gateway stall / host loss: the spawn loaded too many tokens, e.g. an unscoped MCP toolset on a small-context model. Fix the launch tool-scoping or prompt size; retrying or hunting gateway capacity / a host fault will NOT help): ${JSON.stringify(
        bounded,
      )}`,
    };
  }
  if (
    /\b(?:invalid[_ -]?api[_ -]?key|incorrect api key|unauthorized|auth(?:entication)? error|401)\b/i.test(compact) ||
    /\bauth error code:\s*invalid_api_key\b/i.test(compact)
  ) {
    return {
      failureClass: 'auth_error',
      detail: ` LLM credentials were rejected before the agent produced a turn (auth_error — fix account routing/config, not the launcher host): ${JSON.stringify(
        bounded,
      )}`,
    };
  }
  if (
    /(you(?:'|’)ve hit your usage limit|hit your (?:session|usage|weekly|monthly|daily) limit|session limit|weekly limit|monthly limit|daily limit|insufficient_quota|quota exceeded|exceeded your (?:current )?quota|out of (?:credits|quota))/i.test(
      compact,
    ) &&
    !/temporarily limiting requests \(not your usage limit\)/i.test(compact)
  ) {
    return {
      failureClass: 'usage_limit',
      detail: ` LLM account/session quota stopped the agent before it produced a turn (usage_limit — route to a different healthy account or wait for the named reset): ${JSON.stringify(
        bounded,
      )}`,
    };
  }
  return null;
}

/**
 * Judge an /invoke response body. `label` (e.g. `<slug>/<role>`) is woven into the
 * detail so the persisted failure names which spawn died.
 *
 * `opts.gatewayThrottled` is the live corroboration that distinguishes a capacity-shed
 * (the gateway pool was wholesale-throttled at death) from a host loss. The caller
 * supplies it (best-effort, e.g. observability.gatewayWholesaleThrottled()); the
 * function stays PURE so it is unit-testable without a live gateway. When omitted the
 * death classifies `infra_loss` — the conservative legacy label.
 */
export function agentProducedTurn(
  bodyText: string,
  label = '',
  opts: { gatewayThrottled?: boolean } = {},
): InvokeOutcome {
  // Unreadable body ⇒ assume done (legacy behavior; never flip on uncertainty).
  if (!bodyText) return { ran: true, detail: '' };
  let b: {
    ok?: unknown;
    agentOutput?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
    timedOut?: unknown;
    firstTurnTimedOut?: unknown;
    rawStdoutTail?: unknown;
  };
  try {
    b = JSON.parse(bodyText);
  } catch {
    return { ran: true, detail: '' }; // unparseable ⇒ assume done
  }
  // Only judge when the body carries the invoke-result shape (a boolean `ok`).
  if (typeof b.ok !== 'boolean') return { ran: true, detail: '' };
  const out =
    typeof b.agentOutput === 'string'
      ? b.agentOutput
      : typeof b.stdout === 'string'
        ? b.stdout
        : '';
  if (b.ok === true && out.trim().length > 0) return { ran: true, detail: '' };

  // ── ran=false: classify the death. ───────────────────────────────────────────
  const diagnosticFailure = classifyDiagnosticFailure(diagnosticText(b));
  if (diagnosticFailure) {
    return {
      ran: false,
      failureClass: diagnosticFailure.failureClass,
      detail: ` ${label}${diagnosticFailure.detail}${rawStdoutDetail(b.rawStdoutTail)}`,
    };
  }

  // Capacity-shed FINGERPRINT: a CLEAN mid-turn process exit — exit code exactly 1,
  // no timeout, and EMPTY stderr. A real host loss / crash / OOM leaves a stderr trail
  // or a null/signal exit code; a capacity shed (the agent's 2nd gateway call hit the
  // all-accounts storm and the process exited 1 with nothing on stderr) does not.
  // BOTH the body fingerprint AND the live gateway-throttled corroboration are required
  // — never relabel on one signal alone (the never-flip-on-uncertainty contract).
  const exitCode = typeof b.exitCode === 'number' ? b.exitCode : null;
  const stderr = stripActivityHeartbeat(typeof b.stderr === 'string' ? b.stderr : '');
  const midTurnCleanExit = exitCode === 1 && b.timedOut !== true && stderr.trim().length === 0;
  if (midTurnCleanExit && opts.gatewayThrottled === true) {
    return {
      ran: false,
      failureClass: 'capacity_shed',
      detail: ` ${label} was SHED mid-turn by an all-accounts gateway throttle (capacity_shed — RETRYABLE, NOT a host fault): exit 1, empty stderr, timedOut=false, and the gateway pool was wholesale-throttled (paused/rejected) at death — the GENUINE all-accounts 429 storm that never surfaces as a 429 (agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5). Retry through the paced gateway when capacity returns; do NOT hunt a host bug.`,
    };
  }
  if (b.timedOut === true && b.firstTurnTimedOut === true) {
    return {
      ran: false,
      failureClass: 'infra_loss',
      detail: ` ${label} timed out before producing a turn (the bounded first-turn silence guard fired before the full invoke deadline${rawStdoutDetail(
        b.rawStdoutTail,
      )}) — the launch was non-progressing; inspect launcher termination, account/gateway telemetry, and the spawn record before attributing the cause; recorded failed, not done`,
    };
  }
  if (b.timedOut === true) {
    return {
      ran: false,
      failureClass: 'infra_loss',
      detail: ` ${label} timed out before producing a turn (ok=${String(b.ok)}, exitCode=${String(
        b.exitCode,
      )}, timedOut=true, outLen=${out.trim().length}${rawStdoutDetail(
        b.rawStdoutTail,
      )}) — the invoke timeout expired before the agent emitted a turn; the cause is not established by this response. Inspect the launcher termination record together with account/gateway telemetry and the spawn record before attributing the failure; recorded failed, not done`,
    };
  }

  return {
    ran: false,
    failureClass: 'infra_loss',
    detail: ` ${label} returned HTTP 200 but the agent produced no turn (ok=${String(b.ok)}, exitCode=${String(
      b.exitCode,
    )}, timedOut=${String(b.timedOut)}, outLen=${out.trim().length}${rawStdoutDetail(
      b.rawStdoutTail,
    )}) — the no-turn cause is unresolved by this response; inspect launcher liveness, account/gateway telemetry, and the spawn record before attributing it; recorded failed, not done`,
  };
}
