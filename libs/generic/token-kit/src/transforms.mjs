// Generic SD transforms (culori-backed). Brand-neutral — shared across projects.
//   tokenkit/name   — kebab var names, dropping the leading `color.` segment
//   tokenkit/srgb   — any color → hex, or rgba() when alpha < 1   (web + grid)
//   tokenkit/oklch  — any color → oklch(L C H [/ a])               (shop @theme)
import { parse, formatHex, converter } from 'culori';

const toOklch = converter('oklch');
const v = (t) => t.$value ?? t.value;

function srgbString(value) {
  const c = parse(value);
  if (!c) return value;
  if (c.alpha != null && c.alpha < 1) {
    const r = Math.round((c.r ?? 0) * 255);
    const g = Math.round((c.g ?? 0) * 255);
    const b = Math.round((c.b ?? 0) * 255);
    return `rgba(${r}, ${g}, ${b}, ${+c.alpha.toFixed(4)})`;
  }
  return formatHex(c);
}

function oklchString(value) {
  const c = parse(value);
  if (!c) return value;
  const o = toOklch(c);
  const L = +(o.l ?? 0).toFixed(4);
  const C = +(o.c ?? 0).toFixed(4);
  const H = o.h == null ? 0 : +o.h.toFixed(2);
  return c.alpha != null && c.alpha < 1
    ? `oklch(${L} ${C} ${H} / ${+c.alpha.toFixed(4)})`
    : `oklch(${L} ${C} ${H})`;
}

export const transforms = [
  {
    name: 'tokenkit/name',
    type: 'name',
    // Drop a leading `color.` (primitives) or `shop.` (per-surface) segment.
    transform: (t) =>
      (t.path[0] === 'color' || t.path[0] === 'shop' ? t.path.slice(1) : t.path).join('-').toLowerCase(),
  },
  {
    name: 'tokenkit/srgb',
    type: 'value',
    transitive: false,
    filter: (t) => t.$type === 'color',
    transform: (t) => srgbString(v(t)),
  },
  {
    name: 'tokenkit/oklch',
    type: 'value',
    transitive: false,
    filter: (t) => t.$type === 'color',
    transform: (t) => oklchString(v(t)),
  },
];
