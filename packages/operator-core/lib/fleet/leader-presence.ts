/**
 * Session states in which a registered fleet LEADER still holds its seat.
 *
 * A leader spends most of its life `parked` between wakes (loop/event awaits);
 * `parked` is the liveness oracle's wakeable-between-turns verdict, not absence.
 * `draining` is an in-flight wind-down that must not be raced by succession.
 * Only `ended` (plus the callers' own handling of `recorded` and of incomplete
 * evidence) may vacate the seat.
 *
 * EI-24962274233684871: fleet:status and the member admission gate had each
 * narrowed this to `'live'` only, so every parked leader read as
 * `registered-leader-missing` and, after the grace window, became eligible for
 * forced succession. Both now share this one predicate.
 *
 * Kept as a dependency-free leaf so the lazily-imported fleet-roster module
 * does not become a static dependency of the admission gate.
 */
export function isLeaderPresentSessionState(state: string | null | undefined): boolean {
  return state === 'live' || state === 'parked' || state === 'draining';
}
