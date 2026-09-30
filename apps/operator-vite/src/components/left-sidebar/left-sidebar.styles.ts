/**
 * Left sidebar styles, as a JS string (NOT a .css import) — same rationale as
 * dev-admin-rail.styles.ts: a `.css` import leaks into the production sheet
 * even from a lazy chunk; an injected `<style>` tree-shakes with the module.
 *
 * The rail (left-sidebar-tauri-2026-06-07) is the desktop twin of the pui
 * dock's old main pane: Swarm / Voice / Hives as TABS. DOCKED on the LEFT —
 * it reserves layout space (body.has-left-sidebar padding-left + the
 * --left-sidebar-w var) so the app shifts right, sits at the FAR LEFT before
 * the Papercup chat pane, collapses to a thin expand-rail, and is
 * drag-resizable from its RIGHT edge. Everything is prefixed pclsb.
 *
 * ⚠ The whole sheet below is ONE TEMPLATE LITERAL. A stray backtick or `${` —
 * including inside a CSS comment, e.g. quoting a token name as `--foo` — closes
 * the string and the file stops PARSING: `npm run typecheck` hard-fails and every
 * test that imports this module reports as UNMATCHED (a transform error, which
 * reads like a test-router problem rather than a syntax one). Write token names
 * bare (--foo), never in backticks.
 */
import { ACCOUNTS_TAB_CSS } from '@papercusp/operator-ui';

export const LEFT_SIDEBAR_CSS = `
.pclsb {
  --pclsb-current-accent: var(--accent, #38bdf8);
  position: fixed;
  top: 0;
  left: 0; /* D-009: steering/settings is the far-left dock */
  bottom: 0;
  z-index: 1290; /* just under the op-chat sidebar / dev rail layer */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    linear-gradient(90deg, color-mix(in oklab, var(--accent), transparent 94%), transparent 38%),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--bg-1, #0b1220), transparent 1%),
      color-mix(in srgb, var(--bg-deep, #050d18), transparent 0%)
    );
  border-right: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  box-shadow: 14px 0 38px rgba(0, 0, 0, 0.28);
}
.pclsb[data-tab="accounts"] {
  --pclsb-current-accent: #a78bfa;
}
.pclsb[data-tab="queen"] {
  --pclsb-current-accent: var(--warn, #fbbf24);
}
.pclsb[data-tab="overwatch"] {
  --pclsb-current-accent: #f87171;
}
/* WI-4789 (owner: the Fleet tab "looks off"): the PANEL CONTENT accent stays
   the app's blue-frost accent — the old green content tint made the whole
   fleet panel sit apart from the rest of the side matter. The tab CHIP keeps
   its green wayfinding accent (nav carve-out) via --pclsb-tab-accent below;
   fleet SECTION colors still arrive inline from the roster data. */
.pclsb[data-tab="swarm"] {
  --pclsb-current-accent: var(--accent, #38bdf8);
}
.pclsb[data-tab="voice"] {
  --pclsb-current-accent: var(--accent, #38bdf8);
}
.pclsb[data-tab="hives"] {
  --pclsb-current-accent: var(--warn, #fbbf24);
}
/* Conversations keeps the app's own accent: its FOUR source hues already do the
   wayfinding inside the pane, so a fifth pane-level tint would fight them. */
.pclsb[data-tab="conversations"] {
  --pclsb-current-accent: var(--accent, #38bdf8);
}

/* Body reservation — the app shifts right by op-chat + this rail. This rule
   composes with (and must win over) the op-chat-only reservation; both default
   missing vars to 0px so the sides stay independent. */
body.has-left-sidebar {
  padding-left: calc(var(--op-chat-w, 0px) + var(--left-sidebar-w, 48px));
}
body.has-left-sidebar .pc-header {
  left: calc(var(--left-sidebar-w, 0px) + var(--op-chat-w, 0px));
  width: calc(100vw - var(--op-chat-w, 0px) - var(--left-sidebar-w, 0px) - var(--dev-rail-w, 0px));
}

/* Expanded shell — tab strip + active panel. Hidden when collapsed (panels
   are unmounted in the TSX) so an inactive tab's queries never run. */
.pclsb__expanded-shell {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pclsb[data-collapsed="true"] .pclsb__expanded-shell {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

/* Collapsed: a thin full-height rail with the three tab icons — clicking one
   expands straight into that tab. */
.pclsb__expand-rail {
  position: relative;
  z-index: 3;
  display: none;
  width: 100%;
  height: 100%;
  padding: 12px 6px 10px;
  align-items: center;
  flex-direction: column;
  gap: 10px;
}
.pclsb[data-collapsed="true"] .pclsb__expand-rail {
  display: flex;
}
.pclsb__rail-btn {
  --pclsb-tab-accent: var(--accent, #38bdf8);
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--pclsb-tab-accent), transparent 68%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), transparent 92%);
  color: color-mix(in oklab, var(--pclsb-tab-accent), var(--fg, #e7f7ff) 38%);
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb__rail-btn:hover {
  border-color: color-mix(in oklab, var(--pclsb-tab-accent), transparent 34%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), transparent 82%);
  color: var(--fg, #e7f7ff);
}
.pclsb__rail-btn:focus-visible {
  outline: 1px solid color-mix(in oklab, var(--pclsb-tab-accent), transparent 18%);
  outline-offset: -2px;
}
.pclsb__rail-btn--accounts,
.pclsb__tab--accounts {
  --pclsb-tab-accent: #a78bfa;
}
.pclsb__rail-btn--queen,
.pclsb__tab--queen,
.pclsb__rail-btn--hives,
.pclsb__tab--hives {
  --pclsb-tab-accent: var(--warn, #fbbf24);
}
.pclsb__rail-btn--overwatch,
.pclsb__tab--overwatch {
  --pclsb-tab-accent: #f87171;
}
.pclsb__rail-btn--voice,
.pclsb__tab--voice,
.pclsb__rail-btn--expand {
  --pclsb-tab-accent: var(--accent, #38bdf8);
}
.pclsb__rail-btn--swarm,
.pclsb__tab--swarm {
  --pclsb-tab-accent: var(--good, #4ade80);
}
/* WI-4800 (owner ask 2026-07-14): the expand control is the TOPMOST rail
   button and the mirror of the collapse chevron — so it wears the muted
   .pclsb__collapse-btn treatment (neutral, not an accent tab) and is set off
   from the tab icons below by a hairline, reading as the pane toggle. */
.pclsb__rail-btn--expand {
  border-color: var(--border, rgba(125, 211, 252, 0.22));
  background: var(--bg-3, rgba(255, 255, 255, 0.05));
  color: var(--fg-mute, #7f9bb4);
  margin-bottom: 6px;
  position: relative;
}
.pclsb__rail-btn--expand::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -8px;
  transform: translateX(-50%);
  width: 22px;
  height: 1px;
  background: color-mix(in oklab, var(--border, rgba(125, 211, 252, 0.3)), transparent 15%);
}
.pclsb__rail-btn--expand:hover {
  color: var(--fg, #e7f7ff);
  border-color: var(--accent, #38bdf8);
  background: color-mix(in srgb, var(--accent, #38bdf8) 16%, transparent);
}

/* Header */
.pclsb__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-deep, #050d18), transparent 4%);
}
.pclsb__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 760;
  text-transform: uppercase;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb__title svg {
  color: var(--pclsb-current-accent);
}
.pclsb__spacer {
  flex: 1;
}
.pclsb__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-dim, #b9d4e8);
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb__iconbtn:hover {
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
  color: var(--fg, #e7f7ff);
}

/* Slim collapse row above the tabs — all that remains of the retired
   PapercupVoiceBar (WI-4740: the voice controls now live ONLY on the chat
   sidebar's header; the rail keeps just its own collapse affordance). */
.pclsb__collapse-row {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  padding: 5px 9px 0;
}
.pclsb__collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 6px;
  border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
  background: var(--bg-3, rgba(255, 255, 255, 0.05));
  color: var(--fg-mute, #7f9bb4);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.pclsb__collapse-btn:hover {
  color: var(--fg, #e7f7ff);
  border-color: var(--accent, #8b5cf6);
  background: color-mix(in srgb, var(--accent, #8b5cf6) 16%, transparent);
}

/* Tab strip — owner and fleet surfaces as compact accented tabs. */
.pclsb__tabs {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  padding: 8px 9px 7px;
  border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-deep, #050d18), transparent 18%);
}
/* Flat tab chips (WI-4789 — design docs § buttons): a uniform-radius tinted
   fill + 1px border. The old physical-tab shape (mixed 8/6 radius + a colored
   cap bar on EVERY tab) read as raised 3D tabs; the accent cap now marks only
   the ACTIVE tab. Per-tab accent colors stay (nav wayfinding carve-out). */
.pclsb__tab {
  --pclsb-tab-accent: var(--accent, #38bdf8);
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  min-height: 32px;
  padding: 7px 7px 6px;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid color-mix(in oklab, var(--pclsb-tab-accent), transparent 70%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), var(--bg-2, #0b1220) 92%);
  color: var(--fg-dim, #b9d4e8);
  font-size: 11.5px;
  font-weight: 720;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb__tab:hover {
  border-color: color-mix(in oklab, var(--pclsb-tab-accent), transparent 44%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), var(--bg-2, #0b1220) 84%);
  color: var(--fg, #e7f7ff);
}
.pclsb__tab.is-active {
  border-color: color-mix(in oklab, var(--pclsb-tab-accent), transparent 28%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), var(--bg-2, #0b1220) 76%);
  color: var(--fg, #e7f7ff);
}
.pclsb__tab.is-active::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: var(--pclsb-tab-accent);
}
.pclsb__tab-icon {
  position: relative;
  display: inline-flex;
  color: var(--pclsb-tab-accent);
  opacity: 0.96;
}
.pclsb__tab-label {
  position: relative;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Active panel body */
.pclsb__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 10px;
}

/* Drag-to-resize handle on the RIGHT edge (the rail is docked on the left). */
.pclsb__resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
  z-index: 4;
  touch-action: none;
}
.pclsb__resize-handle:hover {
  /* Flat drag-affordance tint (WI-4789 — no gradient). */
  background: color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 84%);
}
/* Docked pane document (/portal-panes/steering, framed by the cloud portal as
   one of ITS sidebars — owner ask 2026-09-01): the rail IS the page, so it
   flows in the document instead of pinning to the viewport, fills the frame,
   and drops the controls the portal now owns (collapse/expand, drag-resize).
   Kept as overrides on the same rules rather than a second stylesheet so the
   tab bodies render pixel-identical in both hosts. */
.pclsb.pclsb--docked {
  position: static;
  width: 100% !important;
  height: 100%;
  min-height: 100dvh;
  z-index: auto;
}
.pclsb.pclsb--docked .pclsb__collapse-row,
.pclsb.pclsb--docked .pclsb__expand-rail,
.pclsb.pclsb--docked .pclsb__resize-handle {
  display: none;
}
.pclsb[data-collapsed="true"] .pclsb__resize-handle {
  display: none;
}

/* Panel primitives — shared by the three tabs (mirrors pcdar-panel). */
.pclsb-panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 10px 12px;
}
.pclsb-panel__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}
.pclsb-panel__bar-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-panel__bar-spacer {
  flex: 1;
}
.pclsb-panel__empty {
  padding: 14px 10px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 36%);
  color: var(--fg-mute, #7f9bb4);
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}
/* EmptyState (components/ui/EmptyState.tsx) sub-elements — the container above
   provides the bordered, centered, muted shell; these style the optional
   icon / title / body slots. */
.pclsb-empty__icon {
  display: flex;
  justify-content: center;
  margin-bottom: 6px;
  color: var(--fg-mute, #7f9bb4);
  opacity: 0.7;
}
.pclsb-empty__title {
  font-size: 12px;
  font-weight: 680;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-empty__body {
  margin-top: 3px;
  font-size: 11px;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-panel__error {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--bad, #f87171), transparent 64%);
  background: color-mix(in oklab, var(--bad, #f87171), transparent 91%);
  color: color-mix(in oklab, var(--bad, #f87171), var(--fg, #e7f7ff) 32%);
  font-size: 12px;
  line-height: 1.5;
}
.pclsb-chipbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-dim, #b9d4e8);
  font-size: 11px;
  font-weight: 680;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-chipbtn:hover {
  border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg, #e7f7ff);
}
.pclsb-chipbtn.is-on {
  background: color-mix(in oklab, var(--pclsb-current-accent), transparent 84%);
  border-color: color-mix(in oklab, var(--pclsb-current-accent), transparent 48%);
  color: var(--fg, #e7f7ff);
}

/* Rows (agents / hives / tasks / mail) */
.pclsb-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 11px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 28%);
  cursor: default;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-row + .pclsb-row {
  margin-top: 5px;
}
.pclsb-row.is-clickable {
  cursor: pointer;
}
.pclsb-row.is-clickable:hover {
  border-color: color-mix(in oklab, var(--pclsb-current-accent), transparent 58%);
  background: color-mix(in oklab, var(--pclsb-current-accent), transparent 92%);
}
/* Selected = tinted fill + stronger border (flat — design docs § buttons; the
   old inset accent stripe read as an embossed edge, WI-4789). */
.pclsb-row.is-selected {
  border-color: color-mix(in oklab, var(--pclsb-current-accent), transparent 36%);
  background: color-mix(in oklab, var(--pclsb-current-accent), transparent 86%);
}
.pclsb-row__main {
  flex: 1;
  min-width: 0;
}
.pclsb-row__title {
  font-size: 13px;
  font-weight: 680;
  color: var(--fg, #e7f7ff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pclsb-row__sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--fg-mute, #7f9bb4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pclsb-row__meta {
  margin-top: 2px;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  opacity: 0.85;
}
.pclsb-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--fg-mute, #7f9bb4);
}
/* Flat liveness dot — solid status fill, no halo (design docs § buttons:
   glows read as 3D; WI-4789). */
.pclsb-dot.is-up {
  background: var(--good, #4ade80);
}
.pclsb-dot.is-down {
  background: var(--bad, #f87171);
}
.pclsb-pill {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 7px;
  font-size: 10px;
  font-weight: 700;
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-pill--good {
  background: color-mix(in oklab, var(--good, #4ade80), transparent 85%);
  color: var(--good, #4ade80);
}
.pclsb-pill--warn {
  background: color-mix(in oklab, var(--warn, #fbbf24), transparent 85%);
  color: var(--warn, #fbbf24);
}
.pclsb-pill--bad {
  background: color-mix(in oklab, var(--bad, #f87171), transparent 85%);
  color: var(--bad, #f87171);
}
.pclsb-pill--neutral {
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg-dim, #b9d4e8);
}

/* Colony tab (SwarmTab) — agent icon, expandable agent row, inline expansion. */
.pclsb-agent + .pclsb-agent {
  margin-top: 5px;
}
/* Fleet grouping (WI-4463) — one section per fleet, tinted with the fleet's own
   accent (the fleetColor the roster stamps, same value the agents-running
   dropdown paints its groups with). The color arrives INLINE from the data, so
   these rules only carry layout + the neutral fallback; they must never hardcode
   a palette or the two surfaces would drift. */
.pclsb-fleet__head {
  justify-content: flex-start;
  text-transform: none;
  /* letter-spacing stays 0 (design-primitives lint) and the mono stack matches the
     rest of this file — there is no --mono token (css-tokens lint; --font-mono is the
     operator-app one, not defined in the vite bundle). */
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.pclsb-fleet__dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.pclsb-fleet__count {
  color: var(--fg-mute, #7f9bb4);
  font-weight: 600;
  opacity: 0.8;
}
.pclsb-row__icon {
  flex: 0 0 auto;
  font-size: 15px;
  line-height: 1;
}
.pclsb-row__chev {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  opacity: 0.7;
}
/* Colony agent rows: agent label + its intent INLINE on one line (was a title
   stacked over a subtitle, doubling every row's height). Scoped to .pclsb-agent
   so the shared .pclsb-row__* in Hives/other tabs keep their stacked layout. */
.pclsb-agent .pclsb-row { padding: 6px 9px; }
.pclsb-agent .pclsb-row__main { display: flex; align-items: baseline; gap: 6px; }
.pclsb-agent .pclsb-row__title { flex: 0 1 auto; }
.pclsb-agent .pclsb-row__sub { flex: 1 1 auto; margin-top: 0; }
.pclsb-expand {
  margin: 6px 0 2px 6px;
  padding: 8px 8px 9px 10px;
  border-left: 2px solid color-mix(in oklab, var(--pclsb-current-accent), transparent 35%);
  border-radius: 0 8px 8px 0;
  background: color-mix(in oklab, var(--bg-1, #0b1220), transparent 24%);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pclsb-expand__head {
  margin: 8px 0 2px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-expand__head:first-child {
  margin-top: 0;
}
.pclsb-expand__empty {
  padding: 2px 4px;
  font-size: 11px;
  font-style: italic;
  color: var(--fg-mute, #7f9bb4);
}

/* KVRow / DetailGrid (components/ui/KVRow.tsx) — a label→value detail list.
   DetailGrid is a <dl> stacking <div.pclsb-kv-row> rows, each holding a
   <dt> label (muted, left) and a <dd> value (mono, right). Mirrors .pcdar-kv. */
.pclsb-detail-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  font-size: 12px;
}
.pclsb-kv-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.pclsb-kv-row__label {
  flex: 0 0 auto;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-kv-row__value {
  flex: 1 1 auto;
  margin: 0;
  min-width: 0;
  color: var(--fg, #e7f7ff);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Per-hive start/stop control — a FLAT semantic pill matching this file's own
   .pclsb-pill--good/--bad idiom (and the design spec's flat-button rule): a 1px
   color-mix border over a tinted color-mix fill, semantic-colored text, hover
   deepens the fill only (no raised/lift treatment). start = --good, stop = --bad.
   Sized for the compact sidebar row. */
.pclsb-hivebtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 7px;
  border: 1px solid transparent;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-hivebtn:disabled {
  opacity: 0.55;
  cursor: default;
}
.pclsb-hivebtn--start {
  background: color-mix(in oklab, var(--good, #4ade80), transparent 85%);
  color: var(--good, #4ade80);
  border-color: color-mix(in oklab, var(--good, #4ade80), transparent 62%);
}
.pclsb-hivebtn--start:hover:not(:disabled) {
  background: color-mix(in oklab, var(--good, #4ade80), transparent 76%);
}
.pclsb-hivebtn--stop {
  background: color-mix(in oklab, var(--bad, #f87171), transparent 85%);
  color: var(--bad, #f87171);
  border-color: color-mix(in oklab, var(--bad, #f87171), transparent 62%);
}
.pclsb-hivebtn--stop:hover:not(:disabled) {
  background: color-mix(in oklab, var(--bad, #f87171), transparent 76%);
}

/* Section headers inside a tab (task list / plan progress / comms). */
.pclsb-sec {
  margin-top: 9px;
  padding: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 44%);
}
.pclsb-sec__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
  padding: 0 1px 7px;
}
.pclsb-linkrow {
  text-decoration: none;
}
.pclsb-linkrow:focus-visible {
  outline: 1px solid var(--accent, #38bdf8);
  outline-offset: -1px;
}
.pclsb-task {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 5px 6px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--fg-dim, #b9d4e8);
  border: 1px solid transparent;
}
.pclsb-task:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  border-color: var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
}
.pclsb-task__rank {
  flex: 0 0 28px;
  color: var(--fg-mute, #7f9bb4);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.pclsb-task__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pclsb-task__title {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-task__id {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-mute, #7f9bb4);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9.5px;
}
.pclsb-task__st {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--fg-dim, #b9d4e8);
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
}

/* Plan progress bars */
.pclsb-plan {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 6px;
  border-radius: 8px;
  font-size: 12px;
  border: 1px solid transparent;
}
.pclsb-plan:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  border-color: var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
}
.pclsb-plan__slug {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-plan__bar {
  flex: 0 0 58px;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  overflow: hidden;
}
.pclsb-plan__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--pclsb-current-accent);
}
.pclsb-plan__pct {
  flex: 0 0 32px;
  font-size: 10px;
  color: var(--fg-dim, #b9d4e8);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: right;
}
.pclsb-plan__nums {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Mail / conversation lines (comms view) */
.pclsb-mail {
  padding: 6px 7px;
  border-radius: 9px;
  font-size: 12px;
  color: var(--fg-dim, #b9d4e8);
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  border: 1px solid transparent;
}
.pclsb-mail:hover {
  border-color: var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
}
.pclsb-mail__meta {
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  margin-bottom: 2px;
}
.pclsb-mail__summary {
  display: block;
  color: var(--fg-dim, #b9d4e8);
  line-height: 1.35;
}

/* The Voice tab's video region wants the full panel height. */
.pclsb-voice {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.pclsb-voice__bar {
  padding: 8px 10px 2px;
}
.pclsb-voice__channels {
  margin: 6px 10px 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 34%);
  overflow: hidden;
}
.pclsb-voice__grid {
  flex: 1;
  min-height: 220px;
  margin: 0 10px 10px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: var(--bg-deep, #050d18);
  overflow: hidden;
}
.pclsb-voice__empty {
  margin: 10px;
  padding: 18px 14px;
}

/* OverwatchTab (overwatch supervisor panel) */
.pc-owsb { display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 16px; min-height: 0; }
.pc-owsb--empty { padding-top: 24px; }
.pc-owsb__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11.5px; line-height: 1.4; padding: 8px 2px; }
.pc-owsb__bar { display: flex; align-items: center; gap: 7px; padding: 8px 9px; border-radius: 9px; border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); background: var(--bg-2, rgba(255, 255, 255, 0.04)); }
.pc-owsb__bar[data-tone='good'] { border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.06); }
.pc-owsb__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
.pc-owsb__bar svg { color: var(--fg-dim, #b9d4e8); }
.pc-owsb__identity { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
/* State label + "Supervisor loop" subtitle INLINE (was stacked column). */
.pc-owsb__state { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.pc-owsb__title { flex: 0 0 auto; font-size: 12px; font-weight: 760;  text-transform: uppercase; color: var(--fg, #e7f7ff); }
.pc-owsb__subtitle { flex: 0 1 auto; min-width: 0; font-size: 9.5px; color: var(--fg-mute, #7f9bb4);  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-owsb__hive { font-size: 9.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4); padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 86px; flex-shrink: 1; }
.pc-owsb__toggle { display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; flex-shrink: 0; font-size: 9.5px; font-weight: 800;  text-transform: uppercase; min-width: 62px; padding: 4px 9px; border-radius: 999px; color: var(--fg, #e7f7ff); border: 1px solid var(--border, rgba(125, 211, 252, 0.3)); background: rgba(255, 255, 255, 0.05); }
.pc-owsb__toggle:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
.pc-owsb__toggle:disabled { opacity: 0.55; cursor: default; }
.pc-owsb__toggle[data-on='true'] { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.1); }
.pc-owsb__toggle[data-on='false'] { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.5); background: rgba(52, 211, 153, 0.1); }
.pc-owsb__toggle svg { display: block; }
.pc-owsb__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.pc-owsb__dot--good { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
.pc-owsb__dot--warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
.pc-owsb__dot--mute { background: #475569; }
.pc-owsb__metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
.pc-owsb__metric { min-width: 0; display: flex; align-items: center; gap: 6px; padding: 6px 7px; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: rgba(255, 255, 255, 0.025); }
.pc-owsb__metric-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--fg-mute, #7f9bb4); flex-shrink: 0; }
/* Metric label + value INLINE (was stacked column) — shorter metric pills. */
.pc-owsb__metric-copy { min-width: 0; display: flex; align-items: baseline; gap: 5px; }
.pc-owsb__metric-label { flex: 0 0 auto; font-size: 8.5px; font-weight: 760; text-transform: uppercase;  color: var(--fg-mute, #7f9bb4); }
.pc-owsb__metric-value { flex: 1; min-width: 0; text-align: right; font-size: 10.5px; font-weight: 720; color: var(--fg-dim, #b9d4e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.pc-owsb__metric--good { border-color: rgba(52, 211, 153, 0.28); background: rgba(52, 211, 153, 0.055); }
.pc-owsb__metric--good .pc-owsb__metric-value, .pc-owsb__metric--good .pc-owsb__metric-icon { color: #6ee7b7; }
.pc-owsb__metric--warn { border-color: rgba(251, 191, 36, 0.3); background: rgba(251, 191, 36, 0.06); }
.pc-owsb__metric--warn .pc-owsb__metric-value, .pc-owsb__metric--warn .pc-owsb__metric-icon { color: #fcd34d; }
.pc-owsb__metric--bad { border-color: rgba(244, 63, 94, 0.34); background: rgba(244, 63, 94, 0.065); }
.pc-owsb__metric--bad .pc-owsb__metric-value, .pc-owsb__metric--bad .pc-owsb__metric-icon { color: #fca5a5; }
.pc-owsb__metric--mute .pc-owsb__metric-value { color: var(--fg-dim, #b9d4e8); }
.pc-owsb__empty-title { font-size: 10.5px; font-weight: 760;  text-transform: uppercase; color: var(--fg, #e7f7ff); }
.pc-owsb__err { font-size: 10.5px; line-height: 1.35; color: #fca5a5; padding: 6px 9px; border-radius: 8px; border: 1px solid rgba(244, 63, 94, 0.4); background: rgba(244, 63, 94, 0.08); }
.pc-owsb__hint { font-size: 10px; line-height: 1.4; color: #fcd34d; padding: 6px 9px; border-radius: 8px; border: 1px solid rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.07); }
.pc-owsb__hint strong { color: #fde68a; font-weight: 760; }
.pc-owsb__section { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
.pc-owsb__section--empty { gap: 2px; }
.pc-owsb__section-head { display: flex; align-items: center; gap: 6px; }
.pc-owsb__section-head svg { color: var(--fg-mute, #7f9bb4); }
.pc-owsb__section-title { font-size: 10.5px; font-weight: 760;  text-transform: uppercase; color: var(--fg, #e7f7ff); }
.pc-owsb__counts { margin-left: auto; display: flex; gap: 4px; }
.pc-owsb__count { font-size: 9px; font-weight: 700; text-transform: uppercase;  padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4); }
.pc-owsb__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
.pc-owsb__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
.pc-owsb__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }
.pc-owsb__filters { display: flex; gap: 4px; flex-wrap: wrap; }
.pc-owsb__chip { font-size: 9px; font-weight: 700; text-transform: uppercase;  cursor: pointer; padding: 3px 8px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); background: var(--bg-3, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); }
.pc-owsb__chip:hover { color: var(--fg, #e7f7ff); border-color: var(--border-strong, rgba(125, 211, 252, 0.34)); }
.pc-owsb__chip--on { color: var(--fg, #e7f7ff); border-color: rgba(99, 102, 241, 0.6); background: rgba(99, 102, 241, 0.16); }
.pc-owsb__healthy { font-size: 11px; color: #6ee7b7; padding: 9px 10px; border-radius: 8px; border: 1px solid rgba(52, 211, 153, 0.3); background: rgba(52, 211, 153, 0.07); }
.pc-owsb__anoms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
.pc-owsb__anom { display: flex; flex-direction: column; gap: 5px; padding: 8px 9px; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); border-left: 3px solid var(--accent, #475569); background: rgba(255, 255, 255, 0.02); }
.pc-owsb__anom--bad { --accent: #f43f5e; background: rgba(244, 63, 94, 0.06); }
.pc-owsb__anom--warn { --accent: #fbbf24; background: rgba(251, 191, 36, 0.05); }
.pc-owsb__anom--mute { --accent: var(--accent, #38bdf8); }
.pc-owsb__anom-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pc-owsb__anom-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.pc-owsb__sev { font-size: 8.5px; font-weight: 800; text-transform: uppercase;  padding: 1px 6px; border-radius: 999px; }
.pc-owsb__sev--bad { color: #fca5a5; background: rgba(244, 63, 94, 0.16); }
.pc-owsb__sev--warn { color: #fcd34d; background: rgba(251, 191, 36, 0.16); }
.pc-owsb__sev--mute { color: var(--accent-soft, var(--fg-dim, #b9d4e8)); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%); }
.pc-owsb__kind { font-size: 10.5px; font-weight: 750; color: var(--fg, #e7f7ff); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pc-owsb__subject { flex-shrink: 0; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; color: var(--fg-mute, #7f9bb4); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pc-owsb__action { display: flex; align-items: center; gap: 7px; min-width: 0; padding-top: 2px; border-top: 1px solid color-mix(in oklab, var(--border, rgba(125, 211, 252, 0.18)), transparent 45%); }
.pc-owsb__verb { flex-shrink: 0; font-size: 8.5px; font-weight: 800;  padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.pc-owsb__verb--nudge { color: #818cf8; }
.pc-owsb__verb--observe { color: var(--accent, #38bdf8); }
.pc-owsb__verb--escalate { color: #fb7185; }
.pc-owsb__anom-detail { font-size: 11px; line-height: 1.35; color: var(--fg-dim, #b9d4e8); }
.pc-owsb__anom-msg { min-width: 0; font-size: 10.5px; line-height: 1.35; color: var(--fg-mute, #7f9bb4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-owsb__footnote { font-size: 10px; line-height: 1.4; color: var(--fg-mute, #7f9bb4); padding: 0 2px; }
.pc-owsb__footnote strong { color: var(--fg-dim, #b9d4e8); font-weight: 700; }

/* MugTab (steering panel) + MugHeartbeat + ModelTiersOverride */
.pc-queen { --queen-accent: var(--warn, #fbbf24); display: flex; flex-direction: column; gap: 8px; padding: 9px 9px 14px; min-height: 0; }
.pc-queen__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11px; padding: 7px 2px; }
/* Flex row (was a 4-col grid that wrapped the 5th child — Crown/identity/hive/
   spacer/reset — onto a 2nd row, the header glitch). As flex, the spacer's
   flex:1 finally works and everything sits on one line. */
.pc-queen__bar { display: flex; align-items: center; gap: 7px; padding: 2px 1px 4px; border-bottom: 1px solid color-mix(in srgb, var(--queen-accent), transparent 84%); }
.pc-queen__bar svg { flex: 0 0 auto; color: var(--queen-accent); }
/* Title + subtitle INLINE (was stacked column) — subtitle to the right, truncating. */
.pc-queen__identity { display: flex; flex: 0 1 auto; align-items: baseline; gap: 6px; min-width: 0; }
.pc-queen__title { flex: 0 0 auto; font-size: 13px; font-weight: 780;  color: var(--fg, #e7f7ff); line-height: 1.05; }
.pc-queen__subtitle { flex: 0 1 auto; min-width: 0; font-size: 10px; color: var(--fg-mute, #7f9bb4); line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__hive { font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4); padding: 2px 6px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); background: var(--bg-2, rgba(255, 255, 255, 0.04)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 94px; }
.pc-queen__spacer { flex: 1; }
.pc-queen__reset { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; white-space: nowrap; font-size: 10px; font-weight: 700;  padding: 4px 7px; border-radius: 6px; cursor: pointer; color: var(--accent-soft, #7dd3fc); background: color-mix(in srgb, var(--accent), transparent 93%); border: 1px solid color-mix(in srgb, var(--accent), transparent 68%); }
.pc-queen__reset:hover:not(:disabled) { color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--queen-accent), transparent 52%); }
.pc-queen__reset:disabled { opacity: 0.5; cursor: default; }
.pc-queen__reset:focus-visible, .pc-queen__btn:focus-visible, .pc-queen__chip:focus-visible, .pc-queen__check:focus-visible, .pc-queen__switch:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.pc-queen__lanes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
.pc-queen__lane { min-width: 0; min-height: 46px; display: flex; align-items: center; gap: 8px; padding: 7px 8px; text-align: left; cursor: pointer; color: var(--fg-dim, #b9d4e8); background: var(--bg-2, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); border-radius: 8px; }
.pc-queen__lane:hover { color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--accent), transparent 64%); background: color-mix(in srgb, var(--accent), transparent 94%); }
.pc-queen__lane[aria-selected='true'] { color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--accent), transparent 42%); background: color-mix(in srgb, var(--accent), transparent 90%); }
.pc-queen__lane:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.pc-queen__lane-icon { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border-radius: 7px; color: var(--fg-mute, #7f9bb4); background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); }
.pc-queen__lane[aria-selected='true'] .pc-queen__lane-icon { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.pc-queen__lane-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pc-queen__lane-label { font-size: 11px; font-weight: 760; line-height: 1; color: inherit; }
.pc-queen__lane-value { max-width: 100%; font-size: 9.5px; line-height: 1.1; color: var(--fg-mute, #7f9bb4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__lane[aria-selected='true'] .pc-queen__lane-value { color: var(--fg-dim, #b9d4e8); }
.pc-queen__panel { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.pc-queen__err { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #fca5a5; padding: 6px 9px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--bad, #f43f5e), transparent 58%); background: color-mix(in srgb, var(--bad, #f43f5e), transparent 90%); }
.pc-queen__section { display: flex; flex-direction: column; gap: 7px; padding: 8px 9px; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.04)), transparent 18%); }
.pc-queen__section--pause { border-color: color-mix(in srgb, var(--accent), transparent 72%); }
.pc-queen__section--paused { border-color: color-mix(in srgb, var(--warn), transparent 58%); background: color-mix(in srgb, var(--warn), transparent 95%); }
.pc-queen__section-head { display: flex; align-items: center; gap: 6px; }
.pc-queen__section-head svg { color: var(--fg-mute, #7f9bb4); }
.pc-queen__section-title { font-size: 11px; font-weight: 760;  color: var(--fg, #e7f7ff); }
.pc-queen__count { margin-left: auto; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); text-align: right; }
.pc-queen__btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 11.5px; font-weight: 720; padding: 7px 10px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.pc-queen__btn--block { width: 100%; }
.pc-queen__btn:disabled { opacity: 0.55; cursor: default; }
.pc-queen__btn--go { background: color-mix(in srgb, var(--accent), transparent 88%); color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--accent), transparent 54%); }
.pc-queen__btn--stop { background: color-mix(in srgb, var(--good, #34d399), transparent 86%); color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--good, #34d399), transparent 58%); }
.pc-queen__btn--save { background: color-mix(in srgb, var(--accent), transparent 86%); color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--accent), transparent 58%); }
.pc-queen__btn:hover:not(:disabled), .pc-queen__chip:hover:not(:disabled) { color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--accent), transparent 48%); background: color-mix(in srgb, var(--accent), transparent 90%); }
.pc-queen__chip { font-size: 10px; font-weight: 700; padding: 4px 8px; border-radius: 6px; cursor: pointer; color: var(--fg-dim, #b9d4e8); background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.22)); }
.pc-queen__chip:disabled { opacity: 0.5; cursor: default; }
.pc-queen__pausebadge { margin-left: auto; font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; color: var(--fg); border: 1px solid color-mix(in srgb, var(--good), transparent 58%); background: color-mix(in srgb, var(--good), transparent 90%); }
.pc-queen__pausebadge--on { color: var(--warn); border-color: color-mix(in srgb, var(--warn), transparent 50%); background: color-mix(in srgb, var(--warn), transparent 90%); }
.pc-queen__quick-pause { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.pc-queen__quick-pause .pc-queen__chip { min-width: 0; }
.pc-queen__pausefor { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pc-queen__duration { display: inline-flex; align-items: center; gap: 5px; min-height: 27px; padding: 2px 6px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-2); }
.pc-queen__presetlabel { font-size: 10px;  color: var(--fg-mute); }
.pc-queen__mins { width: 48px; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px; color: var(--fg); background: var(--bg); border: 1px solid var(--border-strong); }
.pc-queen__mins:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent), transparent 62%); }
.pc-queen__hint { font-size: 10px; line-height: 1.3; color: var(--fg-mute); }
.pc-queen__scope { font-size: 10.5px; line-height: 1.35; color: var(--fg-dim); padding: 6px 8px; border-radius: 7px; background: color-mix(in srgb, var(--accent), transparent 94%); border: 1px solid color-mix(in srgb, var(--accent), transparent 82%); }
.pc-queen__scope--restricted { color: var(--fg); background: color-mix(in srgb, var(--accent), transparent 93%); border-color: color-mix(in srgb, var(--accent), transparent 68%); }
.pc-queen__plans { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 260px; overflow-y: auto; }
.pc-queen__plan { display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-2); }
.pc-queen__plan--on { border-color: color-mix(in srgb, var(--accent), transparent 58%); background: color-mix(in srgb, var(--accent), transparent 93%); }
.pc-queen__planlabel { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.pc-queen__selection-label { cursor: pointer; min-height: 24px; }
.pc-queen__check { width: 14px; height: 14px; min-height: 14px; max-height: 14px; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; color: var(--accent-ink); background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: 4px; flex-shrink: 0; }
.pc-queen__check[data-state='checked'], .pc-queen__check[data-state='indeterminate'] { background: var(--accent); border-color: var(--accent); }
.pc-queen__check:disabled { cursor: default; opacity: 0.5; }
.pc-queen__check svg { width: 10px; height: 10px; }
.pc-queen__switch { position: relative; width: 30px; height: 17px; min-height: 17px; max-height: 17px; flex: 0 0 auto; padding: 0; border-radius: 999px; cursor: pointer; color: transparent; background: var(--bg-3); border: 1px solid var(--border-strong); transition: background 120ms ease, border-color 120ms ease; }
.pc-queen__switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--fg-mute); transition: transform 120ms ease, background 120ms ease; }
.pc-queen__switch[data-state='checked'] { background: color-mix(in srgb, var(--accent), transparent 18%); border-color: var(--accent); }
.pc-queen__switch[data-state='checked']::after { transform: translateX(13px); background: var(--accent-ink); }
.pc-queen__switch:disabled { cursor: default; opacity: 0.5; }
.pc-queen__switch svg { display: none; }
.pc-queen__setting-row { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.pc-queen__setting-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.pc-queen__planslug { font-size: 11.5px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__planstatus { flex-shrink: 0; font-size: 8.5px; font-weight: 700;  padding: 1px 6px; border-radius: 999px; color: var(--fg-mute); border: 1px solid var(--border); }
.pc-queen__planstatus[data-status='started'] { color: var(--good); border-color: color-mix(in srgb, var(--good), transparent 56%); }
.pc-queen__planstatus[data-status='active'] { color: var(--accent-soft); border-color: color-mix(in srgb, var(--accent), transparent 60%); }
.pc-queen__planstatus[data-status='stale'] { color: var(--bad); border-color: color-mix(in srgb, var(--bad), transparent 56%); }
.pc-queen__directive { width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: 11.5px; line-height: 1.4; min-height: 74px; padding: 7px 9px; border-radius: 7px; color: var(--fg); background: var(--bg); border: 1px solid var(--border-strong); }
.pc-queen__directive::placeholder { color: var(--fg-mute); }
.pc-queen__directive:focus { outline: none; border-color: color-mix(in srgb, var(--accent), transparent 42%); }
.pc-queen__directive-actions { display: flex; align-items: center; gap: 7px; }

/* MugHeartbeat (Mug status indicator) */
.pc-qh { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--qh-accent, var(--border)); background: var(--bg-2); }
.pc-qh--live { --qh-accent: color-mix(in srgb, var(--good), transparent 45%); background: color-mix(in srgb, var(--good), transparent 91%); }
.pc-qh--ok { --qh-accent: color-mix(in srgb, var(--good), transparent 60%); background: color-mix(in srgb, var(--good), transparent 94.5%); }
.pc-qh--warn { --qh-accent: color-mix(in srgb, var(--warn), transparent 50%); background: color-mix(in srgb, var(--warn), transparent 92%); }
.pc-qh--mute { --qh-accent: color-mix(in oklab, var(--accent), transparent 82%); }
.pc-qh__top { display: flex; align-items: center; gap: 7px; }
.pc-qh__top svg { color: var(--warn); }
.pc-qh__dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.pc-qh__dot--live { background: var(--good); }
.pc-qh__dot--ok { background: var(--good); }
.pc-qh__dot--warn { background: var(--warn); }
.pc-qh__dot--mute { background: var(--fg-mute); }
.pc-qh__dot--pulse { animation: pc-qh-pulse 1.7s ease-in-out infinite; }
@keyframes pc-qh-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.82); } }
.pc-qh__state { font-size: 11.5px; font-weight: 760;  color: var(--fg); }
.pc-qh__slug { margin-left: auto; font-size: 9.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; }
.pc-qh__wakes { display: flex; gap: 10px; flex-wrap: wrap; }
.pc-qh__woke, .pc-qh__next { font-size: 10.5px; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.pc-qh__next { color: var(--fg-mute); }
.pc-qh__placements { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
.pc-qh__pchip { font-size: 9px; font-weight: 700; text-transform: uppercase;  padding: 1px 7px; border-radius: 999px; color: var(--fg-dim); border: 1px solid var(--border); background: var(--bg-2); }
.pc-qh__pchip--warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn), transparent 50%); }
.pc-qh__pchip--bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad), transparent 50%); }
.pc-qh__pchip--idle { color: var(--fg-mute); opacity: 0.8; }
.pc-qh__wi { font-size: 9px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--warn); padding: 1px 6px; border-radius: 5px; background: color-mix(in srgb, var(--warn), transparent 88%); border: 1px solid color-mix(in srgb, var(--warn), transparent 65%); }

/* ModelTiersOverride (model tier configuration) */
.pc-mt { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.pc-mt__row { display: grid; grid-template-columns: minmax(52px, 0.55fr) minmax(0, 1.45fr); align-items: center; gap: 8px; min-height: 34px; padding: 5px 7px; border-radius: 7px; border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(255, 255, 255, 0.02); transition: border-color 120ms ease, background 120ms ease; }
.pc-mt__row--on { border-color: color-mix(in srgb, var(--accent), transparent 52%); background: color-mix(in srgb, var(--accent), transparent 93%); }
.pc-mt__row--dirty { border-color: color-mix(in srgb, var(--accent), transparent 38%); background: color-mix(in srgb, var(--accent), transparent 91%); }
.pc-mt__name { min-width: 0; font-size: 10.5px; font-weight: 700; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
.pc-mt__control { min-width: 0; display: flex; align-items: center; gap: 5px; }
.pc-mt__spec { flex: 1; min-width: 0; height: 26px; box-sizing: border-box; font: inherit; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 3px 7px; border-radius: 5px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.28)); }
.pc-mt__spec:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent), transparent 60%); }
.pc-mt__spec--dirty { border-color: color-mix(in srgb, var(--accent), transparent 30%); }
.pc-mt__spec--invalid, .pc-mt__spec--invalid:focus { border-color: var(--bad); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bad), transparent 62%); }
.pc-mt__spec:disabled { opacity: 0.6; }
.pc-mt__actions { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; }
.pc-mt__action { width: 26px; height: 26px; min-height: 26px; flex: 0 0 26px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border-radius: 5px; cursor: pointer; }
.pc-mt__action--apply { color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
.pc-mt__action--apply:hover:not(:disabled) { filter: brightness(1.08); }
.pc-mt__action--discard { color: var(--fg-dim); background: transparent; border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.28)); }
.pc-mt__action--discard:hover:not(:disabled) { color: var(--fg); border-color: var(--accent); background: color-mix(in srgb, var(--accent), transparent 92%); }
.pc-mt__action:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.pc-mt__action:disabled { opacity: 0.42; cursor: default; }
.pc-mt__reset { width: 26px; height: 26px; min-height: 26px; flex: 0 0 26px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border-radius: 5px; cursor: pointer; color: var(--accent-soft); background: color-mix(in srgb, var(--accent), transparent 90%); border: 1px solid color-mix(in srgb, var(--accent), transparent 58%); }
.pc-mt__reset:hover:not(:disabled) { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.pc-mt__reset:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.pc-mt__reset:disabled { opacity: 0.5; cursor: default; }

/* ThrottleSection + AutonomySurfacing (queen-steering-panel P-007 / P-009) */
.pc-queen__collapse { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0; background: none; border: none; cursor: pointer; text-align: left; color: inherit; font: inherit; }
.pc-queen__collapse svg { color: var(--fg-mute, #7f9bb4); flex-shrink: 0; }
.pc-queen__collapse:hover .pc-queen__section-title { color: var(--fg, #e7f7ff); }
.pc-queen__collapse:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; border-radius: 5px; }
.pc-queen__count--on { color: var(--accent-soft); font-weight: 700; }
.pc-queen__chip--on { color: var(--fg, #e7f7ff); background: color-mix(in srgb, var(--accent), transparent 84%); border-color: color-mix(in srgb, var(--accent), transparent 46%); }
.pc-queen__knobs { display: flex; flex-direction: column; gap: 9px; }
.pc-queen__knob { display: flex; flex-direction: column; gap: 5px; }
.pc-queen__knob + .pc-queen__knob { padding-top: 9px; border-top: 1px solid var(--border); }
.pc-queen__knob--custom { padding-left: 7px; box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent), transparent 24%); background: linear-gradient(90deg, color-mix(in srgb, var(--accent), transparent 95%), transparent 72%); }
.pc-queen__knobhead { display: flex; align-items: center; gap: 6px; }
.pc-queen__knobhead svg { color: var(--fg-mute, #7f9bb4); flex-shrink: 0; }
.pc-queen__knoblabel { font-size: 11px; font-weight: 700; color: var(--fg, #e7f7ff); }
/* When a knob head hosts the shared <OverridableSetting> (badgeStyle="inline"),
 * let it grow to fill the head so the badge's margin-left:auto right-aligns it
 * exactly like the old .pc-queen__knobbadge. */
.pc-queen__knobhead .pc-override { flex: 1; min-width: 0; }
.pc-queen__knobbadge { margin-left: auto; font-size: 8px; font-weight: 800; text-transform: uppercase;  padding: 1px 6px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); }
.pc-queen__knobbadge--on { color: var(--accent-soft); border-color: color-mix(in srgb, var(--accent), transparent 50%); background: color-mix(in srgb, var(--accent), transparent 90%); }
.pc-queen__knobreset { margin-left: auto; width: 22px; height: 22px; min-height: 22px; flex: 0 0 22px; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; color: var(--accent-soft); background: color-mix(in srgb, var(--accent), transparent 91%); border: 1px solid color-mix(in srgb, var(--accent), transparent 62%); border-radius: 5px; }
.pc-queen__knobreset:hover:not(:disabled) { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.pc-queen__knobreset:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.pc-queen__knobreset:disabled { opacity: 0.5; cursor: default; }
.pc-queen__knobrow { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.pc-queen__presetrow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.pc-queen__presetrow .pc-queen__chip { justify-content: center; padding-inline: 4px; }
.pc-queen__custom-number { display: flex; align-items: center; gap: 6px; width: fit-content; font-size: 10.5px; color: var(--fg-mute); cursor: text; }
.pc-queen__draftnum { display: inline-flex; align-items: center; gap: 5px; }
.pc-queen__num { width: 62px; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); }
.pc-queen__num--minutes { width: 58px; }
.pc-queen__num:focus { outline: none; border-color: color-mix(in srgb, var(--accent), transparent 35%); }
.pc-queen__num--dirty { border-color: color-mix(in srgb, var(--accent), transparent 30%); }
.pc-queen__num--invalid, .pc-queen__num--invalid:focus { border-color: var(--bad); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bad), transparent 62%); }
.pc-queen__num:disabled { opacity: 0.6; }
.pc-queen__select { width: 100%; font: inherit; font-size: 11.5px; padding: 5px 7px; border-radius: 6px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); cursor: pointer; }
.pc-queen__select:focus { outline: none; border-color: color-mix(in srgb, var(--accent), transparent 35%); }
.pc-queen__select:disabled { opacity: 0.6; cursor: default; }
.pc-queen__toggles { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.pc-queen__toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg, #e7f7ff); cursor: pointer; }
.pc-queen__toggle--off { color: var(--fg-mute, #7f9bb4); }
.pc-queen__toggle--row { width: 100%; justify-content: space-between; }
.pc-queen__seg { display: flex; flex-wrap: wrap; gap: 4px; }
.pc-queen__autonomy { display: flex; flex-direction: column; gap: 5px; padding: 7px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-2); }
.pc-queen__autonomy--on { border-color: color-mix(in srgb, var(--accent), transparent 68%); background: color-mix(in srgb, var(--accent), transparent 95%); }
.pc-queen__autonomy-meter { width: 100%; height: 5px; overflow: hidden; border-radius: 999px; background: var(--bg-3); }
.pc-queen__autonomy-meter > span { display: block; height: 100%; border-radius: inherit; background: var(--fg-mute); transition: width 180ms ease; }
.pc-queen__autonomy--on .pc-queen__autonomy-meter > span { background: var(--accent); }
.pc-queen__autonomy-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 9.5px; color: var(--fg-mute); }
.pc-queen__stat { display: flex; align-items: baseline; gap: 6px; padding: 7px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-2); color: var(--fg-mute); font-size: 10.5px; }
.pc-queen__stat strong { font-size: 17px; line-height: 1; color: var(--fg); font-variant-numeric: tabular-nums; }
.pc-queen__catlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 168px; overflow-y: auto; }
.pc-queen__cat { display: flex; align-items: center; gap: 7px; padding: 3px 7px; border-radius: 6px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border, rgba(125, 211, 252, 0.1)); }
.pc-queen__cat--more { justify-content: center; color: var(--fg-mute, #7f9bb4); font-size: 10px; background: none; border: none; }
.pc-queen__catlabel { flex: 1; min-width: 0; font-size: 11px; color: var(--fg-dim, #b9d4e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__catceil { flex-shrink: 0; font-size: 8.5px; font-weight: 700; text-transform: uppercase;  padding: 1px 6px; border-radius: 999px; color: var(--accent-soft, #7dd3fc); border: 1px solid color-mix(in srgb, var(--accent), transparent 60%); }

/* AccountsTab (account-pool panel). The rules themselves MOVED to
   @papercusp/operator-ui (WI-2143109) so the cloud portal mounts the identical
   panel instead of framing this app; interpolated here so this rail keeps ONE
   sheet and the two hosts cannot drift apart. */
${ACCOUNTS_TAB_CSS}

/* ── Automation panes (Blender / Docs / Agents) — scheduled-agent visibility ──
   Owner ask 2026-07-25, restyled the same day to MODEL THE MUG TAB (owner round 2:
   "improve the design of the blender and docs tab so it more closely models the mug
   tab design"). The bar / lane-strip / panel metrics below are deliberately the
   same numbers as their .pc-queen__* counterparts — these panes are siblings in one
   rail, so they must read as one family, and a lane strip keeps the spend number
   (the thing the owner came for) out of the bottom of a long scroll.

   The one place this pane INTENTIONALLY diverges is colour: --warn carries "this
   can spend money", because that is this surface's entire reason to exist.

   Tokens here stay inside the audited operator vocabulary (--bg-2/--bg-3/--fg/
   --fg-mute/--border/--accent/--warn/--bad), matching the .pc-queen__* block this
   mirrors. The previous revision reached for --bg-elev-hover, which NOTHING
   defines (its sibling --bg-elev is real — globals.css defines it as
   var(--bg-raised) — but the -hover variant was never declared). That reds
   app/_lints/css-tokens.test.ts and, with the letter-spacing below, was blocking
   the whole fleet's unit gate. Beware the shape of this mistake: a var() fallback
   makes an undeclared token LOOK fine locally, so only the lint catches it. */
.pc-auto { display: flex; flex-direction: column; gap: 9px; min-height: 0; overflow-y: auto; }

/* 1 — header bar (mirrors .pc-queen__bar) */
.pc-auto__bar { display: flex; align-items: center; gap: 7px; padding: 2px 1px 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent), transparent 84%); }
.pc-auto__bar svg { flex: 0 0 auto; color: var(--accent); }
.pc-auto__identity { display: flex; flex: 0 1 auto; align-items: baseline; gap: 6px; min-width: 0; }
.pc-auto__title { flex: 0 0 auto; font-size: 13px; font-weight: 780; color: var(--fg, #e7f7ff); line-height: 1.05; }
.pc-auto__subtitle { flex: 0 1 auto; min-width: 0; font-size: 10px; color: var(--fg-mute, #7f9bb4);
  line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-auto__scope { font-size: 10px; color: var(--fg-mute, #7f9bb4); padding: 2px 6px; border-radius: 999px;
  border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
  white-space: nowrap; }
.pc-auto__spacer { flex: 1; }
/* The whole-pane action — "Pause all" / "Resume all" (owner ask 2026-07-26:
   "the pause and start buttons ... don't look like pause/start buttons").
   FOURTH pass. Rounds 2 and 3 both answered the wrong question: each one made
   this match a sibling BUTTON idiom (.pc-queen__btn — tinted fill, 7px radius,
   11.5/720 type) instead of making it look like a TRANSPORT CONTROL, which is
   what the owner has been asking for the whole time. Matching another chip is
   not the fix; do not reach for that answer a fourth time.
   What changed, and why each part:
     • the glyph is now SOLID (fill="currentColor" on the same lucide icons).
       It was stroke-only — a hollow triangle and two hairline bars at 11px —
       and an outline at that size reads as a small mark, not a button face.
     • the glyph gets its own tinted DISC inside the pill, so the control reads
       as "transport button + label" rather than "chip with a decoration".
     • colour carries ONE meaning per hue across this whole pane now:
       GOOD/green = start, WARN/amber = pause. This deliberately SUPERSEDES the
       2026-07-25 rule that made "Pause all" green to mirror .pc-queen__btn--stop
       (owner decision 2026-07-26): green meant STOP here while green on a row
       toggle two lines below meant START — the same hue, opposite verbs, in one
       pane. The pill body is now neutral and only the disc is tinted, so the
       header no longer competes with the rows for attention either.
   ⚠ display is BLOCK and the row layout lives on .pc-auto__action-inner. See
   the WebKitGTK note on .pc-auto__toggle below — the old inline-flex here also
   silently dropped this button's icon/label gap on the desktop. */
.pc-auto__action { display: block; flex-shrink: 0; white-space: nowrap;
  font: inherit; font-size: 11.5px; font-weight: 720;
  padding: 4px 10px 4px 4px; border-radius: 999px; cursor: pointer;
  color: var(--fg, #e7f7ff);
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32)); }
.pc-auto__action-inner { display: flex; align-items: center; justify-content: center; gap: 6px; }
.pc-auto__action-dot { display: flex; align-items: center; justify-content: center; flex: none;
  width: 17px; height: 17px; border-radius: 999px; }
.pc-auto__action-dot svg { display: block; }
/* "Resume all" — the GO action. Green disc; the triangle is nudged right by a
   half pixel because a triangle's visual mass sits left of its bounding box. */
.pc-auto__action--go .pc-auto__action-dot { color: var(--good, #34d399);
  background: color-mix(in srgb, var(--good, #34d399), transparent 78%); }
.pc-auto__action--go .pc-auto__action-dot svg { transform: translateX(0.5px); }
/* "Pause all" — the STOP action. Amber, not red: pausing your own agents is a
   normal, reversible control, not an alarm. */
.pc-auto__action--stop .pc-auto__action-dot { color: var(--warn, #fbbf24);
  background: color-mix(in srgb, var(--warn, #fbbf24), transparent 80%); }
.pc-auto__action:hover:not(:disabled) { color: var(--fg, #e7f7ff);
  border-color: color-mix(in srgb, var(--accent), transparent 44%);
  background: var(--bg-4, rgba(255, 255, 255, 0.12)); }
.pc-auto__action:disabled { opacity: 0.55; cursor: default; }
.pc-auto__action:focus-visible, .pc-auto__lane:focus-visible, .pc-auto__toggle:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; }

/* 2 — lane strip (mirrors .pc-queen__lanes) */
.pc-auto__lanes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
/* ⚠ display is BLOCK and the icon+copy row lives on .pc-auto__lane-inner:
   WebKitGTK (the Tauri webview) IGNORES flex set on a <button> element, so
   declaring the row here stacked the icon above the label on the real desktop
   while looking correct in Chromium (EI-18135716653974462 / WI-5581). Same fix
   as .pc-auto__toggle / .pc-auto__action below — do not move it back. */
.pc-auto__lane { min-width: 0; min-height: 46px; display: block;
  padding: 7px 8px; text-align: left; cursor: pointer; color: var(--fg-dim, #b9d4e8);
  background: var(--bg-2, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); border-radius: 8px; }
.pc-auto__lane-inner { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pc-auto__lane:hover { color: var(--fg, #e7f7ff);
  border-color: color-mix(in srgb, var(--accent), transparent 64%);
  background: color-mix(in srgb, var(--accent), transparent 94%); }
.pc-auto__lane[aria-selected='true'] { color: var(--fg, #e7f7ff);
  border-color: color-mix(in srgb, var(--accent), transparent 42%);
  background: color-mix(in srgb, var(--accent), transparent 90%); }
.pc-auto__lane-icon { width: 24px; height: 24px; display: inline-flex; align-items: center;
  justify-content: center; flex: 0 0 auto; border-radius: 7px; color: var(--fg-mute, #7f9bb4);
  background: var(--bg-3, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); }
.pc-auto__lane[aria-selected='true'] .pc-auto__lane-icon { color: var(--accent-ink);
  background: var(--accent); border-color: var(--accent); }
.pc-auto__lane-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pc-auto__lane-label { font-size: 11px; font-weight: 760; line-height: 1; color: inherit; }
.pc-auto__lane-value { max-width: 100%; font-size: 9.5px; line-height: 1.1; color: var(--fg-mute, #7f9bb4);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-auto__lane[aria-selected='true'] .pc-auto__lane-value { color: var(--fg-dim, #b9d4e8); }

/* 3 — panel (mirrors .pc-queen__panel) */
.pc-auto__panel { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.pc-auto__blurb { margin: 0; font-size: 11px; line-height: 1.4; color: var(--fg-mute, #7f9bb4); }
.pc-auto__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11px; padding: 7px 2px; }
.pc-auto__err { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg, #e7f7ff);
  padding: 6px 9px; border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--bad, #f43f5e), transparent 58%);
  background: color-mix(in srgb, var(--bad, #f43f5e), transparent 90%); }

/* DENSITY (owner ask 2026-07-25: "Make the routines view more compact so you can
   display more in same space then currently. Currently there is a lot of empty
   space on the cards."). The row was a 3-LINE stack — name / cadence+token flag /
   "last fired" — inside a padded card, so a routine cost ~46px of height and the
   right-hand third of every card was blank. It is now TWO lines: the name shares
   its line with the last-fired clock (right-aligned, where the empty space was),
   and cadence + token flag sit under it. ~30px per routine — roughly half again
   as many visible in the same pane. */
.pc-auto__list { display: flex; flex-direction: column; gap: 2px; }
.pc-auto__row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px;
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); opacity: 0.55; }
.pc-auto__row.is-active { opacity: 1; }
/* WI-6447: a row whose arm state we could not verify (external-process rows —
   live fire-state needs P-014 federation) must not render at the same weight as
   a confirmed-live one. Between the two: brighter than "off", dimmer than "on",
   so the row itself never asserts what only its meta line can qualify. */
.pc-auto__row.is-unverified { opacity: 0.78; }
.pc-auto__row-main { display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline; column-gap: 6px; row-gap: 0; min-width: 0; flex: 1; }
.pc-auto__name { font-size: 11.5px; font-weight: 600; color: var(--fg, #e7f7ff);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-auto__meta { grid-column: 1; display: flex; align-items: center; gap: 5px;
  font-size: 10px; line-height: 1.25; color: var(--fg-mute, #7f9bb4);
  min-width: 0; overflow: hidden; white-space: nowrap; }
.pc-auto__tokenflag { display: inline-flex; align-items: center; gap: 3px; font-weight: 600; flex: 0 0 auto;
  color: var(--warn, #f59e0b); background: color-mix(in srgb, var(--warn, #f59e0b), transparent 88%);
  padding: 0 4px; border-radius: 4px; }
/* Pulled up onto the name's line — this is the blank third the owner saw. */
.pc-auto__when { grid-column: 2; grid-row: 1; justify-self: end; flex: 0 0 auto;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 9.5px; color: var(--fg-mute, #7f9bb4); opacity: 0.8; white-space: nowrap; }

/* The pause/start control — a TRANSPORT button, not another chip.
   Owner ask 2026-07-26: "the pause and start buttons in the middle pane in the
   blender docs and agents tabs all don't look like pause/start buttons". This
   is the FOURTH time it has been raised, and rounds 2 and 3 both failed the same
   way: they restyled it to match a neighbouring BUTTON (.pc-queen__btn, the Mug
   tab's tinted chip) rather than making it read as a pause/start control. Three
   things were actually wrong — fix these, don't chase another chip:
     • THE GLYPHS WERE OUTLINES. lucide's <Play>/<Pause> render stroke-only, so
       at 12px this was a hollow triangle and two hairline bars. Every transport
       control ever built draws them SOLID; an outline that size reads as a small
       mark, not a button face. They are now filled — fill="currentColor" on the
       same lucide icons, so we stay on the design system's icon set.
     • THE SILHOUETTE WAS A CHIP. A 26x24 rounded rect is the same shape as the
       count and token-flag chips sitting inches away. It is now a 24px CIRCLE,
       which is what a transport button looks like everywhere else on earth.
     • COLOUR ARGUED WITH ITSELF. --good meant START here but STOP on the header
       action, and :hover forced BOTH states to --accent, so the green start
       button turned blue under the cursor. Colour now carries the VERB, one hue
       one meaning, pane-wide: GOOD/green = start, WARN/amber = pause. Hover
       deepens the button's OWN hue instead of flipping it to accent.
   Tint is always on (owner decision 2026-07-26, "Option B"): a paused routine
   reads as paused from across the pane without anyone reading a label.
   ⚠ display is BLOCK, and the centring flex lives on the inner .pc-auto__glyph
   span. WebKitGTK — the Tauri webview this actually ships in — IGNORES flex set
   on a <button> element, so the old inline-flex left the glyph uncentred on the
   real desktop while looking perfect in Chromium. That is the bug class of
   EI-18135716653974462 / WI-5581, the one the HUD board was migrated off after
   an owner-screenshotted regression. DO NOT move the flex back onto the button,
   and do not "verify" this control in a browser — a browser cannot see it. */
/* 26px, not 24: globals.css's :where(button, .pc-btn) baseline sets a
   min-height: 26px tap-target floor. A 24px height silently lost to it and
   rendered a 24x26 EGG rather than a circle — caught by measuring the real
   WebKitGTK webview, invisible in the unit tests. Match the floor instead of
   fighting it; if this ever needs to be smaller, raise it with the baseline,
   don't override min-height here. */
.pc-auto__toggle { display: block; flex: none; width: 26px; height: 26px; padding: 0;
  border-radius: 999px; cursor: pointer; font: inherit;
  color: var(--good, #34d399);
  background: color-mix(in srgb, var(--good, #34d399), transparent 86%);
  border: 1px solid color-mix(in srgb, var(--good, #34d399), transparent 50%); }
.pc-auto__toggle.is-on { color: var(--warn, #fbbf24);
  background: color-mix(in srgb, var(--warn, #fbbf24), transparent 88%);
  border-color: color-mix(in srgb, var(--warn, #fbbf24), transparent 56%); }
.pc-auto__toggle:hover:not(:disabled) {
  background: color-mix(in srgb, var(--good, #34d399), transparent 78%);
  border-color: color-mix(in srgb, var(--good, #34d399), transparent 38%); }
.pc-auto__toggle.is-on:hover:not(:disabled) {
  background: color-mix(in srgb, var(--warn, #fbbf24), transparent 80%);
  border-color: color-mix(in srgb, var(--warn, #fbbf24), transparent 44%); }
.pc-auto__toggle:disabled { opacity: 0.55; cursor: default; }
/* The inner span carries the centring — see the WebKitGTK note above. */
.pc-auto__glyph { display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%; }
.pc-auto__glyph svg { display: block; }
/* Optical centring: a triangle's visual mass sits left of its bounding box, so
   a mathematically-centred play glyph looks a hair too far left in a circle. */
.pc-auto__toggle[data-glyph='play'] .pc-auto__glyph svg { transform: translateX(0.5px); }
/* Busy keeps the CIRCLE. The old busy state swapped the glyph for a literal "…"
   text character, so mid-click the control stopped looking like a control at
   all — the one moment the owner most needs to see that the click landed. */
.pc-auto__spinner { width: 11px; height: 11px; border-radius: 999px;
  border: 1.6px solid color-mix(in srgb, currentColor, transparent 62%);
  border-top-color: currentColor; animation: pc-auto-spin 0.7s linear infinite; }
@keyframes pc-auto-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .pc-auto__spinner { animation-duration: 2.4s; } }

/* The "listed but not pausable from here" marker. Deliberately NOT built on
   .pc-auto__toggle: it must not read as a button the owner can press, because
   it isn't one — a DBOS workflow / managed timer / in-process sweep has no
   switch on this surface. Same footprint as the toggle so rows stay aligned,
   but flat, muted and non-interactive. */
/* Same 26px footprint as the toggle so controllable and uncontrollable rows
   stay aligned. This is a <span>, so it gets no min-height from the button
   baseline — the size has to be stated outright. */
.pc-auto__nocontrol { display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 26px; height: 26px; border-radius: 999px; cursor: default;
  color: var(--fg-mute, #7f9bb4); background: transparent;
  border: 1px dashed color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.22)), transparent 30%); }

.pc-auto__section { display: flex; flex-direction: column; gap: 4px; padding: 8px 9px; border-radius: 8px;
  border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.04)), transparent 18%); }
/* Sentence-case title, matching .pc-queen__section-title — the previous
   uppercase+letter-spacing treatment was both off-family and the second of the
   two lint reds this block was carrying (design-primitives: nonzero
   letter-spacing is not an approved app-UI primitive). */
.pc-auto__section-head { display: flex; align-items: center; gap: 6px; }
.pc-auto__section-head svg { color: var(--fg-mute, #7f9bb4); }
.pc-auto__section-title { font-size: 11px; font-weight: 760; color: var(--fg, #e7f7ff); }
.pc-auto__count { margin-left: auto; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); text-align: right;
  font-variant-numeric: tabular-nums; }

/* ── STATE BUCKETS (agents-system-pane-split-2026-07-26, mockup C) ──────────────
   The pane sorts by state, not subject: Needs-you / Spending-now (or Running) /
   Dormant. A bucket header is a BUTTON — clicking it folds the bucket — and the
   count stays visible while folded, because nothing here is hidden, only folded
   (the owner mandate "no routines that dont get surfaced" survives as a fold with
   a count and a one-click open, not as a filter that drops rows).

   ⚠ The layout lives on .pc-auto__section-inner, NOT on the <button>. WebKitGTK —
   the Tauri webview this actually ships in — IGNORES flex set on a <button>
   element, so a flex row declared on the button is silently dropped on the real
   desktop while looking perfect in Chromium (EI-18135716653974462 / WI-5581). Same
   rule as .pc-auto__toggle and .pc-auto__lane. Do not "simplify" this back onto
   the button, and do not verify it in a browser — a browser cannot see the bug. */
.pc-auto__section-head--btn { all: unset; display: block; width: 100%; cursor: pointer;
  border-radius: 6px; }
.pc-auto__section-head--btn:focus-visible { outline: 2px solid var(--accent, #38bdf8);
  outline-offset: 2px; }
.pc-auto__section-inner { display: flex; align-items: center; gap: 6px; width: 100%; }
.pc-auto__section-inner svg { color: var(--fg-mute, #7f9bb4); flex: 0 0 auto; }
.pc-auto__section-head--btn:hover .pc-auto__section-title { color: var(--accent, #38bdf8); }

/* Tone carries the bucket's meaning at a glance — a left rule, not a fill, so the
   rows inside keep their own tint. Semantic hues only; the accent stays the
   accent. */
.pc-auto__section--warn { border-left: 2px solid var(--warn, #f59e0b); }
.pc-auto__section--spend { border-left: 2px solid var(--accent, #38bdf8); }
.pc-auto__section--good { border-left: 2px solid var(--good, #22c55e); }
.pc-auto__section--mute { border-left: 2px solid var(--border, rgba(125, 211, 252, 0.14)); }
.pc-auto__section--warn .pc-auto__section-title { color: var(--warn, #f59e0b); }

/* A row the owner has to act on: stalled, or a flag-gated row that is off, or one
   whose target_role has no registered handler. Tinted so it reads from across the
   pane without anyone parsing a label. */
.pc-auto__row.is-attention { opacity: 1;
  background: color-mix(in srgb, var(--warn, #f59e0b), transparent 90%);
  box-shadow: inset 2px 0 0 var(--warn, #f59e0b); }

/* ── VIEW SWITCH — by state (default) vs by family ──────────────────────────── */
.pc-auto__views { display: flex; gap: 4px; }
.pc-auto__viewbtn { display: flex; align-items: center; gap: 4px; flex: 1;
  justify-content: center; padding: 3px 6px; border-radius: 6px; font-size: 10px;
  font-weight: 600; color: var(--fg-mute, #7f9bb4); cursor: pointer;
  border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); }
.pc-auto__viewbtn:hover { color: var(--fg, #e7f7ff);
  border-color: color-mix(in srgb, var(--accent), transparent 64%); }
.pc-auto__viewbtn[aria-selected='true'] { color: var(--fg, #e7f7ff);
  border-color: color-mix(in srgb, var(--accent), transparent 42%);
  background: color-mix(in srgb, var(--accent), transparent 90%); }

/* ── ROW PILLS — install fan-out, trigger kind, unregistered handler ───────────
   The "×19" pill is the collapsed per-pot fan-out (git-sync is ONE routine
   installed on 19 pots, not 19 schedules); "triggered" marks a row fired by an
   event rather than a clock; "no handler" marks a target_role nobody registered —
   a routine that fires and silently does nothing. All three are distinct from
   .pc-auto__tokenflag, which is about money. */
.pc-auto__pill { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto;
  font-size: 9px; font-weight: 600; padding: 0 4px; border-radius: 4px;
  color: var(--fg-mute, #7f9bb4); background: var(--bg-3, rgba(255, 255, 255, 0.05)); }
.pc-auto__pill--trigger { color: var(--accent, #38bdf8);
  background: color-mix(in srgb, var(--accent, #38bdf8), transparent 88%); }
.pc-auto__pill--unknown { color: var(--bad, #f43f5e);
  background: color-mix(in srgb, var(--bad, #f43f5e), transparent 88%); }

/* The stalled-loop roll-up inside Needs-you — one line standing for N identical
   problems with one remedy. Same button-layout rule as everything else here: the
   flex row lives on the INNER span, never on the <button> (WebKitGTK drops it). */
.pc-auto__rollup { all: unset; display: block; width: 100%; cursor: pointer; }
.pc-auto__rollup:focus-visible { outline: 2px solid var(--accent, #38bdf8); outline-offset: 2px; }
.pc-auto__rollup-inner { display: flex; align-items: center; gap: 5px; min-width: 0; }
.pc-auto__rollup-inner svg { color: var(--warn, #f59e0b); flex: 0 0 auto; }
.pc-auto__rollup-inner .pc-auto__meta { min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.pc-auto__spend-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px;
  align-items: baseline; font-size: 11px; }
.pc-auto__spend-role { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg, #e7f7ff); }
.pc-auto__spend-role em { font-style: normal; color: var(--fg-mute, #7f9bb4); }
.pc-auto__spend-turns { font-size: 10px; color: var(--fg-mute, #7f9bb4); }
.pc-auto__spend-usd { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--fg, #e7f7ff); }
.pc-auto__foot { display: flex; align-items: flex-start; gap: 4px; margin: 2px 0 0; font-size: 9.5px;
  line-height: 1.35; color: var(--fg-mute, #7f9bb4); }

/* ── GOAL mode's rail card (components/left-sidebar/GoalTab.tsx,
   goal-mode-2026-08-07 P-019). Its own namespace rather than more .pc-auto__*
   because the card is the first rail surface with a PROGRESS BAR, and a
   tripwire track sized for the 300px rail minimum is not reusable as a generic
   automation row.

   The two states that carry meaning are both attribute-driven, so the markup
   states them once and CSS reads them — no conditional class strings:
     [data-breached="true"]  a tripwire is AT or PAST its threshold
     [data-over="true"]      fleet spend has reached the ceiling
   Both are the moment a goal should stop, so they share one alarm colour. */
/* P-022 kickoff entry point. Styled explicitly because the operator baseline
   gives a bare button only font/color/cursor, so an unstyled one renders as a
   browser-default box in this dark rail. */
.pc-goal__start { display: inline-flex; align-items: center; gap: 4px; flex: none;
  padding: 2px 7px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0;
  border: 1px solid var(--accent-strong, #2b6f9c); border-radius: 5px;
  background: var(--bg-2, #10222f); color: var(--accent, #6fb6e8); cursor: pointer; }
.pc-goal__start:hover { border-color: var(--accent, #6fb6e8); color: var(--fg, #e7f7ff); }
/* Staging the draft happens in ANOTHER pane, so the rail confirms it here —
   otherwise the click looks like a no-op. */
.pc-goal__seeded { margin: 0 0 6px; font-size: 10px; line-height: 1.35;
  color: var(--good, #4ec9a5); }

.pc-goal__card { display: flex; flex-direction: column; gap: 5px; padding: 7px 8px;
  border: 1px solid var(--border-subtle, #1d3548); border-radius: 6px;
  background: var(--bg-raised, #0d1c27); }
/* A paused goal is still listed — it is the one the owner may need to resume —
   but it must not compete visually with what is actually running. */
.pc-goal__card[data-status="paused"] { opacity: 0.62; }
.pc-goal__head { display: flex; align-items: baseline; gap: 6px; }
.pc-goal__title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11.5px; font-weight: 600; color: var(--fg, #e7f7ff); }
.pc-goal__status { margin-left: auto; flex: none; font-size: 9px; text-transform: uppercase;
  letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
/* --good, not --ok: --ok is not in the operator token vocabulary, so it
   red-pins the css-tokens lint (and with it the whole fleet's green gate).
   Same fix, same reason as the .pclsb-acct__* block above — this one was a
   straggler the earlier sweep missed. (No backticks in this comment: the file
   is one tagged template literal, so a quoted identifier would close it.) */
.pc-goal__status[data-status="active"] { color: var(--good, #4ec9a5); }

.pc-goal__ends { display: flex; flex-direction: column; gap: 1px; }
.pc-goal__ends-label { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0;
  color: var(--fg-mute, #7f9bb4); }
.pc-goal__criterion { font-size: 10.5px; line-height: 1.35; color: var(--fg, #e7f7ff); }
/* A goal with no criterion cannot ever end, so the absence is rendered LOUDLY
   rather than as an empty line the eye skips. */
.pc-goal__criterion--missing { display: flex; align-items: center; gap: 4px;
  color: var(--warn, #e0a955); }

.pc-goal__wires { display: flex; flex-direction: column; gap: 3px; }
.pc-goal__wire { display: grid; grid-template-columns: minmax(0, 4.5rem) 1fr auto; gap: 6px;
  align-items: center; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); }
.pc-goal__wire-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-goal__wire-track { height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--border-subtle, #1d3548); }
.pc-goal__wire-fill { display: block; height: 100%; border-radius: 2px;
  background: var(--accent, #3f8fc9); }
.pc-goal__wire[data-breached="true"] .pc-goal__wire-fill { background: var(--warn, #e0a955); }
.pc-goal__wire[data-breached="true"] .pc-goal__wire-value { color: var(--warn, #e0a955); font-weight: 600; }
.pc-goal__wire-value { font-variant-numeric: tabular-nums; }

.pc-goal__meters { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.pc-goal__meter { display: inline-flex; align-items: baseline; gap: 4px; font-size: 9.5px;
  color: var(--fg-mute, #7f9bb4); }
.pc-goal__meter-value { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--fg, #e7f7ff); }
.pc-goal__meter-value em { font-style: normal; font-weight: 400; color: var(--fg-mute, #7f9bb4); }
.pc-goal__meter[data-over="true"] .pc-goal__meter-value { color: var(--warn, #e0a955); }
.pc-goal__meter--you { color: var(--accent, #3f8fc9); align-items: center; }
.pc-goal__meter--you .pc-goal__meter-value { color: var(--accent, #3f8fc9); }

.pc-goal__foot { display: flex; gap: 5px; font-size: 9px; color: var(--fg-mute, #7f9bb4); }

/* ── RailSection — the rail's shared collapsible section (components/left-sidebar/
   RailSection.tsx). Same disclosure idiom the Mug tab uses (.pc-queen__collapse),
   lifted out of that private namespace so the Pots tab and the automation panes can
   share it instead of forking it a fourth time. */
.pclsb-sect { display: flex; flex-direction: column; gap: 7px; padding: 7px 9px; border-radius: 8px;
  border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.04)), transparent 18%); }
.pclsb-sect__head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0;
  background: none; border: none; cursor: pointer; text-align: left; color: inherit; font: inherit; }
.pclsb-sect__head svg { color: var(--fg-mute, #7f9bb4); flex-shrink: 0; }
.pclsb-sect__head:hover .pclsb-sect__title { color: var(--fg, #e7f7ff); }
.pclsb-sect__head:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; border-radius: 5px; }
.pclsb-sect__title { font-size: 11px; font-weight: 760; color: var(--fg-dim, #b9d4e8); }
.pclsb-sect__summary { margin-left: auto; font-size: 9.5px; text-align: right; white-space: nowrap;
  color: var(--fg-mute, #7f9bb4); }
.pclsb-sect__summary--good { color: var(--good, #34d399); }
.pclsb-sect__summary--warn { color: var(--warn, #fbbf24); }
.pclsb-sect__summary--bad { color: var(--bad, #f87171); }
.pclsb-sect__body { display: flex; flex-direction: column; gap: 6px; }

/* ── Pots tab COMPACT density (owner ask 2026-07-25: "make the pots tab more
   compact so its easier to see the full list without scrolling"). Scoped to
   .pclsb-pots so only this tab tightens — the same targeted-override idiom
   .pclsb-agent uses above; the default row metrics other tabs rely on are
   untouched. Roughly a third of the vertical space per row. */
.pclsb-pots { gap: 5px; padding: 8px 10px 10px; }
.pclsb-pots .pclsb-panel__bar { min-height: 18px; }
.pclsb-pots .pclsb-row { padding: 5px 8px; border-radius: 7px; gap: 7px; }
.pclsb-pots .pclsb-row + .pclsb-row { margin-top: 3px; }
.pclsb-pots .pclsb-row__title { font-size: 11.5px; font-weight: 640; }
.pclsb-pots .pclsb-row__sub { margin-top: 1px; font-size: 10px; }
.pclsb-pots .pclsb-panel__empty { padding: 9px 10px; font-size: 11px; line-height: 1.45; }
/* The nested panels keep their own padding for the non-collapsible mounts; inside
   the Pots tab the RailSection already supplies it, so drop the double inset. */
.pclsb-pots .pclsb-sect .pclsb-panel { padding: 0; gap: 5px; }
/* P-077 INVERTED THE NESTING. The Pots tab is gone; its p2p roster now lives
   INSIDE a RailSection in the System tab, so the compact scope is the child
   rather than the ancestor and the rule above can no longer reach it. The
   section supplies the inset, so the roster contributes only its own column
   flow — same intent as the rule above, opposite direction. */
.pclsb-sect .pclsb-pots { padding: 0; display: flex; flex-direction: column; gap: 5px; }

/* ── Conversations tab (WI-5754) ─────────────────────────────────────────────
   The curated stream at rail width. Two modes in one column: a filtered LIST,
   and a DETAIL that replaces it (drill-in, not master-detail — there is no room
   for a second column at 300px).

   SOURCE COLOUR is the load-bearing decision here. /adv writes the source as a
   text pill ("Questions & discussions"); that pill alone would eat a third of a
   narrow row, so source identity moves to a 2px left stripe + a short label.
   The three hues are an ANALOGOUS SWEEP off the app accent — sky, indigo, teal
   — deliberately avoiding good/warn/bad, which stay reserved for STATE
   pills. A stripe must never be readable as a warning. */
.pclsb-conv {
  --conv-threads: var(--accent, #38bdf8);
  --conv-deliberations: #818cf8;
  --conv-agentchats: #2dd4bf;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* header bar */
.pclsb-conv__bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px 6px;
}
.pclsb-conv__bartitle {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-conv__count {
  margin-left: auto;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-conv__spacer { flex: 1; }
.pclsb-conv__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-height: 22px;
  flex: 0 0 auto;
  border-radius: 7px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-mute, #7f9bb4);
  cursor: pointer;
  transition: color 120ms, border-color 120ms;
}
.pclsb-conv__chip:hover:not(:disabled) {
  color: var(--fg, #e7f7ff);
  border-color: var(--border-strong, rgba(125, 211, 252, 0.32));
}
.pclsb-conv__chip:disabled { opacity: 0.5; cursor: default; }

/* search */
.pclsb-conv__search {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 10px 7px;
  padding: 0 9px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-conv__search:focus-within {
  border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 50%);
}
.pclsb-conv__search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--fg, #e7f7ff);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.pclsb-conv__search input::placeholder { color: var(--fg-mute, #7f9bb4); }

/* source chips — horizontally scrollable so five never wrap at 300px */
.pclsb-conv__chips {
  flex: 0 0 auto;
  display: flex;
  gap: 5px;
  padding: 0 10px 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.pclsb-conv__chips::-webkit-scrollbar { display: none; }
.pclsb-conv__chipbtn {
  --chip: var(--fg-mute, #7f9bb4);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  min-height: 24px;
  padding: 3px 8px;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-dim, #b9d4e8);
  font-size: 11px;
  font-weight: 680;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-conv__chipbtn--all { --chip: var(--accent, #38bdf8); }
.pclsb-conv__chipbtn--threads { --chip: var(--conv-threads); }
.pclsb-conv__chipbtn--deliberations { --chip: var(--conv-deliberations); }
.pclsb-conv__chipbtn--agentchats { --chip: var(--conv-agentchats); }
.pclsb-conv__chipbtn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--chip);
  flex: 0 0 auto;
}
.pclsb-conv__chipbtn .ct {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
}
.pclsb-conv__chipbtn:hover {
  border-color: var(--border-strong, rgba(125, 211, 252, 0.32));
  color: var(--fg, #e7f7ff);
}
.pclsb-conv__chipbtn.is-on {
  background: color-mix(in oklab, var(--chip), transparent 86%);
  border-color: color-mix(in oklab, var(--chip), transparent 52%);
  color: var(--fg, #e7f7ff);
}

/* the three-line row */
.pclsb-conv__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 10px;
}
.pclsb-conv__row {
  --src: var(--conv-threads);
  position: relative;
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 9px 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 28%);
  cursor: pointer;
  transition: background 120ms, border-color 120ms;
}
.pclsb-conv__row + .pclsb-conv__row { margin-top: 5px; }
.pclsb-conv__row--threads { --src: var(--conv-threads); }
.pclsb-conv__row--deliberations { --src: var(--conv-deliberations); }
.pclsb-conv__row--agentchats { --src: var(--conv-agentchats); }
.pclsb-conv__row::before {
  content: "";
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--src);
}
.pclsb-conv__row:hover {
  border-color: color-mix(in oklab, var(--src), transparent 58%);
  background: color-mix(in oklab, var(--src), transparent 93%);
}
.pclsb-conv__row:focus-visible {
  outline: 1px solid color-mix(in oklab, var(--src), transparent 20%);
  outline-offset: -1px;
}
.pclsb-conv__top {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 3px;
}
.pclsb-conv__srcicon { color: var(--src); flex: 0 0 auto; }
.pclsb-conv__src {
  font-size: 9.5px;
  font-weight: 780;
  text-transform: uppercase;
  color: var(--src);
  white-space: nowrap;
}
.pclsb-conv__age {
  margin-left: auto;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.pclsb-conv__state {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 9.5px;
  font-weight: 700;
  white-space: nowrap;
}
.pclsb-conv__state.is-good {
  background: color-mix(in oklab, var(--good, #34d399), transparent 86%);
  color: var(--good, #34d399);
}
.pclsb-conv__state.is-warn {
  background: color-mix(in oklab, var(--warn, #fbbf24), transparent 86%);
  color: var(--warn, #fbbf24);
}
.pclsb-conv__state.is-neutral {
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-conv__title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--fg, #e7f7ff);
}
.pclsb-conv__meta {
  margin-top: 3px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  white-space: nowrap;
  overflow: hidden;
}
.pclsb-conv__meta span { overflow: hidden; text-overflow: ellipsis; }
.pclsb-conv__meta .sep { opacity: 0.4; flex: 0 0 auto; }
.pclsb-conv__meta .ref { color: var(--fg-dim, #b9d4e8); flex: 0 0 auto; }

/* detail mode */
.pclsb-conv__backrow {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px 7px;
  border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
}
.pclsb-conv__back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px 3px 6px;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-dim, #b9d4e8);
  font-size: 11px;
  font-weight: 680;
  cursor: pointer;
}
.pclsb-conv__back:hover {
  color: var(--fg, #e7f7ff);
  border-color: var(--border-strong, rgba(125, 211, 252, 0.32));
}
.pclsb-conv__detail {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 10px 14px;
}
.pclsb-conv__kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.pclsb-conv__detail .pclsb-conv__src { color: var(--accent, #38bdf8); }
.pclsb-conv__h {
  margin: 0 0 7px;
  font-size: 14px;
  font-weight: 680;
  line-height: 1.32;
  color: var(--fg, #e7f7ff);
  text-wrap: pretty;
}
.pclsb-conv__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 9px;
  margin-bottom: 9px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-conv__tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 9px; }
.pclsb-conv__tag {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg-dim, #b9d4e8);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
}
.pclsb-conv__body {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--fg-dim, #b9d4e8);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pclsb-conv__callout {
  --co: var(--good, #34d399);
  display: flex;
  gap: 8px;
  padding: 8px 9px;
  margin-bottom: 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--co), transparent 66%);
  background: color-mix(in oklab, var(--co), transparent 91%);
}
.pclsb-conv__callout.is-link { --co: var(--accent, #38bdf8); }
.pclsb-conv__callout > svg { color: var(--co); flex: 0 0 auto; margin-top: 1px; }
.pclsb-conv__callout b {
  display: block;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--co);
  margin-bottom: 3px;
}
.pclsb-conv__callout p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--fg-dim, #b9d4e8);
  overflow-wrap: anywhere;
}
.pclsb-conv__seclabel {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 12px 0 6px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-conv__seclabel::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
}
.pclsb-conv__post {
  padding: 7px 9px;
  border-radius: 9px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 34%);
}
.pclsb-conv__post + .pclsb-conv__post { margin-top: 5px; }
.pclsb-conv__post .who {
  display: flex;
  gap: 7px;
  align-items: baseline;
  margin-bottom: 3px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-conv__post .who b { color: var(--fg-dim, #b9d4e8); font-weight: 600; }
.pclsb-conv__post p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--fg-dim, #b9d4e8);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* transcript turns read as a dialogue: the operator's side keeps the source
   accent, the agent's is muted, so scanning a long transcript is possible
   without reading the role labels. */
.pclsb-conv__turn {
  border-left: 2px solid color-mix(in oklab, var(--conv-agentchats), transparent 55%);
}
.pclsb-conv__turn.is-agent {
  border-left-color: color-mix(in oklab, var(--fg-mute, #7f9bb4), transparent 60%);
}

/* reply composer (open questions only — composing a NEW question lives in the
   Agents tab, owner 2026-07-25) */
.pclsb-conv__replybox {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-deep, #050d18), transparent 25%);
}
.pclsb-conv__textarea {
  width: 100%;
  border-radius: 9px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg, #e7f7ff);
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  padding: 7px 9px;
  min-height: 46px;
  outline: none;
  resize: vertical;
}
.pclsb-conv__textarea:focus {
  border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 50%);
}
.pclsb-conv__crow { display: flex; gap: 6px; }
.pclsb-conv__btn {
  flex: 1;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-dim, #b9d4e8);
  font: inherit;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-conv__btn:hover:not(:disabled) {
  color: var(--fg, #e7f7ff);
  border-color: var(--border-strong, rgba(125, 211, 252, 0.32));
}
.pclsb-conv__btn:disabled { opacity: 0.5; cursor: default; }
.pclsb-conv__btn.is-primary {
  border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 52%);
  background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
  color: var(--fg, #e7f7ff);
}
.pclsb-conv__btn.is-good {
  border-color: color-mix(in oklab, var(--good, #34d399), transparent 58%);
  background: color-mix(in oklab, var(--good, #34d399), transparent 88%);
  color: var(--good, #34d399);
}

/* states */
.pclsb-conv__loading,
.pclsb-conv__empty {
  margin: 8px 0;
  padding: 10px;
  font-size: 11.5px;
  color: var(--fg-mute, #7f9bb4);
  text-align: center;
}
.pclsb-conv__blank {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin: 14px 0;
  padding: 18px 12px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 36%);
  text-align: center;
}
.pclsb-conv__blank > svg { color: var(--fg-mute, #7f9bb4); opacity: 0.6; }
.pclsb-conv__blank b { font-size: 12px; font-weight: 680; color: var(--fg-dim, #b9d4e8); }
.pclsb-conv__blank span { font-size: 11px; line-height: 1.5; color: var(--fg-mute, #7f9bb4); }
.pclsb-conv__error {
  margin: 10px 0;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--bad, #f87171), transparent 64%);
  background: color-mix(in oklab, var(--bad, #f87171), transparent 91%);
  color: color-mix(in oklab, var(--bad, #f87171), var(--fg, #e7f7ff) 32%);
  font-size: 11.5px;
  line-height: 1.5;
}
.pclsb-conv__error p { margin: 0 0 6px; }
.pclsb-conv__err {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: color-mix(in oklab, var(--bad, #f87171), var(--fg, #e7f7ff) 30%);
}
.pclsb-conv__readonly {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 9px 10px 11px;
  border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-deep, #050d18), transparent 25%);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-conv__readonly > svg { flex: 0 0 auto; }

/* ── Ask an agent (Agents tab, WI-5754) ──────────────────────────────────────
   Composing a question lives HERE, not in Conversations (owner 2026-07-25).
   A recipient is REQUIRED, so the send button stays disabled until one is
   chosen — the hint below it says why rather than letting the click fail. */
.pclsb-ask {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 10px 4px;
  padding: 9px 10px 11px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 40%);
}
.pclsb-ask__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-ask__title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
/* Collapsed, Ask is a single clickable row — the disclosure header IS the
   button, so the dense Routines lane pays one row for it. */
.pclsb-ask__head {
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  cursor: pointer;
}
.pclsb-ask__head:hover { color: var(--fg, #e7f7ff); }
.pclsb-ask__head:focus-visible { outline: 1px solid var(--accent, #38bdf8); outline-offset: 2px; border-radius: 6px; }
.pclsb-ask__chev { margin-left: auto; display: inline-flex; }
.pclsb-ask:not(.is-open) { gap: 0; padding: 7px 10px; }
.pclsb-ask__label {
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
  margin-top: 2px;
}
/* A bare <select>/<input>/<textarea> does NOT inherit the panel theme — every
   field is styled explicitly. */
.pclsb-select,
.pclsb-ask__input,
.pclsb-ask__textarea {
  width: 100%;
  border-radius: 9px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg, #e7f7ff);
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
  outline: none;
}
.pclsb-select { cursor: pointer; min-height: 28px; }
.pclsb-select:disabled { opacity: 0.6; cursor: default; }
.pclsb-ask__textarea { min-height: 54px; line-height: 1.45; resize: vertical; }
.pclsb-select:focus,
.pclsb-ask__input:focus,
.pclsb-ask__textarea:focus {
  border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 50%);
}
.pclsb-ask__input::placeholder,
.pclsb-ask__textarea::placeholder { color: var(--fg-mute, #7f9bb4); }
.pclsb-ask__send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  margin-top: 2px;
  border-radius: 9px;
  border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 52%);
  background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
  color: var(--fg, #e7f7ff);
  font: inherit;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 120ms, border-color 120ms;
}
.pclsb-ask__send:hover:not(:disabled) {
  background: color-mix(in oklab, var(--accent, #38bdf8), transparent 76%);
}
.pclsb-ask__send:disabled { opacity: 0.45; cursor: default; }
.pclsb-ask__hint,
.pclsb-ask__ok,
.pclsb-ask__err {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.45;
}
.pclsb-ask__hint { color: var(--fg-mute, #7f9bb4); }
.pclsb-ask__ok { color: var(--good, #34d399); }
.pclsb-ask__err { color: color-mix(in oklab, var(--bad, #f87171), var(--fg, #e7f7ff) 30%); }

`;
