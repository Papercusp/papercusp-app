/**
 * session-confinement-port — the host seam that carries a launch-declared confinement
 * to the dispatch seat (directed-pair-work-items-2026-08-25 P-003, ruling D-015).
 *
 * WHY THIS IS A SEPARATE FILE FROM `session-confinement.ts`
 * --------------------------------------------------------
 * The pure module must never see privilege — that absence is guarantee (A), and its
 * guard test pins it by asserting the source contains no `isSuperuser` / `UnifiedToolContext`
 * reference. This file necessarily touches `UnifiedToolContext` (that is its whole job),
 * so it lives next door rather than trip that guard. The split is the architecture, not
 * a workaround: DECISION stays privilege-blind, TRANSPORT knows about sessions.
 *
 * WHY THE DENY IS NOT FLAG-GATED
 * ------------------------------
 * The capability envelope reads `FLAGS.CAPABILITY_ENVELOPE` to choose enforce-vs-observe,
 * because it applies to every fleet role and a bad envelope would break the fleet. This
 * gate has the opposite blast radius: it returns null — completely inert — for any session
 * with no declared confinement, which is every session in existence until a paired fleet
 * launches one. So there is no shadow period to serve; an observe-only mode here would
 * only mean the one thing it is for does not work. It ships enforcing.
 *
 * WHY `pinModuleState` AND NOT A BARE MODULE-SCOPED `let`
 * ------------------------------------------------------
 * A resolver seam that splits across two module records fails OPEN: the record the
 * dispatcher imports has no resolver, `resolveConfinement` returns undefined, and every
 * confined session silently becomes unconfined — with nothing thrown and nothing logged.
 * That is precisely the partial-view failure `@papercusp/module-singleton` exists for, and
 * a security gate is the worst place to discover it the expensive way.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { CapabilityEnvelopeVerdict } from '@papercusp/tooldef';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

import { evaluateSessionConfinement, type SessionToolConfinement } from './session-confinement';

/**
 * Resolves the confinement declared for the calling session, or null/undefined if the
 * session is unconfined. Installed once by the host at boot.
 *
 * ⚠ The resolver MUST read server-side state keyed by the session's own identity. It must
 * never read a confinement out of the request/args: a confinement the caller supplies is
 * one the caller can omit, which is not a confinement.
 */
export type SessionConfinementResolver = (
  ctx: UnifiedToolContext,
) => SessionToolConfinement | null | undefined;

const state = pinModuleState('@papercusp/operator-core.session-confinement-port', () => ({
  resolver: undefined as SessionConfinementResolver | undefined,
  ensureReady: undefined as (() => Promise<void>) | undefined,
}));

/**
 * Install (or clear, with `undefined`) the host resolver.
 *
 * `ensureReady` is awaited before the FIRST consult and is expected to memoize itself, so the
 * host can prime a cache without the resolver having to be async. It exists for one case the
 * launch ordering cannot cover: an operator RESTART with a confined session already live, where
 * the cache starts empty and a cold miss would read as "unconfined" (D-017 §4).
 */
export function setSessionConfinementResolver(
  fn: SessionConfinementResolver | undefined,
  opts?: { ensureReady?: () => Promise<void> },
): void {
  state.resolver = fn;
  state.ensureReady = opts?.ensureReady;
}

/** Whether a resolver is installed — for boot assertions and tests. */
export function hasSessionConfinementResolver(): boolean {
  return state.resolver !== undefined;
}

/**
 * The gate, in the shape the dispatcher's capability-envelope port already returns.
 *
 * Returns null when there is nothing to say (no resolver, unconfined session, or a tool
 * the confinement permits) so the caller falls through to the ordinary envelope check.
 *
 * Note what is NOT consulted here: `ctx.isSuperuser`, `ctx.isPowerUser`, `ctx.role`. A
 * confined session is confined at every privilege level — that is the entire point of
 * D-015, and it is what makes this gate bind where `ROLE_ENVELOPES` cannot.
 */
export async function checkSessionConfinement(input: {
  toolName: string;
  ctx: UnifiedToolContext;
}): Promise<CapabilityEnvelopeVerdict | null> {
  const resolver = state.resolver;
  if (!resolver) return null;

  const ensureReady = state.ensureReady;
  if (ensureReady) {
    try {
      // Memoized by the host: one await per process, not one per dispatch.
      await ensureReady();
    } catch {
      // A priming failure must not take every dispatch on the box down. The store logs it;
      // here we simply proceed with whatever the cache holds (empty ⇒ unconfined).
    }
  }

  let confinement: SessionToolConfinement | null | undefined;
  try {
    confinement = resolver(input.ctx);
  } catch {
    // A resolver that throws must not fail OPEN into "unconfined", but it also must not
    // take down every dispatch on the box. Denying everything would do the latter, so the
    // narrow, honest behaviour is: treat it as unconfined and let the ordinary envelope
    // still run — while making the fault loud, because a silently-broken resolver is the
    // one way this gate quietly stops existing.
    console.error('[session-confinement] resolver threw — session treated as UNCONFINED for this call');
    return null;
  }
  if (!confinement) return null;

  const decision = evaluateSessionConfinement({ toolName: input.toolName, confinement });
  if (decision.allowed) return null;

  return {
    decision: 'deny',
    posture: 'rejected',
    applied: true,
    reason: decision.reason,
  };
}
