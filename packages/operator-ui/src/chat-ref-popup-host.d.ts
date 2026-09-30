/**
 * The PUBLIC TYPE SURFACE of `@papercusp/operator-ui/chat-ref-popup-host`,
 * declared without importing the operator components it mounts — the same
 * boundary, for the same reasons, as `./surfaces/surfaces.d.ts` and
 * `./shortcuts/shortcuts.d.ts` (WI-10001509).
 *
 * WHY THIS FILE EXISTS, MEASURED RATHER THAN ASSUMED
 *
 * `chat-ref-popup-host.tsx` lazily imports
 * `apps/operator/app/_components/chat/ChatRefPopupHost`, whose closure reaches
 * `WorkItemPopupModal` / `PlanPopupModal` and, through them, most of
 * `operator-core`. The façade's own header already says that closure is
 * move-forbidden; what it did NOT carry was the type half of the boundary, so
 * `exports["./chat-ref-popup-host"].types` pointed at the implementation and a
 * consumer's tsc followed it.
 *
 * The portal is that consumer, and the cost was measured with `tsc
 * --explainFiles`: every chain from the portal into the operator-core sync,
 * agent-tool, release and plugin-loader subsystems rooted at exactly one edge —
 * `packages/ui/src/shell.tsx` → `@papercusp/operator-ui/chat-ref-popup-host` →
 * this package's `.tsx` → `apps/operator/.../ChatRefPopupHost.tsx`. That single
 * edge grew the portal's program from ~2.2k files to 10,507 and produced 194
 * diagnostics, ALL of them in papercusp source and NONE in portal source —
 * i.e. artifacts of typechecking the operator tree under the PORTAL's
 * `lib`/`types`/`paths`, not defects. `surfaces.d.ts` documents the identical
 * symptom at 625 errors; this is the same failure arriving through a seam that
 * only did half the pattern.
 *
 * So the boundary is deliberate and matches its two siblings: the
 * IMPLEMENTATION is typechecked in the tree that owns it (`lint:tsc`'s operator
 * legs), and CONSUMERS get this declaration.
 *
 * ⚠ THE COST, STATED PLAINLY: hand-maintained, so it can drift from the `.tsx`.
 * It is two names and one optional prop, and the portal's server-stub parity
 * test (`tests/operator-surface-build.test.ts`) derives the required export
 * names from THIS file — so a name added here without a stub, or vice versa,
 * fails a test rather than silently reading `undefined` on the server.
 */
import type { ReactElement } from 'react';

export interface ChatRefPopupHostProps {
  /**
   * The MOUNTING HOST's own harness, used only when a ref did not carry one of
   * its own. The ref's harness always wins; this outranks only the operator's
   * URL/localStorage-resolved fallback, which a non-operator host has no
   * meaningful value for.
   */
  fallbackHarnessSlug?: string | null;
}

/**
 * The ref-popup renderer. Mount ONCE per host, inside both the nuqs adapter
 * (it reads `wpop`/`wppop` query state) and the host's `SyncProvider` (both
 * popups read through `@papercusp/sync`). Renders nothing until a param is set.
 */
export declare function ChatRefPopupHost(props?: ChatRefPopupHostProps): ReactElement;

export default ChatRefPopupHost;
