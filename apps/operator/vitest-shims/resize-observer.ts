/**
 * ResizeObserver polyfill for jsdom-based vitest runs.
 *
 * Phase 0 of dockview-migration v4: dockview-react uses ResizeObserver
 * for tab strip + panel sizing. jsdom doesn't ship it, so any test that
 * mounts DockviewReact would crash on first render. This stub is a
 * no-op observer: it accepts callbacks, never fires them, never throws.
 *
 * Mounted via vitest.config.ts setupFiles.
 */

if (typeof globalThis.ResizeObserver === 'undefined') {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}
