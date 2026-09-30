/**
 * Dev admin rail styles, as a JS string (NOT a .css import).
 *
 * Why a string and not `import './x.css'`: Vite eagerly collects CSS imported by
 * a module into the output stylesheet EVEN when that module is a dead
 * dynamically-imported chunk (the rail is dev-gated in __root.tsx). A `.css`
 * import therefore leaks the rail's class names into production builds. Carrying
 * the CSS as a string that the component injects via `<style>` keeps it inside
 * the JS module, so it tree-shakes away with the rest of the rail in prod —
 * matching FeaturesAdmin's inline-`<style>` pattern. Source: P-009 / D-001.
 */
export const RAIL_CSS = `/*
 * Dev admin rail — chrome styles (plan dev-admin-sidebar-2026-06-05).
 *
 * A collapsible, dev-only right rail. DOCKED like the left op-chat sidebar: it
 * reserves layout space (body.has-dev-rail padding-right + the --dev-rail-w var)
 * so the app shifts left instead of the rail floating over content, and it stays
 * present as a thin expand-rail when collapsed (never a disappearing tab). The
 * width is drag-resizable from the left edge. Tokens mirror the proven
 * FeaturesAdmin palette (var(--bg-*), var(--accent-*)) so it reads as part of the
 * app's dark glassy theme. Everything is prefixed pcdar.
 */

.pcdar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1300; /* same layer as the op-chat sidebar; below sonner toasts */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-1, #0a1422), transparent 2%),
    color-mix(in srgb, var(--bg-deep, #060d18), transparent 0%)
  );
  border-left: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 78%);
  box-shadow: -18px 0 48px rgba(0, 0, 0, 0.42);
  /* width is set inline (collapsed rail vs expanded panel, drag-resizable) */
}

/* Expanded shell — header + accordion. Hidden when collapsed (and its panels
   are unmounted in the TSX) so an inactive panel's SSE/queries never run. */
.pcdar__expanded-shell {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pcdar[data-collapsed="true"] .pcdar__expanded-shell {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

/* Collapsed: a thin full-height rail with a vertical "Dev" affordance that
   re-expands it — mirrors the op-chat sidebar's collapsed expand-rail, so the
   rail is always docked and never disappears. */
.pcdar__expand-rail {
  position: relative;
  z-index: 3;
  display: none;
  width: 100%;
  height: 100%;
  padding: 12px 6px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  align-items: center;
  justify-content: flex-start;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
}
.pcdar[data-collapsed="true"] .pcdar__expand-rail {
  display: flex;
}
.pcdar__expand-orb {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 76%);
  background:
    radial-gradient(circle at 35% 25%, rgba(255, 255, 255, 0.16), transparent 24%),
    color-mix(in srgb, var(--accent, #57d7ff), transparent 88%);
  color: var(--accent-strong, var(--accent-soft));
}
.pcdar__expand-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 760;
  color: color-mix(in srgb, var(--fg), transparent 14%);
}
.pcdar__expand-chevron {
  width: 16px;
  height: 16px;
  color: var(--accent-soft);
}
.pcdar__expand-rail:hover {
  background: color-mix(in srgb, var(--bg-1, #0a1422), transparent 2%);
}
.pcdar__expand-rail:hover .pcdar__expand-orb {
  border-color: color-mix(in srgb, var(--accent), transparent 50%);
  color: var(--fg);
}
.pcdar__expand-rail:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 18%);
  outline-offset: -3px;
}

/* Drag-to-resize handle on the LEFT edge (the rail is docked on the right). */
.pcdar__resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
  z-index: 4;
  touch-action: none;
}
.pcdar__resize-handle:hover {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 78%),
    transparent
  );
}
.pcdar[data-collapsed="true"] .pcdar__resize-handle {
  display: none;
}

/* Body reservation — the app shifts left by the rail's width so it docks
   (pushes content) instead of floating over it, mirroring the op-chat
   sidebar's left padding. This header-width rule is injected after the
   op-chat one, so on equal specificity it wins when both sidebars are
   present; each var defaults to 0px so the two sides compose independently. */
body.has-dev-rail {
  padding-right: var(--dev-rail-w, 48px);
}
body.has-dev-rail .pc-header {
  width: calc(100vw - var(--op-chat-w, 0px) - var(--dev-rail-w, 0px) - var(--left-sidebar-w, 0px));
}

/* Header */
.pcdar__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 84%);
  background: color-mix(in srgb, var(--bg-deep, #060d18), transparent 6%);
}
.pcdar__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 760;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--fg), transparent 18%);
}
.pcdar__title-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent), transparent 84%);
  color: var(--accent-soft);
  font-size: 9px;
}
.pcdar__spacer {
  flex: 1;
}
.pcdar__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 84%);
  background: rgba(255, 255, 255, 0.03);
  color: color-mix(in srgb, var(--fg), transparent 22%);
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pcdar__iconbtn:hover {
  background: rgba(12, 24, 38, 0.96);
  border-color: color-mix(in srgb, var(--accent), transparent 60%);
  color: var(--fg);
}

/* Accordion */
.pcdar__acc {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pcdar__sec {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 88%);
}
.pcdar__sec.is-active {
  flex: 1;
  min-height: 0;
}
.pcdar__sec-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--fg), transparent 26%);
  font-size: 12px;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.pcdar__sec-head:hover {
  background: color-mix(in srgb, var(--bg-1, #0a1422), transparent 2%);
  color: var(--fg);
}
.pcdar__sec.is-active > .pcdar__sec-head {
  color: var(--fg);
  background: color-mix(in srgb, var(--bg-raised, #0e1c30), transparent 2%);
}
.pcdar__sec-icon {
  display: inline-flex;
  color: var(--accent, #57d7ff);
  opacity: 0.85;
}
.pcdar__sec-label {
  flex: 1;
}
.pcdar__sec-count {
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
  color: color-mix(in srgb, var(--fg), transparent 18%);
  font-size: 10px;
  font-weight: 700;
}
.pcdar__sec-count.is-bad {
  background: rgba(248, 113, 113, 0.2);
  color: #fca5a5;
}
.pcdar__sec-count.is-good {
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
}
.pcdar__sec-chevron {
  display: inline-flex;
  color: rgba(148, 163, 184, 0.7);
  transition: transform 140ms;
}
.pcdar__sec.is-active .pcdar__sec-chevron {
  transform: rotate(90deg);
}
.pcdar__sec-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 8px;
}

/* Shared panel primitives (glance panels P-004..P-008) */
.pcdar-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 14px;
}
.pcdar-panel__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}
.pcdar-panel__bar-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: rgba(148, 163, 184, 0.78);
}
.pcdar-panel__bar-spacer {
  flex: 1;
}
.pcdar-panel__refresh {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 82%);
  background: rgba(255, 255, 255, 0.03);
  color: color-mix(in srgb, var(--fg), transparent 20%);
  font-size: 11px;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pcdar-panel__refresh:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent), transparent 60%);
  color: var(--fg);
}
.pcdar-panel__refresh:disabled {
  opacity: 0.55;
  cursor: progress;
}
.pcdar-panel__refresh.is-spinning svg {
  animation: pcdar-spin 0.8s linear infinite;
}
@keyframes pcdar-spin {
  to {
    transform: rotate(360deg);
  }
}
.pcdar-panel__empty {
  padding: 14px 4px;
  color: rgba(148, 163, 184, 0.74);
  font-size: 12px;
  text-align: center;
}
.pcdar-panel__error {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(248, 113, 113, 0.32);
  background: rgba(248, 113, 113, 0.08);
  color: #fda4af;
  font-size: 12px;
  line-height: 1.5;
}

/* Rows / cards inside glance panels */
.pcdar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 88%);
  background: color-mix(in srgb, var(--bg-deep, #060d18), transparent 12%);
}
.pcdar-row + .pcdar-row {
  margin-top: 6px;
}
.pcdar-row__main {
  flex: 1;
  min-width: 0;
}
.pcdar-row__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pcdar-row__sub {
  margin-top: 2px;
  font-size: 11px;
  color: color-mix(in srgb, var(--fg), transparent 30%);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pcdar-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(148, 163, 184, 0.6);
}
.pcdar-dot.is-up {
  background: #4ade80;
  box-shadow: 0 0 7px rgba(74, 222, 128, 0.7);
}
.pcdar-dot.is-down {
  background: #f87171;
  box-shadow: 0 0 7px rgba(248, 113, 113, 0.7);
}
.pcdar-dot.is-absent {
  background: rgba(148, 163, 184, 0.5);
}
.pcdar-pill {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  background: rgba(148, 163, 184, 0.18);
  color: color-mix(in srgb, var(--fg), transparent 18%);
}
.pcdar-pill.is-good {
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
}
.pcdar-pill.is-bad {
  background: rgba(248, 113, 113, 0.2);
  color: #fca5a5;
}
.pcdar-pill.is-warn {
  background: rgba(251, 191, 36, 0.18);
  color: #fcd34d;
}

/* Key/value grid used by deploy + db panels */
.pcdar-kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: 12px;
  padding: 2px 2px 4px;
}
.pcdar-kv__k {
  color: rgba(148, 163, 184, 0.78);
}
.pcdar-kv__v {
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The reused full-page panels (Flags/Run) get a scroll container so their own
   max-width:auto layout fits the narrow rail. */
.pcdar-embed {
  /* Override the embedded surfaces' page paddings so they fit the 384px rail. */
}
.pcdar-embed .fa-shell,
.pcdar-embed .pc-ops-shell {
  max-width: 100%;
  padding: 8px 12px 16px;
  margin: 0;
}
.pcdar-embed .fa-presets {
  grid-template-columns: 1fr;
}
.pcdar-embed .pc-ops-grid {
  grid-template-columns: 1fr;
}
`;
