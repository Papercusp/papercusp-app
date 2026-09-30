/**
 * Parse a provider reset boundary expressed as a duration, epoch seconds,
 * epoch milliseconds, or an ISO timestamp.
 *
 * This is a leaf module on purpose. Both the physical-constraint adapter and
 * the codex recovery parser need the same OpenAI duration dialect, while those
 * two modules otherwise import each other. Keeping the parser here preserves
 * one implementation without introducing an import cycle.
 */
export function parseProviderReset(raw: string | undefined, nowMs: number): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  // Parse numeric forms before Date.parse. Date.parse accepts surprising
  // legacy spellings such as "10" (as a calendar date), which would turn a
  // ten-second retry into a timestamp years in the past.
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    if (n >= 100_000_000_000) return n; // epoch milliseconds
    if (n >= 1_000_000_000) return n * 1_000; // epoch seconds
    return nowMs + Math.max(0, n) * 1_000; // bare delay seconds
  }

  // OpenAI emits compact compound durations such as `6m0s` and sub-second
  // values such as `250ms`. Validate the WHOLE compact value before summing so
  // `250ms` cannot be partially interpreted as `250m`.
  const compact = value.replace(/\s+/g, '');
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/i.test(compact)) {
    let milliseconds = 0;
    for (const match of compact.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi)) {
      const amount = Number(match[1]);
      const unit = match[2]!.toLowerCase();
      if (!Number.isFinite(amount)) return undefined;
      milliseconds +=
        amount *
        (unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    }
    return Number.isFinite(milliseconds) ? nowMs + Math.max(0, milliseconds) : undefined;
  }

  const iso = Date.parse(value);
  return Number.isNaN(iso) ? undefined : iso;
}
