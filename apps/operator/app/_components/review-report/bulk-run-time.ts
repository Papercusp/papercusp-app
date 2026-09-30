/** Shared elapsed-label formatter for the Inbox and Plans bulk-run strips. */
export function formatRunElapsed(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : now;
  const secs = Math.max(
    0,
    Math.round(((Number.isNaN(end) ? now : end) - start) / 1000),
  );
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
