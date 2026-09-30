/**
 * "Is a build WATCHER able to rewrite the bundle under this long-open page?"
 *
 * This distinguishes a DEV shell — the HMR dev server, the nohmr
 * `vite build --watch`, or a dev-wrapper build switcher, all of which rewrite
 * `dist/` under the running webview so an already-open page's lazy chunk can
 * 404 — from a REAL packaged build, where the bundle is immutable and a lazy
 * import that fails did so for a transient reason (a first-boot chunk fetch that
 * momentarily timed out while the self-hosting operator was busy), NOT because
 * anything "rewrote the bundle".
 *
 * Two consumers depend on getting this right so they don't lie to the owner
 * (WI-2902):
 *   - RouteErrorBoundary's error-card copy ("the dev build watcher rewrote the
 *     bundle" is FALSE in the packaged app — there is no watcher);
 *   - ChunkReloadPrompt's toast ("A newer build is available" is FALSE in the
 *     packaged app).
 *
 * Gate on **MODE**, not `import.meta.env.DEV`: the default desktop dev shell
 * (`bin/desktop-dev-nohmr`) is a `vite build`, so `DEV` is `false` there — only
 * `MODE` is `development` in BOTH dev shells and `production` in the shipped
 * build. Plus the runtime `__PAPERCUSP_DEV_WRAPPER__` flag the dev wrapper
 * injects (compiled out of real-production desktop builds via the `dev-wrapper`
 * Cargo feature). This is the SAME predicate `__root.tsx` uses to gate the dev
 * admin rail — see /internal/docs/agent-insights/dev-only-ui-gating-mode-not-dev.
 */

/** Pure decision — exported for tests. */
export function isDevBuildWatcherShell(
  mode: string | undefined,
  devWrapperFlag: unknown,
): boolean {
  return mode !== 'production' || devWrapperFlag === true;
}

/** Runtime read of {@link isDevBuildWatcherShell} against `import.meta.env.MODE`
 *  and the injected dev-wrapper flag. */
export function inDevBuildWatcherShell(): boolean {
  const devWrapper =
    typeof window !== 'undefined'
      ? (window as { __PAPERCUSP_DEV_WRAPPER__?: boolean }).__PAPERCUSP_DEV_WRAPPER__
      : undefined;
  return isDevBuildWatcherShell(import.meta.env.MODE, devWrapper);
}
