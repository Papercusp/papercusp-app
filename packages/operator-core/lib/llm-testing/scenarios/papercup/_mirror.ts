/**
 * Mirror an operator behavioral contract onto the `sentinel` target.
 *
 * Sentinel-as-Herald is the SAME role-keyed converse brain as the operator
 * (the agent-mcp/operator-converse route resolves `${role}:converse`), so the
 * Sentinel front-door must uphold the same chat hygiene the operator suite
 * already pins: voice terseness, ≤1 question/turn, speakable (no-markdown/
 * no-code) formatting, ask-choice cards. Rather than copy-paste those scenarios
 * (and risk the two brains drifting), we run each borrowed contract against
 * BOTH brains from a single source — an operator-side persona/assert tweak then
 * can't silently skip the Sentinel.
 *
 * The mirror reuses the base scenario's persona / goal / caps / asserts /
 * rubric / triggers verbatim; only `id` (`op-…` → `sn-…`) and `target`
 * (`operator` → `sentinel`) change. Pure — unit-friendly.
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P1).
 */
import type { Scenario } from '@papercusp/testing-shell/llm';

export function mirrorForSentinel(base: Scenario): Scenario {
  if (!base.id.startsWith('op-')) {
    throw new Error(
      `mirrorForSentinel expects an operator (op-…) scenario id, got "${base.id}"`,
    );
  }
  return {
    ...base,
    id: `sn-${base.id.slice('op-'.length)}`,
    target: 'papercup',
  };
}
