/**
 * The roster's own CSS, as a string a host injects however it likes (a <style>
 * tag, a CSS-in-JS sink, or a build step that emits a stylesheet).
 *
 * Every colour is a CSS CUSTOM PROPERTY with a fallback, which is the whole
 * theming seam: a host that defines `--bg-1` / `--fg` / `--accent` / `--border`
 * gets its own palette with no fork. That is the owner's ask for the portal —
 * "the same code with a different theme".
 *
 * Deliberately EXCLUDES the host's popover/trigger chrome. The operator's pill
 * wrapper and popover surface are its own; only the roster's interior is shared.
 */
export const ROSTER_STYLES = `
      .pc-agents-roster { font-size: 12px; display: flex; flex-direction: column; min-height: 0; }
      .pc-agents-roster__tabs { display: flex; gap: 2px; padding: 4px 6px 0; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
      .pc-agents-roster__tab {
        font-size: 11px; padding: 3px 9px; border-radius: 6px 6px 0 0; cursor: pointer;
        background: transparent; color: var(--fg-mute); border: 1px solid transparent; border-bottom: none;
      }
      .pc-agents-roster__tab:hover { background: var(--bg-2); }
      .pc-agents-roster__tab.is-active { background: var(--bg-2); color: var(--fg); border-color: var(--border); }
      .pc-agents-roster__tab-count { color: var(--fg-mute); font-variant-numeric: tabular-nums; margin-left: 2px; }
      .pc-agents-roster__legend {
        display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 8px 6px;
        font-size: 10.5px; color: var(--fg-mute); border-bottom: 1px solid var(--border);
      }
      .pc-agents-roster__group { padding: 2px 0; }
      .pc-agents-roster__group-head {
        display: flex; align-items: baseline; gap: 4px; padding: 5px 8px 2px;
        font-weight: 600; font-size: 11.5px; color: var(--fg-mute);
      }
      .pc-agents-roster__group-count { font-weight: 400; color: var(--fg-mute); font-size: 10.5px; }
      .pc-agents-roster__row {
        /* Columns: [select checkbox][live dot+age][glyph][name][doing].
           The leading checkbox column is auto-width so it hugs the small box. The
           name column HUGS its content (max-content, capped via the name's own
           max-width) so a short id like "su-5577c" doesn't reserve a wide track and
           leave a big gap before the description — the description follows right
           after. The doing column takes the rest. The native checkbox input is the
           first grid item, so the template must carry the leading auto track for it
           or the row shatters (checkbox-less rows use --nocheck below, which drops
           it). */
        display: grid; grid-template-columns: auto max-content 16px minmax(40px, max-content) minmax(0, 1fr);
        align-items: center; gap: 8px; padding: 3px 8px; border-radius: 4px;
      }
      /* Rows WITHOUT the leading select checkbox — an inactive-session list, a
         search-result head, or a roster with no bulk actions — reuse this row for
         its look but render only 4 cells (age/glyph/name/doing). Using the
         5-column template above shifted every cell left by one and dumped the NAME
         into the fixed 16px glyph column, truncating it to a single letter. This
         modifier drops that leading checkbox track so the 4 cells land in their own
         columns. */
      .pc-agents-roster__row--nocheck {
        grid-template-columns: max-content 16px minmax(40px, max-content) minmax(0, 1fr);
      }
      .pc-agents-roster__row:hover { background: var(--bg-2); }
      .pc-agents-roster__row[data-liveness="stale"] { opacity: 0.5; }
      .pc-agents-roster__live { display: inline-flex; align-items: center; gap: 4px; }
      .pc-agents-roster__age {
        font-size: 9.5px; color: var(--fg-mute); font-variant-numeric: tabular-nums;
        line-height: 1; white-space: nowrap;
      }
      .pc-agents-roster__glyph { text-align: center; }
      .pc-agents-roster__name {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        max-width: 200px; /* caps the hugged name track; longer names ellipsize */
      }
      .pc-agents-roster__doing {
        color: var(--fg-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-agents-roster__feat {
        font-family: ui-monospace, monospace; font-size: 10px; margin-right: 6px;
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-agents-roster__scroll { max-height: 380px; overflow-y: auto; flex: 0 1 auto; min-height: 60px; }
      .pc-agents-roster__row { cursor: pointer; }
      .pc-agents-roster__row.is-pinned { background: color-mix(in oklab, var(--accent), transparent 82%); }
      .pc-agents-roster__detail { border-top: 1px solid var(--border); padding: 6px 8px; background: var(--bg-2); }
      .pc-agents-roster__detail-head { font-size: 12px; margin-bottom: 4px; }
      .pc-agents-roster__detail-fleet, .pc-agents-roster__detail-live, .pc-agents-roster__detail-pin {
        color: var(--fg-mute); font-weight: 400;
      }
      .pc-agents-roster__detail-grid {
        display: grid; grid-template-columns: 68px 1fr; gap: 2px 8px; margin: 0; font-size: 11.5px;
      }
      .pc-agents-roster__detail-grid dt { color: var(--fg-mute); }
      .pc-agents-roster__detail-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-agents-roster__inspect {
        margin-top: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
        background: var(--accent, #38bdf8); color: var(--accent-ink, #051827);
        border: 1px solid var(--accent, #38bdf8); border-radius: 4px; font-weight: 600;
      }
      .pc-agents-roster__nothinking {
        margin-top: 6px; font-size: 10.5px; color: var(--fg-mute); font-style: italic;
      }
      /* Selected-row indication: tinted background + a left accent bar. Placed
         AFTER :hover/.is-pinned so a selected row stays visibly selected on hover.
         An 18%-oklab tint read as "no selection indication" in the Tauri/WebKitGTK
         webview (too subtle on a near-black --bg-1), so this is stronger + srgb
         (broadest color-mix support). The 4px inset bar is the robust primary cue
         (no color-mix dependency); the tint is the secondary. */
      .pc-agents-roster__row.is-selected {
        background: color-mix(in srgb, var(--accent, #38bdf8) 30%, transparent);
        box-shadow: inset 4px 0 0 var(--accent, #38bdf8);
      }
      .pc-agents-roster__row.is-selected:hover {
        background: color-mix(in srgb, var(--accent, #38bdf8) 40%, transparent);
      }
      /* A REAL native accent checkbox. A Radix <button>+svg restyle could not
         reproduce the approved native look even deployed, so this is a native
         <input type=checkbox>: accent-color tints the browser's own check with the
         theme accent, and color-scheme follows the surface so the unchecked box
         renders for it instead of the browser default. */
      .pc-agents-roster__check {
        width: 13px; height: 13px; box-sizing: border-box;
        margin: 0; padding: 0; align-self: center; flex: 0 0 auto;
        accent-color: var(--accent, #38bdf8);
        color-scheme: var(--pc-roster-color-scheme, dark);
        cursor: pointer;
      }
      .pc-agents-roster__bulkbar {
        display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
        padding: 5px 8px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
        background: color-mix(in oklab, var(--accent), transparent 90%); font-size: 11px;
      }
      .pc-agents-roster__bulk-count { font-weight: 600; margin-right: 4px; }
      .pc-agents-roster__bulk-spacer { flex: 1 1 auto; }
      .pc-agents-roster__bulk-btn {
        font: inherit; font-size: 11px; cursor: pointer; padding: 2px 8px; line-height: 1.4;
        background: var(--bg-1); color: var(--fg); border: 1px solid var(--border); border-radius: 5px;
      }
      .pc-agents-roster__bulk-btn:hover { border-color: var(--accent, #38bdf8); }
      .pc-agents-roster__bulk-btn:disabled { opacity: 0.55; cursor: default; }
      .pc-agents-roster__bulk-btn--ghost { background: transparent; color: var(--fg-mute); }
      .pc-agents-roster__bulk-btn--danger { color: #e5484d; border-color: color-mix(in oklab, #e5484d, transparent 55%); }
      .pc-agents-roster__bulk-btn--danger.is-armed { background: #e5484d; color: #fff; border-color: #e5484d; font-weight: 600; }
      .pc-agents-roster__bulk-note { color: var(--fg-mute); margin-left: 2px; }
      .pc-agents-roster__compose { flex: 1 1 100%; display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
      .pc-agents-roster__compose-input {
        font: inherit; font-size: 11px; width: 100%; resize: vertical; box-sizing: border-box;
        background: var(--bg-1); color: var(--fg); border: 1px solid var(--border); border-radius: 5px; padding: 4px 6px;
      }
      .pc-agents-roster__compose-actions { display: flex; gap: 4px; }
`;

/**
 * The "View inactive sessions" section's CSS (WI-2047194) — a SEPARATE string so
 * a host that renders only the live roster pays nothing for it, and a host that
 * renders both injects both. Same theming seam as ROSTER_STYLES: every colour is
 * a custom property with a fallback.
 *
 * The section is a sticky FOOTER: pinned to the bottom of the host's popover so
 * the roster's hover detail strip appearing/disappearing above it never
 * displaces it, and it stays reachable without scrolling.
 */
export const INACTIVE_SESSIONS_STYLES = `
      .pc-agents-sessions__status { padding: 8px 10px; font-size: 11.5px; color: var(--fg-mute); font-style: italic; }
      .pc-agents-sessions__status.is-error { color: #d97757; }
      .pc-agents-sessions__scroll { max-height: 300px; overflow-y: auto; }
      .pc-agents-sessions__inactive {
        border-top: 1px solid var(--border-strong, var(--border)); margin-top: 4px;
        position: sticky; bottom: -4px; z-index: 2; background: var(--bg-1, #0b1525);
      }
      .pc-agents-sessions__toggle {
        width: 100%; text-align: left; font: inherit; font-size: 12px; font-weight: 600;
        padding: 8px 10px; cursor: pointer; display: flex; align-items: center; gap: 6px;
        background: transparent; color: var(--accent, #38bdf8); border: none; border-radius: 4px;
      }
      .pc-agents-sessions__toggle:hover { background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%); }
      .pc-agents-sessions__toggle-hint { margin-left: auto; font-weight: 400; font-size: 10.5px; color: var(--fg-mute); }
      .pc-agents-sessions__inactive-list { max-height: 260px; }
      .pc-agents-sessions__inactive .pc-agents-roster__row.is-unopenable { cursor: default; opacity: 0.75; }
`;
