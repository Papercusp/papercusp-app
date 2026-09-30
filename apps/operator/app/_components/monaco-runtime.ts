/**
 * Monaco must never fetch the editor from the public internet.
 *
 * cdn-egress-fixes-2026-08-02 P-001. `@monaco-editor/react` does not bundle the
 * editor: it resolves it at runtime through an AMD loader whose base path
 * DEFAULTS to `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs`
 * (@monaco-editor/loader/lib/es/config/index.js). We never called
 * `loader.config()`, so opening any code surface fetched ~4 MB across the
 * internet before it could paint — ~11 MB once the TypeScript worker loaded.
 *
 * It was also a CORRECTNESS bug, and that is the half worth remembering: the
 * CDN default pins 0.55.1 while we install 0.56.0, so the running editor was a
 * version nothing in CI ever typechecked or tested. Pointing at the mirrored
 * install fixes both at once — the bytes served are now, by construction, the
 * bytes we tested.
 *
 * THE FAILURE MODE THIS GUARDS is quiet and per-surface, exactly like vditor's
 * (see vditor-cdn.test.ts next door): `paths.vs` is an OPTIONAL setting with a
 * WORKING default, so a new Monaco call site that forgets it does not throw,
 * does not warn, and looks perfect on a fast connection — it just silently
 * reintroduces the multi-megabyte internet fetch for its own surface, and
 * silently runs a different version of the editor than the repo installs.
 * Nothing else in the build would notice. Hence the source-level guard test.
 *
 * WHY A SEPARATE MODULE, imported eagerly, rather than configuring inside each
 * lazy import: the four call sites reach Monaco four different ways (`lazy()`,
 * `dynamic()`, and two plain imports). The loader is a process-wide singleton,
 * so configuring it once from a module every call site imports EAGERLY is both
 * simpler and order-independent — the config lands before any `loader.init()`
 * can run, whichever surface mounts first. Importing from `@monaco-editor/loader`
 * rather than `@monaco-editor/react` keeps that eager import to the ~5 KB loader
 * instead of dragging the editor components into the eager bundle and undoing
 * the call sites' lazy chunking.
 *
 * The singleton identity is load-bearing and was verified, not assumed: npm
 * hoists exactly ONE copy of @monaco-editor/loader, and @monaco-editor/react
 * re-exports that same instance (`export { default as loader } from
 * '@monaco-editor/loader'`). Two copies would make this config silently no-op —
 * the worst possible outcome, since the app would look fixed and keep fetching.
 */
import loader from '@monaco-editor/loader';

/**
 * Where the mirrored editor is served from. Populated by
 * `apps/operator/scripts/setup-monaco-runtime.sh` into the publicDir
 * (`apps/operator/public/monaco/vs`), gitignored + regenerated on every install.
 */
export const MONACO_VS_PATH = '/monaco/vs';

let configured = false;

/**
 * Point the Monaco AMD loader at the local mirror. Idempotent, SSR-safe, and
 * never throws: a failure to configure must not take down the surface that was
 * merely trying to render an editor.
 */
export function configureMonacoLoader(): void {
  if (configured) return;
  configured = true;
  try {
    loader.config({ paths: { vs: MONACO_VS_PATH } });
  } catch {
    // `loader.config` warns rather than throws once init has begun, but a future
    // version could throw. A missed config is a slow editor; a thrown error here
    // is a blank pane — so this must degrade, never propagate.
  }
}

// Self-configure on import so a call site cannot hold the import and still miss
// the config. The explicit call at each site (which the guard test asserts) is
// belt-and-braces against a bundler dropping a side-effect-only import.
configureMonacoLoader();
