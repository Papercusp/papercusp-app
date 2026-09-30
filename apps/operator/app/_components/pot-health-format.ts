/**
 * pot-health-format — tiny pure formatting helpers for the Pot Health surfaces
 * (PotHealthPane). Extracted from the retired PotStatusStrip (WI-4789: the
 * ambient strip under the header was removed once the 🫖 Pot Health toggle
 * moved beside the Papercup identity) so the helpers outlive the component
 * that first grew them.
 */

/** Compact "2m / 40s / 3h" age from an ISO timestamp or epoch ms; null-safe. */
export function compactAge(from: string | number | null | undefined, now = Date.now()): string {
  if (from == null) return '—';
  const t = typeof from === 'number' ? from : Date.parse(from);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Display-cap a badge count: 1..99 verbatim, above that "99+" (WI-4724 — the
 *  raw aging-escalations count can reach the hundreds and blows out the badge).
 *  The HONEST full count stays in the surrounding aria-label / title. */
export function compactCount(n: number, cap = 99): string {
  return n > cap ? `${cap}+` : String(n);
}

/** Split a leading work-item id off a cup's `doing` line so it renders in
 *  accent mono ("WI-4662 fleet-spec …"). */
export function splitLeadingWi(doing: string): { wi: string | null; rest: string } {
  const m = doing.match(/^((?:WI|EI|F)-\d+)\s+(.*)$/);
  return m ? { wi: m[1]!, rest: m[2]! } : { wi: null, rest: doing };
}
