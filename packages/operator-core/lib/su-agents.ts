/**
 * su-agents.ts — the three Papercusp superuser CLI agents (claude / omp /
 * codex).
 *
 * As of psu-only-launch-unification (P-041) the `*-su` wrappers are retired:
 * `psu` → `bootstrap-su` → `buildLaunchSpec({kind:'su'})` assembles the
 * playbook + MCP + flags per-launch and execs the RAW CLI (see
 * `suLaunchArgs`/`resumeArgsFor` in psu-launcher.mjs). The old
 * `SU_WRAPPER_BIN` map (claude-su / omp-su / codex-su) is gone — nothing
 * execs a wrapper anymore.
 */

export type SuAgent = 'claude' | 'omp' | 'codex';

export const SU_AGENTS: readonly SuAgent[] = ['claude', 'omp', 'codex'];

export function isSuAgent(x: unknown): x is SuAgent {
  return x === 'claude' || x === 'omp' || x === 'codex';
}

/** Effective/public launch context. The trimmed seed remains fully growable via
 * tools:find/tools:invoke; `full` exists only as a legacy decoder input.
 * `steward` (WI-2140338) is the explicit opt-in intermediate seed — core spine
 * + steward verb families — for goal-holder/steward sessions; never a default,
 * never auto-selected, and deliberately NOT a picker row (the picker vocabulary
 * in agent-config-constants.ts stays trimmed-only on purpose). */
export type SuContextSize = 'trimmed' | 'steward';
export type LegacySuContextSize = 'full' | SuContextSize;

export const SU_CONTEXT_SIZES: readonly SuContextSize[] = ['trimmed', 'steward'];

export function isSuContextSize(x: unknown): x is SuContextSize {
  return x === 'trimmed' || x === 'steward';
}

export { SU_CONTEXT_SIZE, LEGACY_SU_CONTEXT_SIZE, normalizeSuContextSize } from './su-context-size.mjs';
