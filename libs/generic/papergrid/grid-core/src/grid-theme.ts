/**
 * Visual theme for all grid components in @papercusp/grid.
 *
 * papergrid is brand-agnostic: it ships a NEUTRAL default palette and exposes
 * `configureGridColors()` so a host app can inject its own colours (e.g. derived
 * from design tokens). Both BulkOrderGrid (HTML table) and DataGridShell (Glide
 * canvas) read from the live `GRID_COLORS` object + the derived style bindings,
 * so a single `configureGridColors()` call at app start re-themes everything.
 *
 * The derived styles are `let` exports (ES module live bindings): when a host
 * calls `configureGridColors`, they are rebuilt and every importer sees the new
 * value with no call-site change.
 */
import type { Theme } from '@glideapps/glide-data-grid';

// ─── Palette shape ───────────────────────────────────────────────────────────

export interface GridColors {
  bg: string;
  headerBg: string;
  rowAlt: string;
  rowHover: string;
  border: string;
  text: string;
  muted: string;
  editBg: string;
  editBorder: string;
  amber: string;
  red: string;
  blue: string;
  green: string;
  font: string;
  monoFont: string;
}

/** Brand-neutral default — a generic dark grid. Hosts inject their own palette. */
const NEUTRAL: GridColors = {
  bg:         '#141414',
  headerBg:   '#0e0e0e',
  rowAlt:     '#1a1a1a',
  rowHover:   '#242424',
  border:     '#2e2e2e',
  text:       '#e6e6e6',
  muted:      '#8a8a8a',
  editBg:     '#1e2633',
  editBorder: '#3b82f6',
  amber:      '#fbbf24',
  red:        '#f87171',
  blue:       '#60a5fa',
  green:      '#34d399',
  font:      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  monoFont:  'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/** Live palette — mutated in place by `configureGridColors`. Read `.x` properties. */
export const GRID_COLORS: GridColors = { ...NEUTRAL };

export const GRID_THEME_CHANGE_EVENT = 'papercusp:grid-theme-changed';

let gridThemeVersion = 0;
const gridThemeListeners = new Set<() => void>();

export function getGridThemeVersion(): number {
  return gridThemeVersion;
}

export function subscribeGridTheme(listener: () => void): () => void {
  gridThemeListeners.add(listener);
  return () => {
    gridThemeListeners.delete(listener);
  };
}

function notifyGridThemeChange(): void {
  gridThemeVersion += 1;
  for (const listener of Array.from(gridThemeListeners)) listener();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(GRID_THEME_CHANGE_EVENT));
  }
}

// ─── Derived style builders ──────────────────────────────────────────────────

const buildGlideTheme = (): Partial<Theme> => ({
  bgCell:           GRID_COLORS.bg,
  bgCellMedium:     GRID_COLORS.rowAlt,
  bgHeader:         GRID_COLORS.headerBg,
  bgHeaderHasFocus: GRID_COLORS.rowHover,
  bgHeaderHovered:  GRID_COLORS.rowHover,
  textHeader:       GRID_COLORS.muted,
  textDark:         GRID_COLORS.text,
  textMedium:       GRID_COLORS.muted,
  textLight:        GRID_COLORS.muted,
  textBubble:       GRID_COLORS.text,
  borderColor:      GRID_COLORS.border,
  drilldownBorder:  GRID_COLORS.border,
  linkColor:        GRID_COLORS.blue,
  cellHorizontalPadding: 14,
  fontFamily:       GRID_COLORS.font,
  baseFontStyle:    '13px',
  headerFontStyle:  '600 11px',
});

const buildEditInput = (): React.CSSProperties => ({
  width: '100%',
  height: '100%',
  background: GRID_COLORS.editBg,
  border: `1px solid ${GRID_COLORS.editBorder}55`,
  borderRadius: 8,
  color: GRID_COLORS.text,
  fontFamily: GRID_COLORS.font,
  fontSize: 13,
  fontWeight: 500,
  padding: '5px 12px',
  textAlign: 'center' as const,
  outline: 'none',
  boxSizing: 'border-box' as const,
  fontVariantNumeric: 'tabular-nums',
  transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
});

const buildStepperBtn = (): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: 'none',
  background: 'transparent',
  color: GRID_COLORS.text,
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
  fontFamily: GRID_COLORS.font,
  transition: 'background 0.12s',
});

const buildTdBase = (): React.CSSProperties => ({
  padding: '10px 14px',
  borderBottom: `1px solid ${GRID_COLORS.border}`,
  fontFamily: GRID_COLORS.font,
  fontSize: 13,
  color: GRID_COLORS.text,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 0,
  fontVariantNumeric: 'tabular-nums',
});

const buildThBase = (): React.CSSProperties => ({
  ...buildTdBase(),
  background: GRID_COLORS.headerBg,
  color: GRID_COLORS.muted,
  fontWeight: 600,
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
  paddingTop: 12,
  paddingBottom: 12,
  position: 'sticky',
  top: 0,
  zIndex: 2,
  userSelect: 'none',
  borderBottom: `1px solid ${GRID_COLORS.border}`,
});

const buildTableWrapper = (): React.CSSProperties => ({
  overflowX: 'auto',
  borderRadius: 8,
  border: `1px solid ${GRID_COLORS.border}`,
});

const buildGridPanel = (): React.CSSProperties => ({
  flex: 1,
  minHeight: 0,
  borderRadius: 10,
  overflow: 'hidden',
  border: `1px solid ${GRID_COLORS.border}`,
});

const buildTableStyle = (): React.CSSProperties => ({
  width: '100%',
  borderCollapse: 'collapse',
  fontFamily: GRID_COLORS.font,
  fontSize: 13,
});

const buildCheckbox = (): React.CSSProperties => ({
  width: 16,
  height: 16,
  accentColor: GRID_COLORS.green,
});

const buildStepperInput = (): React.CSSProperties => ({
  width: 44,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  textAlign: 'center' as const,
  fontFamily: GRID_COLORS.font,
  fontSize: 13,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums',
});

const buildExpandBtn = (): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  border: 'none',
  background: 'transparent',
  color: GRID_COLORS.muted,
  fontSize: 12,
  cursor: 'pointer',
  borderRadius: 4,
  transition: 'color 0.12s, background 0.12s',
});

const buildSubRow = (): React.CSSProperties => ({
  background: GRID_COLORS.headerBg,
  borderLeft: `3px solid ${GRID_COLORS.editBorder}`,
  padding: '12px 16px',
});

// ─── Live derived style bindings (rebuilt on configureGridColors) ─────────────

/** Drop-in theme for Glide DataEditor — matches the HTML-table look. */
export let glideTheme: Partial<Theme> = buildGlideTheme();
/** Styled text input for editable overlay cells. */
export let EDIT_INPUT_STYLE: React.CSSProperties = buildEditInput();
/** − / + circular button in the quantity stepper. */
export let STEPPER_BTN_STYLE: React.CSSProperties = buildStepperBtn();
/** Base <td> style — spread and override per-cell. */
export let TD_BASE: React.CSSProperties = buildTdBase();
/** Base <th> style — sticky header row. */
export let TH_BASE: React.CSSProperties = buildThBase();
/** Outer wrapper div — rounded border container for <table>. */
export let TABLE_WRAPPER_STYLE: React.CSSProperties = buildTableWrapper();
/** Full-page rounded border container wrapping a canvas or HTML grid. */
export let GRID_PANEL_STYLE: React.CSSProperties = buildGridPanel();
/** <table> element base style. */
export let TABLE_STYLE: React.CSSProperties = buildTableStyle();
/** Checkbox style for boolean columns. */
export let CHECKBOX_STYLE: React.CSSProperties = buildCheckbox();
/** Stepper inner <input>. */
export let STEPPER_INPUT_STYLE: React.CSSProperties = buildStepperInput();
/** Expand/collapse chevron button in expandable rows. */
export let EXPAND_BTN_STYLE: React.CSSProperties = buildExpandBtn();
/** Container for expanded sub-row content. */
export let SUB_ROW_STYLE: React.CSSProperties = buildSubRow();

/**
 * Inject host colours (e.g. from design tokens). Mutates the live palette and
 * rebuilds the derived style bindings — every importer sees the change.
 */
export function configureGridColors(colors: Partial<GridColors>): void {
  Object.assign(GRID_COLORS, colors);
  glideTheme = buildGlideTheme();
  EDIT_INPUT_STYLE = buildEditInput();
  STEPPER_BTN_STYLE = buildStepperBtn();
  TD_BASE = buildTdBase();
  TH_BASE = buildThBase();
  TABLE_WRAPPER_STYLE = buildTableWrapper();
  GRID_PANEL_STYLE = buildGridPanel();
  TABLE_STYLE = buildTableStyle();
  CHECKBOX_STYLE = buildCheckbox();
  STEPPER_INPUT_STYLE = buildStepperInput();
  EXPAND_BTN_STYLE = buildExpandBtn();
  SUB_ROW_STYLE = buildSubRow();
  notifyGridThemeChange();
}

// ─── Colour-independent constants ────────────────────────────────────────────

/** Pill container that wraps − input + in the qty stepper. */
export const STEPPER_PILL_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 9999,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.04)',
  padding: 3,
  gap: 0,
};

/** CSS to inject once per page — hides browser spin-button and hover states. */
export const STEPPER_GLOBAL_CSS = `
  .gdg-stepper-input::-webkit-outer-spin-button,
  .gdg-stepper-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .gdg-stepper-input { -moz-appearance: textfield; }
  .gdg-stepper-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08) !important; }
  .gdg-stepper-btn:disabled { opacity: 0.35 !important; cursor: not-allowed !important; }
`;

/** Badge style factory — colored pill for status/enum values. */
export function badgeStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '3px 10px',
    borderRadius: 999,
    background: color + '1f',
    border: `1px solid ${color}55`,
    color,
    fontWeight: 600,
    fontSize: 10.5,
    letterSpacing: '0.04em',
    lineHeight: 1.2,
  };
}

/** Row-alternation background for the given index. */
export function rowBg(i: number): string {
  return i % 2 === 0 ? GRID_COLORS.bg : GRID_COLORS.rowAlt;
}

/** Generate scoped stepper CSS for a class prefix (default: 'gdg-stepper'). */
export function stepperCSS(prefix = 'gdg-stepper'): string {
  return STEPPER_GLOBAL_CSS.replace(/gdg-stepper/g, prefix);
}
