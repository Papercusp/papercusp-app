/**
 * Resolve the distinctId used to evaluate feature flags for a given
 * request. For V1 we don't have per-user targeting, so a single
 * machine-stable id is sufficient and PostHog still records the eval.
 *
 * If we later wire identity (session cookie, auth header, etc.) into
 * the operator, this helper is the only place to update.
 *
 * NO STATIC `node:` IMPORT HERE — deliberately (WI-2145237). This module sits
 * under the lexicon's server wiring (lexicon/configure.ts), which a client page
 * can reach by mistake. A static `import * as os from 'node:os'` at module scope
 * turned that mistake into a BUILD failure in a webpack client compilation
 * (`UnhandledSchemeError: Reading from "node:os"`, portal build #3c 2026-09-05,
 * import trace support/page.tsx → lexicon → configure → flag-distinct-id) and a
 * module-eval hazard under Vite's browser-external stub (`os.hostname` is not a
 * function there). Resolving the builtin lazily through
 * `process.getBuiltinModule` (Node ≥ 22.3) leaves nothing for a bundler to
 * resolve, so a stray client import degrades to a stable placeholder id instead
 * of failing the compilation. The client-boundary guard
 * (apps/operator-vite/src/lib/operator-core-client-boundary.test.ts) still
 * forbids client modules from importing the server wiring — this is the
 * defense in depth, not a licence.
 */

type BuiltinModuleGetter = (id: string) => unknown;

/** The placeholder hostname used when no Node builtin loader is reachable. */
export const UNKNOWN_HOSTNAME = 'unknown-host';

function builtinModuleGetter(): BuiltinModuleGetter | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: unknown } }).process;
  const getter = proc?.getBuiltinModule;
  if (typeof getter !== 'function') return undefined;
  return (id: string) => (getter as BuiltinModuleGetter).call(proc, id);
}

/**
 * The machine hostname, resolved through an injectable builtin-module getter so
 * the behaviour is testable in both directions: with the real
 * `process.getBuiltinModule` it returns `os.hostname()`; with no getter (a
 * browser graph — pass `null` to model it explicitly; `undefined` selects the
 * runtime default), a getter that has no `os`, or one that throws, it returns
 * {@link UNKNOWN_HOSTNAME}.
 */
export function resolveHostHostname(
  getBuiltin: BuiltinModuleGetter | null | undefined = builtinModuleGetter(),
): string {
  if (!getBuiltin) return UNKNOWN_HOSTNAME;
  try {
    const os = getBuiltin('node:os') as { hostname?: () => unknown } | undefined;
    const hostname = os?.hostname?.();
    return typeof hostname === 'string' && hostname.length > 0 ? hostname : UNKNOWN_HOSTNAME;
  } catch {
    return UNKNOWN_HOSTNAME;
  }
}

let systemId: string | undefined;

function systemIdOnce(): string {
  systemId ??= `papercusp-host-${resolveHostHostname()}`;
  return systemId;
}

export function resolveDistinctId(_req: Request): string {
  return systemIdOnce();
}

/**
 * The machine-stable distinctId, with no request in hand. Used by background /
 * non-request server code that still needs to evaluate a (machine-global) flag
 * — e.g. the lexicon brand-pack selector.
 */
export function systemDistinctId(): string {
  return systemIdOnce();
}
