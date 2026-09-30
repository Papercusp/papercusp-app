/**
 * agent-question-gate — the EXECUTION seam for B-10 (queen-autonomous-execution
 * P-041/P-045): intercept a fleet agent's blocking decision card and turn it into
 * a routable item instead of a freeze waiting on the owner.
 *
 * Layer boundary (queen-autonomous-execution D-001/D-003): THIS plan builds the
 * EXECUTION wiring — detect the autonomous caller, route the question down the
 * cheapest rung the gate allows, resolve the card so the agent continues in-turn,
 * and degrade safely on timeout. The CLASSIFICATION + PERMISSION (which rung a
 * given {category, risk_tier, reversibility, authority} is allowed to take) is
 * owned by `queen-autonomy-policy` (its D-004 gating function). We DO NOT classify
 * here — we expose a single injection seam (`configureAgentQuestionGate`) the
 * autonomy-policy classifier plugs into. Until it does, every agent question
 * routes to the owner Queue (D-007: behavior-neutral throughput now; the AUTO
 * rungs arm later). No second gate.
 *
 * What "route to the owner Queue" means concretely TODAY: write a durable,
 * append-only coord escalation (severity 'question') tagged `category:'agent-question'`
 * and linked to the live `ctx.askUser` card (`cardCorrelationId`/`cardWorkspaceId`,
 * Phase-D meta) so it lands in the owner inbox as a routable item AND — when any
 * rung answers via `coord:resolve` → `unblockLinkedCard` → `resolveCardResponse` —
 * the same card resolves and the blocked agent resumes in-turn. The interception
 * also gives the card a bounded `timeoutMs` so an unanswered question degrades to
 * `{action:'cancel'}` rather than holding the agent's run forever.
 */

import { pinModuleState } from '@papercusp/module-singleton';

import type { AgentIdentity } from './identity';
import { openEscalation, type EscalationRecord } from './escalations';

/**
 * Bounded wall-clock the intercepted card waits before degrading to
 * `{action:'cancel'}` (the agent then proceeds with its own reversible default).
 * The window is long enough for a present owner — or, once armed, a fast rung —
 * to answer in-turn via the back-edge, but bounded so a question nobody answers
 * (owner asleep, no armed rung) never freezes the agent's run indefinitely.
 * Tunable; the gate may override it per-rung via the routing result.
 */
export const AGENT_CARD_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/** The escalation ladder rung a question is routed to (queen-autonomous-execution
 *  Phase 5). Only `owner-queue` is reachable until autonomy-policy arms the AUTO
 *  rungs (B-17); the gate seam returns the others once a classifier is injected. */
export type QuestionRung = 'bee-self' | 'peer-vote' | 'mug' | 'owner-queue';

/** Stable machine category for an agent's mid-run decision card. The
 *  autonomy-policy taxonomy's human-facing label is "escalations & agent-questions";
 *  this is the key its classifier keys on. */
export const AGENT_QUESTION_CATEGORY = 'agent-question';

/** Input a classifier sees for one intercepted question. Pure data — no card
 *  handles — so the gate stays a decision function, not an effect. */
export interface AgentQuestionInput {
  identity: AgentIdentity;
  question: string;
  options: { id: string; label: string }[];
  planSlug?: string;
  /**
   * Optional decision-context describing WHAT the question is about — the action
   * the bee would take + its risk/authority/reversibility. The B-12 decider-backed
   * gate ({@link deciderAgentQuestionGate}) feeds these to `resolveAutonomyDecision`;
   * the default owner-Queue gate ignores them. A question with no context fail-safes
   * to gated/owner-Queue (the decider treats it as unmapped → never-auto). B-17/P-040
   * (the bee declaring its decision's reversibility) populates these. Loosely typed
   * as strings so this hot-path module stays free of the autonomy type imports.
   */
  action?: string;
  riskTier?: string;
  authority?: string;
  reversibility?: string;
}

/** A routing decision. `rung` selects the ladder step; `timeoutMs` optionally
 *  overrides {@link AGENT_CARD_TIMEOUT_MS} for this question. */
export interface AgentQuestionRouting {
  rung: QuestionRung;
  timeoutMs?: number;
}

/** The injectable classifier. autonomy-policy supplies the real one (its D-004
 *  gating function, via {@link deciderAgentQuestionGate}); the default routes
 *  everything to the owner Queue. May be sync or async — the real decider reads
 *  the policy store + the arming flag, so a classifier returning a Promise is
 *  expected and awaited. */
export type AgentQuestionGate = (
  input: AgentQuestionInput,
) => AgentQuestionRouting | Promise<AgentQuestionRouting>;

const DEFAULT_GATE: AgentQuestionGate = () => ({ rung: 'owner-queue' });

/**
 * The injected gate is realm-pinned through `pinModuleState` rather than a
 * hand-rolled `globalThis` symbol. The correctness requirement is the same — one
 * gate per host process — but the failure mode of a hand-rolled pin is silent
 * here in a way that matters: if this module's record splits (a tsx CJS preflight
 * beside the ESM loader, a bare-specifier vs relative-path import), the
 * autonomy-policy boot installs its classifier into one slot while `currentGate()`
 * reads the other, so every agent question falls back to DEFAULT_GATE (the owner
 * Queue) while the classifier looks correctly installed. Nothing throws; the gate
 * just quietly stops classifying.
 *
 * The key string is deliberately unchanged. `pinModuleState` also counts module
 * evaluations, so that split becomes reportable via `listModuleDuplications()`
 * instead of being discovered from a contradictory reading days later.
 */
const gateState = pinModuleState<{ gate: AgentQuestionGate | null }>(
  'papercusp.agentQuestionGate',
  () => ({ gate: null }),
);

/**
 * Install the autonomy-policy classifier. Composition seam, NOT a fork: the
 * autonomy-policy boot calls this once with its gating function. Idempotent-ish
 * (last writer wins). Held in realm-pinned state so a single host process shares
 * one gate across every tool dispatch.
 */
export function configureAgentQuestionGate(gate: AgentQuestionGate): void {
  gateState.gate = gate;
}

/** Test-only: drop any injected gate back to the owner-Queue default. */
export function resetAgentQuestionGate(): void {
  gateState.gate = null;
}

function currentGate(): AgentQuestionGate {
  return gateState.gate ?? DEFAULT_GATE;
}

/**
 * True when the caller is an autonomous fleet agent — a bee (`fleet-spawn`) or an
 * invoke-route pipeline agent (`signed-spawn`) — i.e. NO human is watching the
 * card surface, so a blocking card is a freeze, not a prompt. Interactive tiers
 * (power-user OMP human, superuser engineer, in-process operator/principal) keep
 * the live card: a human (or the operator brain in a live converse) is there to
 * answer it, and intercepting would steal their card.
 */
export function isAutonomousAgent(identity: AgentIdentity): boolean {
  return identity.source === 'fleet-spawn' || identity.source === 'signed-spawn';
}

/**
 * Classify one question via the injected gate (default: owner Queue) and resolve
 * the bounded card timeout. No card handle, no write — so it runs BEFORE the card
 * is registered (the spec's `timeoutMs` must be set up-front). Async because the
 * real (B-12 decider) gate reads the policy store + arming flag; a gate that throws
 * OR rejects falls safe to the owner Queue (a classifier failure must never freeze
 * a bee or silently auto-decide).
 */
export async function classifyAgentQuestion(input: AgentQuestionInput): Promise<{
  rung: QuestionRung;
  timeoutMs: number;
}> {
  let routing: AgentQuestionRouting;
  try {
    routing = await currentGate()(input);
  } catch {
    routing = { rung: 'owner-queue' };
  }
  const timeoutMs =
    typeof routing.timeoutMs === 'number' && routing.timeoutMs > 0
      ? routing.timeoutMs
      : AGENT_CARD_TIMEOUT_MS;
  return { rung: routing.rung, timeoutMs };
}

/** The shape `chat:ask_choice` hands the gate once the card is registered. */
export interface RouteAgentQuestionInput extends AgentQuestionInput {
  cardCorrelationId: string;
  cardWorkspaceId: string;
}

/**
 * Write the durable, card-linked escalation that makes an intercepted question a
 * routable owner-Queue item. Best-effort: an identity/write failure never breaks
 * the card flow (the caller still has its timeout safety net) — returns null.
 * `rung` is stamped onto the record so the inbox/Queen can see how it was routed.
 */
export async function openAgentQuestionEscalation(
  identity: AgentIdentity,
  input: RouteAgentQuestionInput,
  rung: QuestionRung,
): Promise<EscalationRecord | null> {
  try {
    return await openEscalation(identity, {
      severity: 'question',
      summary: input.question,
      options: input.options.map((o) => ({ id: o.id, label: o.label })),
      ...(input.planSlug ? { plan_slug: input.planSlug } : {}),
      meta: {
        cardCorrelationId: input.cardCorrelationId,
        cardWorkspaceId: input.cardWorkspaceId,
        category: AGENT_QUESTION_CATEGORY,
        autonomous: true,
        rung,
      },
    });
  } catch {
    /* identity/write failure must never break the card flow */
    return null;
  }
}

/** What the interception needs back: the chosen rung, the bounded timeout that was
 *  put on the card, and the durable escalation that was opened. */
export interface RouteAgentQuestionResult {
  rung: QuestionRung;
  timeoutMs: number;
  escalation: EscalationRecord | null;
}

/**
 * Convenience: classify + open in one call (the combined seam, used by tests and
 * any non-card caller). The card path uses {@link classifyAgentQuestion} up-front
 * and {@link openAgentQuestionEscalation} in `onCard` instead, so the spec timeout
 * is set before the card registers.
 */
export async function routeAgentQuestion(
  identity: AgentIdentity,
  input: RouteAgentQuestionInput,
): Promise<RouteAgentQuestionResult> {
  const { rung, timeoutMs } = await classifyAgentQuestion(input);
  const escalation = await openAgentQuestionEscalation(identity, input, rung);
  return { rung, timeoutMs, escalation };
}
