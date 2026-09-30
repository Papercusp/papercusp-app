import { LEFT_SIDEBAR_CSS } from '../left-sidebar/left-sidebar.styles';

/**
 * The rail's `pclsb-*` stylesheet, behind a dynamic-import boundary (WI-5502).
 *
 * `ChatFacesHost` is imported EAGERLY by `routes/__root.tsx` (it wraps
 * `ChromeShell`), so anything it imports statically lands in the first-paint
 * module graph. `LEFT_SIDEBAR_CSS` is a ~110KB CSS-in-JS string that only the
 * chat-face PANES need — and every pane is rendered from a `render()` callback
 * that runs only once the user opens the Fleet / Peers / Learning face, behind
 * its own `lazy()`. The stylesheet was therefore modulepreloaded on every first
 * paint to style a subtree that first paint never mounts.
 *
 * Routing it through this module gives it a real dynamic-import boundary, so
 * Vite emits it as its own chunk fetched when a face pane first renders. The
 * left rail's own copy (`LeftSidebar.tsx`) is unaffected — that component is
 * already `lazy()`, so its edge was never eager. Injecting the same rules twice
 * when both are mounted stays harmless: same rules, same cascade.
 *
 * Same shape and same reason as `route-content/DevLayoutContent` for `dev.css`.
 * See /internal/docs/performance.
 */
export default function LeftSidebarStyleTag() {
  return <style>{LEFT_SIDEBAR_CSS}</style>;
}
