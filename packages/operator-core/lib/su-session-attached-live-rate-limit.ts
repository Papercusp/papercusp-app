import type { SuSessionEvent } from '@papercusp/chat-protocol';

const CONFIRMED_PROVIDER_RATE_LIMIT_RE =
  /(\b429\b|rate.?limit|too many requests|slow down|temporarily limiting|weekly limit)/i;

function systemTranscriptMatches(events: readonly SuSessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'transcript' &&
    event.phase === 'delta' &&
    event.role === 'system' &&
    event.content &&
    CONFIRMED_PROVIDER_RATE_LIMIT_RE.test(event.content)
      ? [event.content]
      : [],
  );
}

/** Distinguish provider-capacity evidence from an attached-engine regression. */
export function confirmedProviderRateLimit(
  events: readonly SuSessionEvent[],
): { confirmed: boolean; signals: string[] } {
  const structured = events.flatMap((event) =>
    event.type === 'error' && CONFIRMED_PROVIDER_RATE_LIMIT_RE.test(event.message) ? [event.message] : [],
  );
  const prose = systemTranscriptMatches(events);
  return { confirmed: structured.length > 0 || prose.length >= 2, signals: [...structured, ...prose] };
}
