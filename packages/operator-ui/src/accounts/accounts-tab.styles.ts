/**
 * The AccountsTab stylesheet — as a JS string, so it travels WITH the component.
 *
 * MOVED here verbatim from apps/operator-vite/.../left-sidebar.styles.ts, which
 * now interpolates this constant rather than holding its own copy. That is the
 * point: the tab is mounted in two apps (the operator's left sidebar and the
 * cloud portal's Accounts dock) and a second copy of these rules would drift
 * silently — the two surfaces would slowly stop looking like the same panel,
 * which is exactly the failure the extraction exists to prevent.
 *
 * Every rule is `.pclsb-acct*`-prefixed and every custom property carries a
 * literal fallback (var(--fg, #e7e7ea)), so the sheet renders correctly in a
 * host that does not define the operator's token set.
 *
 * ⚠ ONE TEMPLATE LITERAL: a stray backtick or ${ anywhere below — including
 * inside a comment — closes the string and the module stops parsing.
 */
export const ACCOUNTS_TAB_CSS = `
/* The panel is its own query container (see the @container rule at the bottom):
   it is mounted in hosts of different widths — the operator's drag-resizable
   rail and the portal's ~281px dock — so every width decision below has to be
   asked of THIS element, never of the window. */
.pclsb-acct { container: operator-panel / inline-size; display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 12px; font-size: 12px; color: var(--fg, #e7e7ea); }
.pclsb-acct__hero {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 8px 9px; border-radius: 8px;
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)) 88%, var(--accent, #8b5cf6) 12%);
  border: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 24%, var(--border, rgba(255, 255, 255, 0.12)));
}
.pclsb-acct__herotitle { display: flex; align-items: center; gap: 7px; min-width: 0; }
.pclsb-acct__herotitle svg { flex: 0 0 auto; color: var(--accent, #8b5cf6); }
.pclsb-acct__hero p { margin: 1px 0 0; font-size: 10.5px; line-height: 1.25; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__eyebrow { display: block; font-size: 9.5px; font-weight: 760;  text-transform: uppercase; color: var(--fg, #e7e7ea); }
.pclsb-acct__summary { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; }
.pclsb-acct__summary span {
  display: inline-flex; align-items: baseline; gap: 3px; min-width: 0; padding: 2px 5px; border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1)); background: var(--bg-2, rgba(255, 255, 255, 0.035));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9.5px; font-weight: 650; color: var(--fg-mute, #a6a6ad);
}
.pclsb-acct__summary b { color: var(--fg, #e7e7ea); font-variant-numeric: tabular-nums; }
.pclsb-acct__rule {
  padding: 5px 8px; border-radius: 7px; border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.035)) 82%, transparent);
  font-size: 10px; line-height: 1.25; color: var(--fg-mute, #a6a6ad);
}
.pclsb-acct__rule strong { color: var(--fg, #e7e7ea); font-weight: 700; }
.pclsb-acct__ovr { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #8b5cf6) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 35%, transparent); }
.pclsb-acct__ovrtext { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 3px 5px; font-size: 10px; line-height: 1.45; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__ovrtext > strong { color: var(--fg, #e7e7ea); font-size: 10.5px; }
.pclsb-acct__clear {
  flex: 0 0 auto; align-self: center; font-size: 10.5px; padding: 2px 7px; border-radius: 6px; cursor: pointer;
  color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 8%, transparent); border: 1px solid var(--accent, #8b5cf6);
}
.pclsb-acct__clear:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.pclsb-acct__row {
  display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-radius: 8px;
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.pclsb-acct__row--paused { border-color: color-mix(in srgb, var(--warn, #fbbf24) 35%, transparent); }
.pclsb-acct__row--off { opacity: 0.82; }
.pclsb-acct__row.is-forced { border-color: color-mix(in srgb, var(--accent, #8b5cf6) 42%, transparent); }
.pclsb-acct__row.is-excluded { border-color: color-mix(in srgb, var(--warn, #fbbf24) 42%, transparent); }
.pclsb-acct__top { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 4px 6px; }
.pclsb-acct__dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--fg-mute, #8a8a91); }
.pclsb-acct__dot--ok { background: var(--good, #34d399); }
.pclsb-acct__dot--paused { background: var(--warn, #fbbf24); }
.pclsb-acct__dot--off { background: var(--bad, #f87171); }
.pclsb-acct__name { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; align-items: flex-start;
  background: transparent; border: none; cursor: pointer; text-align: left; padding: 0; color: inherit; font: inherit; }
.pclsb-acct__labelrow { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; }
.pclsb-acct__label { font-size: 11.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.pclsb-acct__provider { flex: 0 0 auto; display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--fg-mute, #8a8a91) 34%, transparent); color: var(--fg-mute, #8a8a91); font-size: 8.5px; font-weight: 750; text-transform: uppercase; line-height: 1;  }
.pclsb-acct__provider--codex { color: var(--accent-cool, #c4b5fd); border-color: color-mix(in srgb, var(--accent, #8b5cf6) 45%, transparent); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__id { margin-top: -1px; font-size: 9.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__statuspill {
  justify-self: end; display: inline-flex; align-items: center; max-width: 82px; min-height: 18px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); background: var(--bg-3, rgba(255, 255, 255, 0.06));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; font-weight: 720; color: var(--fg-mute, #c2c2c9);
}
.pclsb-acct__statuspill--ok { color: var(--good, #34d399); border-color: color-mix(in srgb, var(--good, #34d399) 38%, transparent); background: color-mix(in srgb, var(--good, #34d399) 10%, transparent); }
.pclsb-acct__statuspill--paused { color: var(--warn, #fbbf24); border-color: color-mix(in srgb, var(--warn, #fbbf24) 38%, transparent); background: color-mix(in srgb, var(--warn, #fbbf24) 10%, transparent); }
.pclsb-acct__statuspill--off { color: var(--bad, #f87171); border-color: color-mix(in srgb, var(--bad, #f87171) 38%, transparent); background: color-mix(in srgb, var(--bad, #f87171) 10%, transparent); }
.pclsb-acct__btns { display: flex; gap: 3px; flex: 0 0 auto; align-items: center; justify-content: flex-end; }
.pclsb-acct__b {
  font-size: 10px; padding: 1px 6px; min-height: 19px; border-radius: 6px; cursor: pointer; color: var(--fg-mute, #c2c2c9);
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
}
.pclsb-acct__b:hover:not(:disabled) { color: var(--fg, #e7e7ea); border-color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__b:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__b.is-force { color: var(--accent, #8b5cf6); border-color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__b.is-excl { color: var(--warn, #fbbf24); border-color: var(--warn, #fbbf24); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); }
.pclsb-acct__expand { display: inline-flex; align-items: center; justify-content: center; padding: 1px; min-width: 18px; min-height: 18px; border-radius: 5px;
  background: transparent; border: none; cursor: pointer; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__expand:hover { color: var(--fg, #e7e7ea); }
.pclsb-acct__usage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 5px; font-size: 10px; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__meter {
  min-width: 0; display: grid; grid-template-columns: auto minmax(22px, 1fr) auto; align-items: center; gap: 4px;
  padding: 0; border-radius: 0; border: 0; background: transparent;
}
.pclsb-acct__meterlabel { font-size: 9px; font-weight: 720;  text-transform: uppercase; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__meter strong { font-size: 9.5px; color: var(--fg, #e7e7ea); font-variant-numeric: tabular-nums; }
.pclsb-acct__bar { height: 3px; overflow: hidden; border-radius: 999px; background: var(--bg-3, rgba(255, 255, 255, 0.07)); }
.pclsb-acct__bar span { display: block; height: 100%; border-radius: inherit; background: var(--fg-mute, #8a8a91); }
.pclsb-acct__meter--ok .pclsb-acct__bar span { background: var(--good, #34d399); }
.pclsb-acct__meter--warn .pclsb-acct__bar span { background: var(--warn, #fbbf24); }
.pclsb-acct__meter--hot .pclsb-acct__bar span { background: var(--bad, #f87171); }
.pclsb-acct__meterreset { grid-column: 2 / 4; margin-top: -2px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute, #77777f); font-size: 8.5px; }
.pclsb-acct__facts { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 5px; min-width: 0; font-size: 9.5px; line-height: 1.25; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__facts > span:not(.pclsb-acct__chip) { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pclsb-acct__facts > span:not(.pclsb-acct__chip)::after { content: "·"; margin-left: 5px; color: color-mix(in srgb, var(--fg-mute, #8a8a91) 45%, transparent); }
.pclsb-acct__facts > span:not(.pclsb-acct__chip):last-child::after { content: ""; margin-left: 0; }
.pclsb-acct__umute { color: var(--fg-mute, #8a8a91); }
.pclsb-acct__chip { display: inline-flex; padding: 0 5px; border-radius: 999px; font-size: 9px; font-weight: 650;
  background: var(--bg-3, rgba(255, 255, 255, 0.06)); color: var(--fg-mute, #c2c2c9); border: 1px solid var(--border, rgba(255, 255, 255, 0.1)); }
.pclsb-acct__chip.is-force { color: var(--accent, #8b5cf6); border-color: color-mix(in srgb, var(--accent, #8b5cf6) 45%, transparent); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__chip.is-excl { color: var(--warn, #fbbf24); border-color: color-mix(in srgb, var(--warn, #fbbf24) 45%, transparent); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); }
/* default-deploy-account-2026-08-08 P-006 — the account standing in for ~/.claude. Uses the
   positive/--good token rather than --accent so it reads as distinct from Force (allow-list),
   which is a different axis and sits in the same button row.
   (Was --ok, which is not in the operator token vocabulary and red-pinned the css-tokens
   lint; every sibling rule in this file already uses --good for exactly this green.) */
.pclsb-acct__chip.is-default { color: var(--good, #34d399); border-color: color-mix(in srgb, var(--good, #34d399) 45%, transparent); background: color-mix(in srgb, var(--good, #34d399) 12%, transparent); }
.pclsb-acct__b.is-default { color: var(--good, #34d399); border-color: var(--good, #34d399); background: color-mix(in srgb, var(--good, #34d399) 12%, transparent); }
.pclsb-acct__dflt { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 3px 7px; font-size: 10px; line-height: 1.35; color: var(--fg-mute, #c2c2c9); }
.pclsb-acct__dflt code { font-size: 9.5px; }
.pclsb-acct__detail { display: flex; flex-direction: column; gap: 6px; padding-top: 5px; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); }
.pclsb-acct__status { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--fg-mute, #c2c2c9); }
.pclsb-acct__status--ok { color: var(--good, #34d399); }
.pclsb-acct__status--paused { color: var(--warn, #fbbf24); }
.pclsb-acct__status--off { color: var(--bad, #f87171); }
.pclsb-acct__meta { display: flex; flex-direction: column; gap: 3px; margin: 0; }
.pclsb-acct__meta > div { display: grid; grid-template-columns: 58px 1fr; gap: 8px; align-items: baseline; }
.pclsb-acct__meta dt { margin: 0; font-size: 9.5px; text-transform: uppercase;  color: var(--fg-mute, #8a8a91); display: inline-flex; align-items: center; gap: 3px; }
.pclsb-acct__meta dd { margin: 0; font-size: 10.5px; color: var(--fg, #e7e7ea); min-width: 0; }
.pclsb-acct__bound { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.pclsb-acct__cred { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; color: var(--fg-mute, #a6a6ad);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }
.pclsb-acct__buckets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.pclsb-acct__buckets li { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.pclsb-acct__buckets code { font-size: 9.5px; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__reset {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; padding: 2px 7px; border-radius: 6px;
  cursor: pointer; color: var(--fg-mute, #c2c2c9); background: transparent; border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
}
.pclsb-acct__reset:hover:not(:disabled) { color: var(--fg, #e7e7ea); border-color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__reset:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__manage { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--accent, #8b5cf6);
  text-decoration: none; align-self: flex-start; }
.pclsb-acct__manage:hover { text-decoration: underline; }
.pclsb-acct__foot { margin: 0; font-size: 10px; line-height: 1.35; color: var(--fg-mute, #8a8a91); border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); padding-top: 7px; }
/* The narrow-pane reflow keys off THIS PANEL'S width, not the window's.
   It was @media (max-width: 300px) — which asks how wide the VIEWPORT is, a
   question this panel has never had a stake in. In the operator that query
   could only fire with the whole window under 300px (so: never, including
   when the rail is dragged narrow, which it is designed to be), and in the
   portal's 281px dock it stayed dead at a 1280px viewport while the row's
   name column collapsed to 10.8px and the account label overflowed across
   its neighbours. Measured, not guessed: grid-template-columns resolved to
   "10.8125px 26.5469px 169.234px". A container query asks the question that
   was always meant. */
@container operator-panel (max-width: 300px) {
  .pclsb-acct__top { grid-template-columns: minmax(0, 1fr) auto; }
  .pclsb-acct__btns { grid-column: 1 / -1; }
  .pclsb-acct__usage { grid-template-columns: 1fr; }
  .pclsb-acct__statuspill { justify-self: start; grid-column: 1 / -1; max-width: 100%; }
}
`;

/**
 * The ONE non-`.pclsb-acct` class AccountsTab renders: the shared empty/loading
 * panel box.
 *
 * Kept separate because the operator's left sidebar already defines it for
 * every OTHER tab in that rail — splicing it back in there would duplicate a
 * live rule. A host that mounts the tab on its own (the portal) injects this
 * alongside ACCOUNTS_TAB_CSS; the operator injects only ACCOUNTS_TAB_CSS.
 */
export const ACCOUNTS_TAB_BASE_CSS = `
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
`;
