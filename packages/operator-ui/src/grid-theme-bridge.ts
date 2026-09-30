/**
 * The token → grid palette bridge, for EVERY host that mounts an operator grid.
 *
 * `@papercusp/grid-core` is brand-agnostic: `VirtualGrid` / `RichGrid` /
 * `DataGridShell` paint from the live `GRID_COLORS` object, which starts as a
 * neutral DARK palette until a host calls `configureGridColors()`. The canvas
 * cannot read CSS variables, so this module reads the operator's semantic
 * tokens (`--bg`, `--fg`, `--border`, …) off `:root` and pushes them in — and
 * re-pushes on every theme change so a live grid follows a runtime switch.
 *
 * WHY IT LIVES HERE AND NOT IN THE OPERATOR APP (portal-parity D-008, P-012):
 * it used to be `apps/operator-vite/src/grid-colors.ts`, imported only by the
 * operator's `main.tsx`. The cloud portal mounts the same grid-bearing surfaces
 * (Learning → Observations / Improvements / Retained, Work → the work-item
 * queue) natively, never runs that bootstrap, and so painted every grid in the
 * neutral dark palette on a light theme — measured on :3081 2026-09-05:
 * `[role=row]` bg rgb(14,14,14), border rgb(46,46,46) = grid-core's NEUTRAL
 * defaults. One bridge, imported by both hosts, is the fix; a second copy in
 * the portal would be the drift this package exists to prevent.
 *
 * Both hosts define the tokens this reads: the operator in its globals.css,
 * the portal in the `:root` adapter block of its globals.css (which maps the
 * app-family tokens onto the operator vocabulary). A token that is missing
 * falls back to the palette below rather than to an empty string.
 *
 * Import it for its side effect: `import '@papercusp/operator-ui/grid-theme-bridge'`.
 * Safe on a server: without `window`/`document` it installs the fallback and
 * registers nothing.
 */
import { configureGridColors, type GridColors } from '@papercusp/grid-core';

const FALLBACK: GridColors = {
  bg: '#070b12',
  headerBg: '#05080d',
  rowAlt: '#0c111b',
  rowHover: '#111827',
  border: 'rgba(120, 150, 190, 0.18)',
  text: '#e7ecf3',
  muted: '#8a96ad',
  editBg: '#101827',
  editBorder: '#7aa2f7',
  amber: '#facc15',
  red: '#f87171',
  blue: '#7aa2f7',
  green: '#34d399',
  font: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  monoFont: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/**
 * Read the current `:root` tokens and push them into grid-core. Exported so a
 * host (or a test) can force a re-read; the listeners below call it for you on
 * every theme transition this module can observe.
 */
export function applyGridColorsFromTokens(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    configureGridColors(FALLBACK);
    return;
  }

  const styles = window.getComputedStyle(document.documentElement);
  configureGridColors({
    bg: cssVar(styles, '--bg', FALLBACK.bg),
    headerBg: cssVar(styles, '--bg-deeper', FALLBACK.headerBg),
    rowAlt: cssVar(styles, '--bg-1', FALLBACK.rowAlt),
    rowHover: cssVar(styles, '--bg-3', FALLBACK.rowHover),
    border: cssVar(styles, '--border', FALLBACK.border),
    text: cssVar(styles, '--fg', FALLBACK.text),
    muted: cssVar(styles, '--fg-mute', FALLBACK.muted),
    editBg: cssVar(styles, '--bg-raised', FALLBACK.editBg),
    editBorder: cssVar(styles, '--accent-strong', FALLBACK.editBorder),
    amber: cssVar(styles, '--warn', FALLBACK.amber),
    red: cssVar(styles, '--bad', FALLBACK.red),
    blue: cssVar(styles, '--accent', FALLBACK.blue),
    green: cssVar(styles, '--good', FALLBACK.green),
    font: cssVar(styles, '--font-sans', FALLBACK.font),
    monoFont: cssVar(styles, '--font-mono', FALLBACK.monoFont),
  });
}

applyGridColorsFromTokens();

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let pending = false;
  const scheduleApply = () => {
    if (pending) return;
    pending = true;
    const run = () => {
      pending = false;
      applyGridColorsFromTokens();
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 0);
    }
  };

  // The operator's own theme bus.
  window.addEventListener('papercusp:theme-changed', scheduleApply);
  window.addEventListener('storage', (event) => {
    if (!event.key || event.key.includes('papercusp.theme')) scheduleApply();
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleApply, { once: true });
  }
  // Any host that themes by attribute (`data-theme` — the operator's named
  // themes and the portal's light/dark/system choice both live there).
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(scheduleApply).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
  }
  // A "system" preference flips with the OS and touches no attribute, so the
  // observer above cannot see it; the media query can.
  if (typeof window.matchMedia === 'function') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    dark.addEventListener?.('change', scheduleApply);
  }
  scheduleApply();
}
