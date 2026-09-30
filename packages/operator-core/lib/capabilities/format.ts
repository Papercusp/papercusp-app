/**
 * Tiny presentation helpers shared by the capability adapters.
 */

/**
 * Humanize a capability/command id for display, **group-qualified** so a bare
 * verb is self-describing in a flat palette list:
 *   `'goals:list'`              → `'Goals: List'`
 *   `'papercusp:list_workspaces'` → `'Papercusp: List Workspaces'`
 *   `'panel.toggle'`            → `'Panel: Toggle'`
 *   `'list_workspaces'`         → `'List Workspaces'` (no namespace)
 *
 * Why qualify: many tools share a generic verb (`list`/`get`/`status`), so the
 * last-segment-only form rendered five different `*:list` tools as an
 * indistinguishable "List". Carrying the group keeps each row unambiguous on its
 * own (VS Code's "Git: Commit" convention).
 */
export function humanizeCapabilityId(id: string): string {
  const sep = id.includes(':') ? ':' : id.includes('.') ? '.' : '';
  if (!sep) return titleCaseWords(id);
  const group = id.slice(0, id.indexOf(sep));
  const verb = id.slice(id.indexOf(sep) + 1);
  const g = titleCaseWords(group);
  const v = titleCaseWords(verb);
  return g && v ? `${g}: ${v}` : v || g;
}

function titleCaseWords(s: string): string {
  return s
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Clamp a (possibly long, model-facing) description to a palette-subtitle length. */
export function shorten(text: string | undefined, max = 90): string {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}
