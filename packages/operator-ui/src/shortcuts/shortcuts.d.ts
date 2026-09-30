/**
 * The PUBLIC TYPE SURFACE of `@papercusp/operator-ui/shortcuts`, declared
 * without importing the operator modules it re-exports — the same boundary,
 * for the same reasons, as `../surfaces/surfaces.d.ts`: the implementation is
 * typechecked in the tree that owns it, and a consumer following it would pull
 * the operator's `@/`-aliased graph into its own program
 * (portal-global-shortcuts-2026-09-06 P-001).
 *
 * Hand-maintained, so it can drift from `index.tsx`; it is small and
 * shape-stable (two hooks, two components), and the portal's server-stub
 * parity test derives the required export names from THIS file, so a name
 * added here without an implementation — or vice versa — fails a test rather
 * than silently reading `undefined` on the server.
 */
import type { ComponentType, LazyExoticComponent } from 'react';

/** Per-registration options — mirrors `ActionOptions` in operator-core's shortcut-bus. */
export interface ActionOptions {
  /** Allow the shortcut to fire while focus is in a form field. Default: blocked. */
  enableOnFormTags?: ReadonlyArray<'INPUT' | 'TEXTAREA' | 'SELECT'>;
  /** Returning true skips this handler for the event (the bus falls through to the next one). */
  ignoreEventWhen?: (e: KeyboardEvent) => boolean;
  /** Default true: the browser default is cancelled when this handler runs. */
  preventDefault?: boolean;
}

/**
 * Bind a handler to a registry id (packages/operator-core/lib/shortcut-registry.ts).
 * The newest registration for an id runs first; returning `false` falls through.
 * Cleanup is automatic on unmount.
 */
export declare function useShortcutAction(
  id: string,
  run: (e: KeyboardEvent) => void | boolean,
  options?: ActionOptions,
): void;

/** The user's saved combo overrides, re-rendering when a remap is saved. */
export declare function useShortcutOverrides(): Record<string, string>;

/**
 * The single window-level keydown dispatcher. Mount EXACTLY ONCE, eagerly, at
 * the host's root; renders nothing.
 */
export declare const OperatorShortcutDispatcher: ComponentType<Record<string, never>>;

/**
 * History back/forward, the cheat sheet, find-in-page and global search — the
 * operator's app-wide keyboard UI as one lazy mount. Render under Suspense.
 */
export declare const OperatorShortcutSurfaces: LazyExoticComponent<ComponentType<Record<string, never>>>;
