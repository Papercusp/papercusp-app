/**
 * Excalidraw must never fetch its fonts from the public internet.
 *
 * cdn-egress-fixes-2026-08-02 P-004. Excalidraw builds a CANDIDATE LIST for
 * every runtime asset (dist/prod/chunk-K2UTITRG.js):
 *
 *     if (typeof window.EXCALIDRAW_ASSET_PATH === "string") { ...push local... }
 *     return r.push(new URL(n, ASSETS_FALLBACK_URL)), r;
 *
 * with `ASSETS_FALLBACK_URL = https://esm.sh/@excalidraw/excalidraw@<ver>/dist/prod/`.
 * We never set the global, so esm.sh was the only candidate and the brainstorm
 * canvas pulled ~14MB of fonts across the internet.
 *
 * THE TRAP THAT MAKES THIS DIFFERENT from the vditor/monaco mirrors: the
 * fallback is appended UNCONDITIONALLY, even once the local path is set. So a
 * missing local asset does not 404 — excalidraw quietly tries esm.sh next and
 * succeeds. The fix therefore cannot be verified by reading config or listing
 * files; only a runtime check that no esm.sh request occurs proves it. See the
 * mirror script's header and P-007.
 *
 * Set as a module side effect so it lands before the lazy `import(
 * '@excalidraw/excalidraw')` resolves. The global is read at font-load time
 * rather than module-init, so import order is not delicate here — but keeping
 * the assignment in an eagerly-imported module removes the question entirely.
 */

/**
 * Where the mirrored assets are served from. Populated by
 * `apps/operator/scripts/setup-excalidraw-runtime.sh` into the publicDir
 * (`apps/operator/public/excalidraw`), gitignored + regenerated on install.
 *
 * Trailing slash matters: excalidraw resolves each asset with
 * `new URL(relativePath, base)`, and a base without a trailing slash drops its
 * last segment.
 */
export const EXCALIDRAW_ASSET_PATH = '/excalidraw/';

declare global {
  interface Window {
    /** Excalidraw's own asset-base hook — a string base or a list of candidates. */
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}
