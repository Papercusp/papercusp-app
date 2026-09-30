/**
 * recall-health.ts — the one-line "Recall health" verdict for Settings →
 * Memory (EI-10368), derived from the latest live recall-canary run the
 * /user/memory/backend envelope carries.
 *
 * The canary (EI-10047) replays known-item queries against the LIVE store
 * daily, read-only — it catches the class where search silently returns
 * garbage while every suite stays green (schema drift, embedder misconfig).
 * Its alert leg is a transient push on the ok→degraded edge only; this line
 * is the persistent surface. Pure module (not in page.tsx) so the status →
 * copy mapping is directly testable.
 */

/** The slice of a canary run the health line needs (envelope `recallCanary.latest`). */
export interface RecallCanaryLatest {
  ranAt: string;
  status: 'ok' | 'degraded' | 'decayed' | 'seeded';
  rAt10: number | null;
  baselineRAt10: number | null;
}

export type RecallHealthTone = 'good' | 'warn' | 'mute';

export interface RecallHealthLine {
  tone: RecallHealthTone;
  text: string;
}

function fmt(n: number | null): string {
  return n == null ? 'n/a' : n.toFixed(2);
}

/** "checked 3h ago" — day granularity past 48h; the canary is daily, minutes are noise. */
export function checkedAgo(ranAt: string, now = Date.now()): string {
  const ms = now - new Date(ranAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just checked';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'checked <1h ago';
  if (h < 48) return `checked ${h}h ago`;
  return `checked ${Math.floor(h / 24)}d ago`;
}

/**
 * Map the latest canary run (or its absence) to the line the page renders.
 * `null` = the canary has never run / its storage is unreachable — shown
 * muted, never as an error: absence of a health check is not ill health.
 */
export function recallHealthLine(
  latest: RecallCanaryLatest | null,
  now = Date.now(),
): RecallHealthLine {
  if (!latest) {
    return { tone: 'mute', text: "Recall health: the daily recall canary hasn't run yet." };
  }
  const ago = checkedAgo(latest.ranAt, now);
  switch (latest.status) {
    case 'ok':
      return {
        tone: 'good',
        text: `✓ Recall health: ok — r@10 ${fmt(latest.rAt10)} (baseline ${fmt(latest.baselineRAt10)}), ${ago}`,
      };
    case 'degraded':
      return {
        tone: 'warn',
        text: `⚠ Recall health: degraded — r@10 ${fmt(latest.rAt10)} vs baseline ${fmt(latest.baselineRAt10)}, ${ago}. Memory search may be silently under-recalling.`,
      };
    case 'decayed':
      return {
        tone: 'mute',
        text: `Recall health: the canary's target memories were since deleted — it will re-seed on the next daily run (${ago}).`,
      };
    case 'seeded':
      return {
        tone: 'mute',
        text: `Recall health: baseline captured — the first live comparison runs on the next daily check (${ago}).`,
      };
  }
}
