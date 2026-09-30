/**
 * Shared OMP delivery seam for model-facing advisory context.
 *
 * `pi.sendMessage()` is an interrupt, regardless of whether it is labelled
 * steer or followUp: a queued message can discard an in-flight tool batch.
 * Advisory context therefore waits here and rides in on the next tool result,
 * an artifact the model was already going to read.
 *
 * The stash is keyed so independent producers (memory recall, coordination,
 * status tips) cannot overwrite one another. A producer replaces only its own
 * older value; the whole stash remains bounded by the number of declared keys.
 */

interface PendingAdvisory {
  text: string;
  at: number;
}

const pending = new Map<string, PendingAdvisory>();

/** Advisory context is perishable; never replay it into a much later turn. */
export const PENDING_MAX_AGE_MS = 5 * 60_000;

export function stashAdvisory(key: string, text: string, now: number = Date.now()): void {
  if (text.length === 0) return;
  pending.set(key, { text, at: now });
}

/** Take every fresh advisory atomically. Each block is delivered at most once. */
export function takeAdvisories(now: number = Date.now()): string | null {
  const entries = [...pending.values()];
  pending.clear();
  const fresh = entries.filter((entry) => now - entry.at <= PENDING_MAX_AGE_MS);
  return fresh.length > 0 ? fresh.map((entry) => entry.text).join('\n\n') : null;
}

/** Test seam: reset process-local state between cases. */
export function clearAdvisoryStash(): void {
  pending.clear();
}

/** Preserve the original tool output while appending model-facing context. */
export function appendAdvisories(content: unknown, text: string): unknown {
  if (typeof content === 'string') return `${content}\n\n${text}`;
  if (Array.isArray(content)) return [...content, { type: 'text', text }];
  return [{ type: 'text', text }];
}
