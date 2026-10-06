/**
 * desktop-names.ts — names and lease keys for agent-owned desktops
 * (agent-multi-desktops-grid-2026-10-06 P-002; D-003, D-012).
 *
 * An agent may own many desktops, so each one carries an agent-chosen `name`, unique
 * per live (workspace, agent). The in-process lease map is keyed by a SCOPE KEY rather
 * than by the registry session id because the registry row is best-effort and a live
 * lease may legitimately have no id yet (D-012).
 *
 * Pure: no I/O, so the naming rules unit-test without a desktop or a database.
 */

/** Mirrors `desktop_sessions_name_format_ck` (migration 1386) — keep the two identical. */
export const DESKTOP_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function isValidDesktopName(name: string): boolean {
  return DESKTOP_NAME_PATTERN.test(name);
}

/** Lease key for a pot's shared desktop (the legacy one-per-pot lease). */
export function potLeaseKey(potSlug: string): string {
  return `pot:${potSlug}`;
}

/** Lease key for one of an agent's own desktops. */
export function agentLeaseKey(ownerId: string, name: string): string {
  return `agent:${ownerId}:${name}`;
}

/**
 * The first free `desktop-<n>` (n ≥ 1) not in `taken`. Reuses a released number
 * rather than counting forever, so an agent that cycles desktops keeps short names.
 */
export function nextDefaultDesktopName(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `desktop-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
