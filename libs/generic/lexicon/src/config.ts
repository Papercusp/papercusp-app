/**
 * Host seam for ambient resolution.
 *
 * The pure resolver ({@link resolveTerm}) takes an explicit pack, which is
 * what React code does (it reads the flag and passes the pack id). But code
 * with no obvious place to thread a pack — server-emitted user-facing strings,
 * a notification builder, a doc-title formatter — needs to ask "which pack is
 * active right now?" without importing the flag system. That selection is the
 * one host-specific bit, injected here via `configureLexicon()`.
 *
 * Unconfigured, the ambient resolver falls back to the default pack (classic)
 * — branding must never throw. The host wires a real selector at startup
 * (see the operator's `lib/lexicon/configure.ts`).
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { DEFAULT_PACK_ID } from './packs';
import { resolveTerm } from './resolver';
import type { BrandPackId, TermKey, TermOptions } from './types';

export interface LexiconHost {
  /** Which brand pack is active right now. Must be synchronous. */
  activePackId: () => BrandPackId;
}

/**
 * The pin key — also the id this module reports under in
 * `listModuleDuplications()`, so a split here is visible in the REALM-WIDE
 * report rather than only through this module's own accessor.
 *
 * The string is unchanged from the `Symbol.for(...)` description this seam used
 * before it was migrated (EI-19469900474673886), so the id stays stable across
 * the change.
 */
const STATE_KEY = '@papercusp/lexicon:host';

interface LexiconState {
  host: LexiconHost | undefined;
}

/**
 * Pinned + counted by `@papercusp/module-singleton` rather than hand-rolled.
 *
 * A hand-rolled `globalThis[Symbol.for(...)]` slot fixes correctness but hides
 * the packaging fault, and — worse — is invisible to `listModuleDuplications()`,
 * so the central report answers a clean `[]` while this module is split. Must
 * stay at module scope: `evaluations` is only a module-RECORD count if this call
 * runs exactly once per evaluation of this body.
 */
const state = pinModuleState<LexiconState>(STATE_KEY, () => ({ host: undefined }));

/** Inject the active-pack selector. Process-global; last call wins. */
export function configureLexicon(host: LexiconHost): void {
  state.host = host;
}

/** True once a host has been wired. */
export function isLexiconConfigured(): boolean {
  return state.host !== undefined;
}

/** Test hook: clear the wired host. Never call from production code. */
export function __resetLexiconHostForTests(): void {
  state.host = undefined;
}

/**
 * The active pack id per the wired host, or the default when unconfigured.
 * Never throws — a missing host means "no rebrand", i.e. classic.
 */
export function activePackId(): BrandPackId {
  const host = state.host;
  if (!host) return DEFAULT_PACK_ID;
  try {
    return host.activePackId();
  } catch {
    return DEFAULT_PACK_ID;
  }
}

/**
 * Ambient resolve: resolve `key` against whatever pack the host says is
 * active. Use from non-React code; React should use the reactive hook so it
 * re-renders on a live flag flip.
 */
export function term(key: TermKey, opts?: TermOptions): string {
  return resolveTerm(activePackId(), key, opts);
}
