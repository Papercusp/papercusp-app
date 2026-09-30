/**
 * wire-agent-question-gate — B-17 boot wiring (queen-autonomous-execution-2026-06-13
 * P-043, closing the seam gap D-014). Installs the B-12 decider-backed classifier
 * into the B-10 agent-question gate at module load, so an intercepted bee question
 * is routed through the autonomy D-004 gate instead of the static owner-Queue
 * default. This is the one `configureAgentQuestionGate` caller (the D-009 follow-up
 * that fell between B-12 and B-17 — now owned here).
 *
 * BEHAVIOR-NEUTRAL by construction (D-007): `deciderAgentQuestionGate` →
 * `resolveAutonomyDecision`, which returns `gated` for EVERY input while the owner's
 * P-092 arming flag (`papercusp-queen-autonomy-armed`) is OFF, and `gated` maps to
 * `owner-queue` — identical to the default gate. A context-free question, any IO
 * error, or a disarmed policy all fail-safe to owner-Queue. So importing this at
 * boot changes nothing today; it only starts honoring per-category ceilings once
 * the owner deliberately arms AND lowers a ceiling. No flag of its own: the whole
 * interception is already gated by `MUG_CARD_INTERCEPTION`, and the auto rungs by
 * the autonomy arming gate.
 *
 * Side-effect import (from agent-tools/index.ts) — `configureAgentQuestionGate`
 * is idempotent last-writer-wins on a host-global symbol.
 */
import { configureAgentQuestionGate } from './agent-question-gate';
import { deciderAgentQuestionGate } from './agent-question-decider-gate';

configureAgentQuestionGate(deciderAgentQuestionGate);
