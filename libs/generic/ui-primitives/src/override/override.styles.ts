/**
 * Styles for the shared <OverridableSetting> primitive, as a JS string (NOT a
 * `.css` import) — same rationale as left-sidebar.styles.ts: a `.css` import leaks
 * into the production sheet even from a lazy chunk; an injected `<style>` tree-shakes
 * with the module. <OverridableSetting> renders this once via OverridableSettingStyle.
 *
 * The `pc-override-*` family is the unification of the two existing badge looks:
 *  - `.pc-override-badge` (text-pill) mirrors `.pc-mt__badge` (ModelTiersOverride).
 *  - `badgeStyle="inline"` shifts it to a right-aligned knob badge that mirrors
 *    `.pc-queen__knobbadge` (ThrottleSection) via `.pc-override-badge--inline`.
 *  - `.pc-override-reset` mirrors `.pc-mt__reset`.
 * Visual values are kept in lockstep with left-sidebar.styles.ts so a migration of
 * the existing sections onto this primitive is byte-for-byte.
 */
export const OVERRIDE_CSS = `
.pc-override { display: flex; align-items: center; gap: 6px; }
.pc-override__label { flex-shrink: 0; font-size: 11px; font-weight: 700; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-override__control { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
.pc-override-badge { flex-shrink: 0; font-size: 8px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 5px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); }
.pc-override-badge--on { color: #c7d2fe; border-color: rgba(99, 102, 241, 0.5); background: rgba(99, 102, 241, 0.14); }
/* "inline" variant — the right-aligned knob badge (mirrors .pc-queen__knobbadge). */
.pc-override-badge--inline { margin-left: auto; padding: 1px 6px; }
.pc-override-badge--inline.pc-override-badge--on { color: #fcd34d; border-color: color-mix(in srgb, var(--queen-accent, #fbbf24), transparent 50%); background: color-mix(in srgb, var(--queen-accent, #fbbf24), transparent 88%); }
.pc-override-reset { flex-shrink: 0; font-size: 12px; line-height: 1; padding: 2px 5px; border-radius: 5px; cursor: pointer; color: var(--fg-dim, #b9d4e8); background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.22)); }
.pc-override-reset:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
.pc-override-reset:disabled { opacity: 0.6; cursor: default; }
`;
