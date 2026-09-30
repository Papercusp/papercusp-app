/**
 * The recovery door's identity, in a module with NO imports.
 *
 * This file exists for one reason: a recovery door must not ride the failure
 * domain it recovers. `identity-grants-port.ts` decides whether the door opens,
 * but it is also the module that fails — and `projected-tool-deps.ts` reaches it
 * through a DYNAMIC import inside a try/catch, so when that import throws there
 * is nothing left to ask. A catch that needs the door's identity therefore
 * cannot get it from the module that just failed to load; that circularity is
 * the whole defect (EI-23768233018723089).
 *
 * Keeping this dependency-free is the load-bearing property, not a style
 * preference: a module with no imports has no way to fail to load for the same
 * reason the gate did. Do NOT add an import here — not a type-only one, not a
 * constant from a sibling. Anything this file imports becomes a new way for the
 * break-glass path to be unreachable at exactly the moment it is needed.
 *
 * Reuse-first note: `agent-tools/sessions/automatic-tool-names.ts` is the other
 * dependency-free leaf and already documents the three dispatch wrappers, so it
 * was the obvious host. It is deliberately NOT used — it is the TELEMETRY
 * classification contract, and the kernel authority seat should not have to
 * import a telemetry module to decide a denial. The two names are pinned to
 * their real registrations by tests rather than shared through a common import.
 */

/**
 * The identity plane's resync verb — the door the CTRL block's own `resync`
 * contract names as the way out of a desynchronised session.
 */
export const RECOVERY_DOOR_TOOL = 'coord:orient';

/**
 * The single-target dispatch wrapper that forwards ONE named tool server-side.
 *
 * This is load-bearing for reachability, not a convenience: a TRIMMED agent
 * surface does not carry {@link RECOVERY_DOOR_TOOL} in its seed toolset, so
 * `tools:invoke { name: 'coord:orient' }` is the ONLY route an affected session
 * has to the door. A gate that compares tool names alone sees `tools:invoke`,
 * fails the comparison, and seals exactly the sessions it must let out —
 * measured live 2026-09-20T10:43Z, on a session whose own earlier fix to this
 * gate could not save it.
 *
 * `code:run` and `recipes:run` are dispatch wrappers too, but they forward
 * arbitrary SEQUENCES rather than one declared tool, so there is no single
 * target to verify and they are deliberately not recognised here.
 */
export const RECOVERY_DOOR_DISPATCH_WRAPPER = 'tools:invoke';

/**
 * True when this call is the recovery door — either named directly, or carried
 * as the declared target of the single-target dispatch wrapper.
 *
 * Reading the wrapper's declared target is safe because the wrapper forwards
 * that SAME name onward, and the forwarded tool is independently preflighted by
 * the same kernel seat: a caller cannot name one tool here and run another, and
 * naming the door grants nothing the door itself would not grant.
 *
 * Accepts the raw, untrusted args deliberately — every non-object, missing or
 * non-string target falls through to `false` rather than throwing, because a
 * predicate used inside a catch must not become a second source of failure.
 */
export function isRecoveryDoorCall(toolName: string, args: unknown): boolean {
  if (toolName === RECOVERY_DOOR_TOOL) return true;
  if (toolName !== RECOVERY_DOOR_DISPATCH_WRAPPER) return false;
  if (!args || typeof args !== 'object') return false;
  return (args as { name?: unknown }).name === RECOVERY_DOOR_TOOL;
}
