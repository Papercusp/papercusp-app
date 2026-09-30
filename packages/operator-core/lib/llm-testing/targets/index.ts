/**
 * Target registry — maps `Scenario.target` strings to `ChatTarget`
 * factories. Add a target by exporting it here.
 */

import type { ChatTarget } from '@papercusp/testing-shell/llm';
import { ArchitectTarget } from './architect';
import { OperatorTarget } from './operator';
import { OracleTarget } from './oracle';
import { SuTarget } from './su';
import { makeOverwatchTarget } from './overwatch';
import { onboardingTutorTarget } from './onboarding-tutor';
import { PuiLoopTarget } from './pui-loop';

export type TargetFactory = () => ChatTarget;

const TARGETS: Record<string, TargetFactory> = {
  operator: () => new OperatorTarget(),
  // papercup — the SAME converse brain loaded with role='papercup' (the
  // Papercup-as-Herald persona). The agent-mcp/operator-converse route honors
  // the explicit body.role, so this exercises Papercup-only behavior the
  // operator role can't reach — notably the `<handoff>` routing
  // (sentinel-as-claude-tui-2026-06-22; converse.ts only honors handoffs for
  // role==='papercup'). Same HTTP transport as `operator`.
  papercup: () => new OperatorTarget({ role: 'papercup' }),
  oracle: () => new OracleTarget(),
  // Architect is harness-scoped; the chat route returns a 400 without
  // a harnessSlug in the body. Default to 'sheets' (the long-standing
  // dev harness present in harness_shared.projects). Scenarios can
  // override per-turn via input.meta.harnessSlug.
  architect: () => new ArchitectTarget({ defaultHarnessSlug: 'sheets' }),
  // su — in-process behavioral SUT for the engineer-collaborator playbook
  // (su-scenario-suite-2026-05-31). Unlike the HTTP-chat targets above it
  // runs a hand-rolled Anthropic tool loop in-process (playbook-as-system-
  // prompt + the papercusp-su catalog); see ./su.
  su: () => new SuTarget(),
  // `mug` and `cup` were HERE and are retired to
  // `_retired/mug-kettle-deciders/…/llm-testing/` (retire-mug-kettle-su-only-2026-08-09
  // D-112, extending D-060). Their SUT was the retired tier's own spawn prompt, their
  // catalogs called actuators that now refuse (D-017), and no gate ever ran them —
  // `llm-test` is a manual CLI. D-060 predicted exactly this survival: an eval harness
  // carries no `_mug-kettle-gate` import, so the tier census cannot see it and defaults
  // it live. If the Mug's grading scenario (Q01) still has value, its home is the `su`
  // target below — grading moved to su/Scout (WI-1713506), it was not lost.
  //
  // ⚠ `kettle` below is NOT part of that retirement — READ THE FACTORY, NOT THE KEY.
  // overwatch — the system-health supervisor's blueprint persona on the same loop
  // (overwatch-role-2026-06-15 B-11: does it NUDGE-not-replace + OBSERVE-not-idea?).
  // Overwatch is LIVE; only the key is a retired-tier name.
  kettle: () => makeOverwatchTarget(),
  // onboarding-tutor — the first-run/tutorial launch context on the same
  // in-process loop (agent-first-onboarding-2026-07-03 P-008: section
  // protocol, progress checkpointing, question-detour return).
  'onboarding-tutor': () => onboardingTutorTarget(),
  // pui-loop — the owned loop's canonical su-derived prompt profile (D-034):
  // same su spine/project guide/modes/orientation/catalog as psu, minus the
  // client-remediation sections whose invariants the loop/doors enforce.
  'pui-loop': () => new PuiLoopTarget(),
};

export function registerTarget(id: string, factory: TargetFactory): void {
  TARGETS[id] = factory;
}

export function getTarget(id: string): ChatTarget {
  const factory = TARGETS[id];
  if (!factory) throw new Error(`Unknown target '${id}'. Registered: ${Object.keys(TARGETS).join(', ')}`);
  return factory();
}

export function listTargets(): string[] {
  return Object.keys(TARGETS);
}

export { OperatorTarget, OracleTarget, ArchitectTarget, SuTarget, PuiLoopTarget };
