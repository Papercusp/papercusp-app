/**
 * Baseline B — native-harness runner CONFIG + task prompt (P-007 / BRIEF 5,
 * plan `impartial-benchmark-suite-2026-06-15`).
 *
 * Baseline B is the HEADLINE baseline (D-002): the SAME model the Papercusp arm
 * runs, embedded in the PROVIDER'S OWN native harness (Claude Code), graded by
 * the SAME official grader. It is strawman-proof — beating the provider's shipped
 * agent is what a buyer cares about and is immune to "you nerfed the baseline".
 *
 * The config below encodes the METR elicitation discipline: run Claude Code at
 * its RECOMMENDED best — full built-in tools (NO tool deny-list), headless
 * autonomy (`bypassPermissions`), its NATIVE sampling (we deliberately do NOT
 * pass temperature/maxTokens — the claude-code backend ignores them, and forcing
 * them would be a non-native setup), and retries on transient/infra failures so
 * a spurious rate-limit is never scored as a task failure. Never a weaker setup
 * than we'd give ourselves.
 *
 * The ONLY variable held constant against the Papercusp arm is the model id
 * ({@link NativeHarnessConfig.model}); the harness (Claude Code vs the Papercusp
 * spine) is the independent variable under test (D-004).
 */
import type { BenchTask } from './types';

/** Baseline B's arm id on the run-result row — the LOCKED vocab (P-011/P-010 schema, su-66ad9). */
export const BASELINE_B_ARM = 'baseline-b-native';

/**
 * `blueprintId` stamped on the {@link import('./types').ArmAttempt} row. There is NO Papercusp
 * blueprint for this arm — it is the provider's native harness — so this documents the harness
 * rather than naming a spine. (Papercusp arm = 'external-bench'; Baseline A = 'coding-solo'.)
 */
export const NATIVE_BLUEPRINT_ID = 'native-claude-code';

/** The elicited-to-best knobs for the native Claude Code harness. */
export interface NativeHarnessConfig {
  /**
   * Exact model id, HELD CONSTANT across every arm (the controlled variable).
   * Defaults to the current Opus; the pilot pins whatever the Papercusp arm uses.
   */
  model: string;
  /** Headless autonomy — no permission prompts. Required for an unattended benchmark run. */
  permissionMode: 'bypassPermissions';
  /**
   * Isolate the spawn from the dev box's `~/.claude` (no host MCP servers / hooks / plugins /
   * skills): the baseline must be VANILLA Claude Code, not "Claude Code + this developer's
   * papercusp-su + coord tools", or it would no longer be the provider's shipped agent.
   */
  isolateConfig: boolean;
  /**
   * METR: retry a transient/infra failure (rate-limit / overload) up to N times. A genuine task
   * failure (the agent finished but produced no/insufficient diff) is NOT retried — that is a real
   * miss the grader should see. Only `turn.retryable` failures count against this budget.
   */
  maxRetries: number;
  /** Base backoff (ms) between retries when the failure carries no `retryAfterMs`. Grows linearly. */
  retryBackoffMs: number;
  /** Cap (ms) on a honored `retryAfterMs` so a long usage-reset window can't stall the whole pilot. */
  maxRetryWaitMs: number;
}

export const DEFAULT_NATIVE_HARNESS_CONFIG: NativeHarnessConfig = {
  model: 'claude-opus-4-8',
  permissionMode: 'bypassPermissions',
  isolateConfig: true,
  maxRetries: 2,
  retryBackoffMs: 2_000,
  maxRetryWaitMs: 60_000,
};

/**
 * Build the user turn fed to the native harness for an M1 (diff-batch) task.
 *
 * Deliberately a MINIMAL, natural SWE-bench-style instruction — not a bespoke scaffold. The
 * feasibility doc (D-008) warns that a generic minimal scaffold (mini-SWE-agent style) UNDERSTATES
 * a model that was tuned for its native harness; so we hand Claude Code only the issue + the
 * grading contract and let its own agent loop drive (its tools, its planning), which is exactly how
 * a real user would run it. We never feed `task.graderMeta` (hidden tests / FAIL_TO_PASS) — that
 * would be gaming the grader; the arm sees only the problem statement + repo it is checked out in.
 */
export function buildNativeHarnessPrompt(task: BenchTask): string {
  return [
    'You are working at the root of a software repository, checked out at a specific commit.',
    'Resolve the following issue by editing the repository source directly with your tools.',
    '',
    '<issue>',
    task.problemStatement.trim(),
    '</issue>',
    '',
    'Guidance:',
    '- Make the minimal, correct source changes that resolve the issue.',
    '- Your changes will be evaluated by an automated, hidden test suite — do not try to discover or',
    '  edit those tests; any test files you add or change are ignored when your work is graded.',
    '- Work to completion autonomously; when you believe the issue is fully resolved, stop.',
  ].join('\n');
}
