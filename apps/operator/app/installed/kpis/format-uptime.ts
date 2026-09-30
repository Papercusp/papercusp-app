/**
 * Formats a duration in seconds as a compact, human-readable uptime string,
 * e.g. `3d 4h 12m`, `4h 2m`, `45s`. Used by the "System uptime" card on the
 * Substrate KPIs dashboard (`/installed/kpis`).
 *
 * Shows the two most significant non-zero units (days+hours, hours+minutes,
 * or minutes+seconds) so the string stays short at any magnitude; falls back
 * to `0s` for a zero/negative input.
 */
export function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
